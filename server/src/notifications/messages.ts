import type {
  GuardianLanguage,
  NotificationJobDoc,
  NotifyChannel,
  ParentDoc,
  ParentStudentLinkDoc,
  StudentDoc,
  TenantContext,
} from '../db.js'
import { withoutTenant } from '../db.js'
import { render, type TemplateKind, type TemplateText, type Tokens } from './templates.js'
import { loadTemplate } from './templates.js'
import { processQueue } from './queue.js'

/**
 * SAMS 6.1: the general delivery service. Every notice to a family goes
 * through `notifyFamilies`, which works out the recipients from the
 * students' active parent links and then, per parent:
 *
 *  - in-app: an inbox item, when the parent has a portal login and the
 *    link grants portal access to that student;
 *  - email / SMS: a queued job (queue.ts drains it, with retries and a
 *    failure log), when the link's communication permissions allow it and
 *    the parent has an address.
 *
 * Everything is written inside the caller's transaction and keyed
 * deterministically, so running the same notice twice sends nothing new.
 */

const MAX_ATTEMPTS = Number(process.env.NOTIFY_MAX_ATTEMPTS ?? 3)

export interface Delivered {
  families: number
  inApp: number
  email: number
  sms: number
}

const none = (): Delivered => ({ families: 0, inApp: 0, email: 0, sms: 0 })

export interface FamilyNotice {
  kind: TemplateKind
  /** The record it is about; with `dedupe`, what makes it unique. */
  sourceId: string
  /** Extra uniqueness, e.g. the day for a reminder that may repeat. */
  dedupe?: string
  studentIds: string[]
  /** `financial`: parents responsible for fees (or, if none is marked, the
   * primary contact). `all`: every active link. */
  recipients: 'financial' | 'all'
  /** Email/SMS to send besides in-app; defaults to both. */
  channels?: NotifyChannel[]
  /** One message per parent (announcements), not one per child. */
  perParent?: boolean
  /** Replaces the kind's saved template (an announcement's own text). */
  text?: TemplateText
  tokens: (student: StudentDoc, parent: ParentDoc) => Tokens
  /** Where the portal item opens. */
  link?: (studentId: string) => string | null
  trigger: 'auto' | 'manual'
  actorId: string | null
}

export async function schoolName(tenantId: string): Promise<string> {
  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
  return tenant?.name ?? ''
}

/** The parents a notice goes to, per student. */
async function recipientsFor(
  ctx: TenantContext,
  studentIds: string[],
  mode: 'financial' | 'all',
): Promise<Map<string, { link: ParentStudentLinkDoc; parent: ParentDoc }[]>> {
  const links = await ctx.parentStudentLinks.find({ studentId: { $in: studentIds }, active: true }).toArray()
  const parents = await ctx.parents
    .find({ _id: { $in: [...new Set(links.map((l) => l.parentId))] }, status: 'active' })
    .toArray()
  const parentById = new Map(parents.map((p) => [p._id, p]))
  const out = new Map<string, { link: ParentStudentLinkDoc; parent: ParentDoc }[]>()
  for (const studentId of studentIds) {
    const mine = links
      .filter((l) => l.studentId === studentId && parentById.has(l.parentId))
      .map((link) => ({ link, parent: parentById.get(link.parentId)! }))
    let chosen = mine
    if (mode === 'financial') {
      const responsible = mine.filter((r) => r.link.financialResponsibility)
      chosen = responsible.length ? responsible : mine.filter((r) => r.link.primaryContact)
    }
    out.set(studentId, chosen)
  }
  return out
}

function job(
  fields: {
    branchId: string
    studentId: string
    recipientId: string
    recipientName: string
    channel: NotifyChannel
    to: string
    language: GuardianLanguage
    subject: string
    body: string
    kind: TemplateKind
    sourceId: string
    trigger: 'auto' | 'manual'
    actorId: string | null
  },
): Omit<NotificationJobDoc, '_id' | 'tenantId'> {
  const now = new Date()
  return {
    branchId: fields.branchId,
    studentId: fields.studentId,
    guardianId: fields.recipientId,
    date: now.toISOString().slice(0, 10),
    channel: fields.channel,
    to: fields.to,
    guardianName: fields.recipientName,
    language: fields.language,
    subject: fields.subject,
    body: fields.body,
    status: 'pending',
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    nextAttemptAt: now,
    lastError: null,
    providerMessageId: null,
    trigger: fields.trigger,
    actorId: fields.actorId,
    kind: fields.kind,
    sourceId: fields.sourceId,
    createdAt: now,
    updatedAt: now,
  }
}

/** Queues one email/SMS unless the same key is already queued. True when new. */
async function queue(
  ctx: TenantContext,
  id: string,
  doc: Omit<NotificationJobDoc, '_id' | 'tenantId'>,
): Promise<boolean> {
  const before = await ctx.notificationJobs.findOneAndUpdate(
    { _id: id },
    { $setOnInsert: doc },
    { upsert: true, returnDocument: 'before' },
  )
  return !before
}

/** Adds an inbox item unless it is already there. True when new. */
export async function notifyUser(
  ctx: TenantContext,
  tenantId: string,
  item: { userId: string; kind: TemplateKind; sourceId: string; title: string; body: string; link: string | null },
): Promise<boolean> {
  const before = await ctx.inboxItems.findOneAndUpdate(
    { _id: `${tenantId}:${item.userId}:${item.kind}:${item.sourceId}` },
    {
      $setOnInsert: {
        userId: item.userId,
        kind: item.kind,
        sourceId: item.sourceId,
        title: item.title,
        body: item.body,
        link: item.link,
        createdAt: new Date(),
        readAt: null,
      },
    },
    { upsert: true, returnDocument: 'before' },
  )
  return !before
}

export async function notifyFamilies(ctx: TenantContext, tenantId: string, notice: FamilyNotice): Promise<Delivered> {
  const out = none()
  if (notice.studentIds.length === 0) return out
  const text = notice.text ?? (await loadTemplate(ctx, tenantId, notice.kind))
  if (!text.enabled) return out

  const students = await ctx.students.find({ _id: { $in: notice.studentIds } }).toArray()
  const byStudent = await recipientsFor(ctx, notice.studentIds, notice.recipients)
  const channels = notice.channels ?? ['email', 'sms']
  const key = notice.dedupe ? `${notice.sourceId}:${notice.dedupe}` : notice.sourceId
  const families = new Set<string>()
  const doneParent = new Set<string>()

  for (const student of students) {
    for (const { link, parent } of byStudent.get(student._id) ?? []) {
      if (notice.perParent && doneParent.has(parent._id)) continue
      doneParent.add(parent._id)
      const language: GuardianLanguage = parent.preferredLanguage ?? 'en'
      const tokens = notice.tokens(student, parent)
      const suffix = notice.perParent ? parent._id : `${student._id}:${parent._id}`
      let reached = false

      if (parent.portalAccess?.enabled && parent.portalAccess.userId && link.portalAccess) {
        const msg = render(text, 'in_app', language, tokens)
        const added = await notifyUser(ctx, tenantId, {
          userId: parent.portalAccess.userId,
          kind: notice.kind,
          sourceId: notice.perParent ? key : `${key}:${student._id}`,
          title: msg.subject,
          body: msg.body,
          link: notice.link?.(student._id) ?? null,
        })
        if (added) out.inApp++
        reached = true
      }

      for (const channel of channels) {
        if (!link.communicationPermissions[channel]) continue
        const to = channel === 'email' ? (parent.email ?? '') : (parent.primaryPhone ?? '')
        if (!to) continue
        const msg = render(text, channel, language, tokens)
        const added = await queue(
          ctx,
          `${tenantId}:${notice.kind}:${key}:${channel}:${suffix}`,
          job({
            branchId: student.branchId,
            studentId: student._id,
            recipientId: parent._id,
            recipientName: parent.fullName,
            channel,
            to,
            language,
            subject: msg.subject,
            body: msg.body,
            kind: notice.kind,
            sourceId: notice.sourceId,
            trigger: notice.trigger,
            actorId: notice.actorId,
          }),
        )
        if (added) out[channel]++
        reached = true
      }
      if (reached) families.add(parent._id)
    }
  }
  out.families = families.size
  return out
}

/** A notice to someone who isn't a parent on file yet (an applicant's
 * guardian): email if there is an address, else SMS. */
export async function notifyContact(
  ctx: TenantContext,
  tenantId: string,
  contact: {
    kind: TemplateKind
    sourceId: string
    branchId: string
    recipientId: string
    name: string
    email: string | null
    phone: string | null
    language: GuardianLanguage
    tokens: Tokens
    actorId: string | null
  },
): Promise<Delivered> {
  const out = none()
  const text = await loadTemplate(ctx, tenantId, contact.kind)
  if (!text.enabled) return out
  const channel: NotifyChannel | null = contact.email ? 'email' : contact.phone ? 'sms' : null
  if (!channel) return out
  const msg = render(text, channel, contact.language, contact.tokens)
  const added = await queue(
    ctx,
    `${tenantId}:${contact.kind}:${contact.sourceId}:${channel}:${contact.recipientId}`,
    job({
      branchId: contact.branchId,
      studentId: '',
      recipientId: contact.recipientId,
      recipientName: contact.name,
      channel,
      to: (channel === 'email' ? contact.email : contact.phone)!,
      language: contact.language,
      subject: msg.subject,
      body: msg.body,
      kind: contact.kind,
      sourceId: contact.sourceId,
      trigger: 'manual',
      actorId: contact.actorId,
    }),
  )
  if (added) {
    out[channel]++
    out.families = 1
  }
  return out
}

/** An email to a staff member (SAMS 7.4, a scheduled report is ready),
 * through the same queue as family notices. True when newly queued. */
export async function emailStaff(
  ctx: TenantContext,
  tenantId: string,
  mail: {
    kind: TemplateKind
    sourceId: string
    branchId: string
    userId: string
    name: string
    email: string
    language: GuardianLanguage
    subject: string
    body: string
  },
): Promise<boolean> {
  return queue(
    ctx,
    `${tenantId}:${mail.kind}:${mail.sourceId}:email:${mail.userId}`,
    job({
      branchId: mail.branchId,
      studentId: '',
      recipientId: mail.userId,
      recipientName: mail.name,
      channel: 'email',
      to: mail.email,
      language: mail.language,
      subject: mail.subject,
      body: mail.body,
      kind: mail.kind,
      sourceId: mail.sourceId,
      trigger: 'auto',
      actorId: null,
    }),
  )
}

/** After a request that queued messages commits: try sending straight
 * away. Never awaited by the request, and the scheduled worker picks up
 * whatever this leaves. */
export function nudgeQueue(): void {
  void processQueue().catch((error) => console.error('notification queue nudge failed', error))
}
