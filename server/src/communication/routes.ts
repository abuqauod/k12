import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { AnnouncementDoc, InboxItemDoc, MessageKind, NotificationJobDoc } from '../db.js'
import { MESSAGE_KINDS } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerCanUseBranch,
  loadCallerMembership,
  requireActiveSubscription,
} from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { Abort, branchFilter, isFailure, scoped, sendFailure, todayIso, transact } from '../records.js'
import { DEFAULT_TEMPLATES, TEMPLATE_KINDS, TEMPLATE_TOKENS, fromDoc, type TemplateKind } from '../notifications/templates.js'
import { nudgeQueue, schoolName } from '../notifications/messages.js'
import { deliver, deliveryErrorCode } from '../notifications/channels.js'
import { emailStatus } from '../email.js'
import { smsStatus } from '../notifications/sms.js'
import { audienceError, audienceStudents, deliverAnnouncement } from './announcements.js'
import { dueReminders, sendReminders } from './reminders.js'
import { documentsExpiring } from './notices.js'
import { effectiveCommunication, loadCommunication } from './settings.js'

/**
 * SAMS Phase 6 (staff side): announcements, message templates, the
 * automatic-notice settings, fee reminders, the delivery log with retry,
 * and everyone's own inbox.
 */

const channels = z.array(z.enum(['email', 'sms'])).max(2).default([])
const audience = z.object({
  type: z.enum(['school', 'branch', 'grade', 'class', 'bus']),
  branchId: z.string().min(1).nullable().default(null),
  gradeLevels: z.array(z.string().min(1).max(60)).max(30).default([]),
  classIds: z.array(z.string().min(1)).max(100).default([]),
  busIds: z.array(z.string().min(1)).max(100).default([]),
})
const announcementBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  titleAr: z.string().trim().max(200).nullable().default(null),
  bodyAr: z.string().trim().max(8000).nullable().default(null),
  audience,
  channels,
})
const announcementPatch = announcementBody.partial()

const templateBody = z.object({
  enabled: z.boolean(),
  subject: z.string().max(300),
  body: z.string().max(8000),
  smsBody: z.string().max(1000),
  subjectAr: z.string().max(300),
  bodyAr: z.string().max(8000),
  smsBodyAr: z.string().max(1000),
})

const settingsBody = z.object({
  feeReminders: z
    .object({
      auto: z.boolean(),
      daysBefore: z.number().int().min(0).max(60),
      repeatDays: z.number().int().min(1).max(90),
    })
    .optional(),
  documentExpiry: z.object({ auto: z.boolean(), daysBefore: z.number().int().min(1).max(180) }).optional(),
  libraryOverdue: z.object({ auto: z.boolean(), repeatDays: z.number().int().min(1).max(60) }).optional(),
  portalDocumentCategories: z.array(z.string().min(1).max(64)).max(50).optional(),
})

const reminderQuery = z.object({
  branchId: z.string().optional(),
  daysBefore: z.coerce.number().int().min(0).max(60).optional(),
})
const reminderSend = z.object({
  branchId: z.string().optional(),
  daysBefore: z.number().int().min(0).max(60).optional(),
  invoiceIds: z.array(z.string().min(1)).max(500).optional(),
})

const logQuery = z.object({
  kind: z.enum(MESSAGE_KINDS).optional(),
  status: z.enum(['pending', 'processing', 'sent', 'failed', 'dead', 'skipped']).optional(),
  branchId: z.string().optional(),
  sourceId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

const testSendBody = z.object({
  channel: z.enum(['email', 'sms']),
  to: z.string().trim().min(3).max(200),
})

const bulkRetryBody = z.object({
  kind: z.enum(MESSAGE_KINDS).optional(),
  /** Only jobs that failed with this reason (e.g. EMAIL_NOT_CONFIGURED). */
  error: z.string().max(200).optional(),
})

function announcementResponse(a: AnnouncementDoc) {
  return {
    id: a._id,
    title: a.title,
    body: a.body,
    titleAr: a.titleAr,
    bodyAr: a.bodyAr,
    audience: a.audience,
    channels: a.channels,
    status: a.status,
    students: a.studentIds.length,
    sent: a.sent,
    publishedAt: a.publishedAt?.toISOString() ?? null,
    publishedBy: a.publishedBy,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }
}

function inboxResponse(i: InboxItemDoc) {
  return {
    id: i._id,
    kind: i.kind,
    title: i.title,
    body: i.body,
    link: i.link,
    createdAt: i.createdAt.toISOString(),
    readAt: i.readAt?.toISOString() ?? null,
  }
}

function jobResponse(j: NotificationJobDoc) {
  return {
    id: j._id,
    kind: (j.kind ?? 'absence') as MessageKind,
    sourceId: j.sourceId ?? null,
    branchId: j.branchId,
    studentId: j.studentId || null,
    recipientId: j.guardianId,
    recipientName: j.guardianName,
    channel: j.channel,
    to: j.to,
    subject: j.subject,
    status: j.status,
    attempts: j.attempts,
    error: j.lastError,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  }
}

export function registerCommunicationRoutes(app: FastifyInstance): void {
  /** A member of the school, whatever their role: a removed member or a
   * parent whose portal was switched off can't read it any more. */
  const member = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await loadCallerMembership(request))) await reply.code(403).send({ error: 'FORBIDDEN' })
  }
  const signedIn = { preHandler: [authenticate, requireActiveSubscription, member] }

  // ----------------------------------------------------------- inbox --
  // Everyone's own: staff and portal parents alike, no scope needed.

  app.get('/inbox', signedIn, async (request, reply) => {
    const auth = request.auth!
    if (!auth.tenantId) return reply.code(400).send({ error: 'NO_TENANT_CONTEXT' })
    const { unread } = (request.query ?? {}) as { unread?: string }
    const filter: Filter<InboxItemDoc> = { userId: auth.sub }
    if (unread === 'true') filter.readAt = null
    const { items, unreadCount } = await withTenant(auth.tenantId, async (ctx) => ({
      items: await ctx.inboxItems.find(filter).sort({ createdAt: -1 }).limit(100).toArray(),
      unreadCount: await ctx.inboxItems.countDocuments({ userId: auth.sub, readAt: null }),
    }))
    return reply.send({ items: items.map(inboxResponse), unread: unreadCount })
  })

  app.post('/inbox/:id/read', signedIn, async (request, reply) => {
    const auth = request.auth!
    const { id } = request.params as { id: string }
    const found = await withTenant(auth.tenantId!, (ctx) =>
      ctx.inboxItems.findOneAndUpdate({ _id: id, userId: auth.sub }, { $set: { readAt: new Date() } }),
    )
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send({ ok: true })
  })

  app.post('/inbox/read-all', signedIn, async (request, reply) => {
    const auth = request.auth!
    const res = await withTenant(auth.tenantId!, (ctx) =>
      ctx.inboxItems.updateMany({ userId: auth.sub, readAt: null }, { $set: { readAt: new Date() } }),
    )
    return reply.send({ updated: res.modifiedCount })
  })

  // --------------------------------------------------- announcements --

  /** A school-wide announcement needs a tenant-wide caller; any other
   * needs its branch. */
  async function audienceAllowed(request: Parameters<typeof callerCanUseBranch>[0], a: AnnouncementDoc['audience']) {
    if (a.type === 'school') return (await callerBranchIds(request)) === null
    return a.branchId !== null && (await callerCanUseBranch(request, a.branchId))
  }

  app.get('/announcements', scoped('announcements.manage'), async (request, reply) => {
    const { status, branchId } = (request.query ?? {}) as { status?: string; branchId?: string }
    const branches = await branchFilter(request, branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<AnnouncementDoc> = {}
    if (status === 'draft' || status === 'published' || status === 'archived') filter.status = status
    if (branches.branchIds) {
      filter['audience.branchId'] = branchId ? { $in: branches.branchIds } : { $in: [...branches.branchIds, null] }
    }
    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.announcements.find(filter).sort({ createdAt: -1 }).limit(200).toArray(),
    )
    return reply.send({ announcements: rows.map(announcementResponse) })
  })

  app.get('/announcements/:id', scoped('announcements.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, async (ctx) => {
      const doc = await ctx.announcements.findOne({ _id: id })
      if (!doc) return null
      // A draft shows who it would reach today.
      const reach = doc.status === 'draft' ? (await audienceStudents(ctx, doc.audience)).length : doc.studentIds.length
      return { doc, reach }
    })
    if (!result || !(await audienceAllowed(request, result.doc.audience))) {
      return reply.code(404).send({ error: 'NOT_FOUND' })
    }
    return reply.send({ ...announcementResponse(result.doc), reach: result.reach })
  })

  app.post('/announcements', scoped('announcements.manage'), async (request, reply) => {
    const parsed = announcementBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const body = parsed.data
    if (body.audience.type === 'school') body.audience.branchId = null
    if (!(await audienceAllowed(request, body.audience))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const result = await transact(tenantId, async (ctx) => {
      const problem = await audienceError(ctx, body.audience)
      if (problem) throw new Abort(problem)
      const now = new Date()
      const doc: AnnouncementDoc = {
        _id: randomUUID(),
        tenantId,
        ...body,
        status: 'draft',
        studentIds: [],
        sent: null,
        publishedAt: null,
        publishedBy: null,
        createdBy: request.auth!.sub,
        createdAt: now,
        updatedAt: now,
      }
      await ctx.announcements.insertOne(doc)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'announcement.create',
        entity: 'announcement',
        entityId: doc._id,
        branchId: doc.audience.branchId,
        after: doc,
      })
      return doc
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(announcementResponse(result))
  })

  app.patch('/announcements/:id', scoped('announcements.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = announcementPatch.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const current = await withTenant(tenantId, (ctx) => ctx.announcements.findOne({ _id: id }))
    if (!current || !(await audienceAllowed(request, current.audience))) return reply.code(404).send({ error: 'NOT_FOUND' })
    const patch = parsed.data
    if (patch.audience) {
      if (patch.audience.type === 'school') patch.audience.branchId = null
      if (!(await audienceAllowed(request, patch.audience))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    const result = await transact(tenantId, async (ctx) => {
      if (current.status !== 'draft') throw new Abort('NOT_DRAFT')
      if (patch.audience) {
        const problem = await audienceError(ctx, patch.audience)
        if (problem) throw new Abort(problem)
      }
      const after = await ctx.announcements.findOneAndUpdate(
        { _id: id, status: 'draft' },
        { $set: { ...patch, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      if (!after) throw new Abort('NOT_DRAFT')
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'announcement.update',
        entity: 'announcement',
        entityId: id,
        branchId: after.audience.branchId,
        before: current,
        after,
      })
      return after
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(announcementResponse(result))
  })

  app.post('/announcements/:id/publish', scoped('announcements.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const current = await withTenant(tenantId, (ctx) => ctx.announcements.findOne({ _id: id }))
    if (!current || !(await audienceAllowed(request, current.audience))) return reply.code(404).send({ error: 'NOT_FOUND' })
    const result = await transact(tenantId, async (ctx) => {
      const studentIds = await audienceStudents(ctx, current.audience)
      if (studentIds.length === 0) throw new Abort('AUDIENCE_EMPTY')
      const now = new Date()
      // The status guard makes publishing happen once, however often it's pressed.
      const claimed = await ctx.announcements.findOneAndUpdate(
        { _id: id, status: 'draft' },
        { $set: { status: 'published', studentIds, publishedAt: now, publishedBy: request.auth!.sub, updatedAt: now } },
        { returnDocument: 'after' },
      )
      if (!claimed) throw new Abort('NOT_DRAFT')
      const sent = await deliverAnnouncement(ctx, tenantId, claimed, request.auth!.sub)
      const after = await ctx.announcements.findOneAndUpdate({ _id: id }, { $set: { sent } }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'announcement.publish',
        entity: 'announcement',
        entityId: id,
        branchId: current.audience.branchId,
        meta: { students: studentIds.length, ...sent },
      })
      return after!
    })
    if (isFailure(result)) return sendFailure(reply, result)
    nudgeQueue()
    return reply.send(announcementResponse(result))
  })

  app.post('/announcements/:id/archive', scoped('announcements.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const current = await withTenant(tenantId, (ctx) => ctx.announcements.findOne({ _id: id }))
    if (!current || !(await audienceAllowed(request, current.audience))) return reply.code(404).send({ error: 'NOT_FOUND' })
    const result = await transact(tenantId, async (ctx) => {
      const after = await ctx.announcements.findOneAndUpdate(
        { _id: id, status: { $ne: 'archived' } },
        { $set: { status: 'archived', updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      if (!after) throw new Abort('ALREADY_ARCHIVED')
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'announcement.archive',
        entity: 'announcement',
        entityId: id,
        branchId: current.audience.branchId,
        before: current,
        after,
      })
      return after
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(announcementResponse(result))
  })

  // ------------------------------------------------------- templates --

  app.get('/communication/templates', scoped('notifications.manage'), async (request, reply) => {
    const tenantId = request.auth!.tenantId!
    const docs = await withTenant(tenantId, (ctx) => ctx.messageTemplates.find().toArray())
    const byKind = new Map(docs.map((d) => [d.kind, d]))
    return reply.send({
      templates: TEMPLATE_KINDS.map((kind) => ({
        kind,
        tokens: TEMPLATE_TOKENS[kind],
        customised: byKind.has(kind),
        ...fromDoc(kind, byKind.get(kind) ?? null),
      })),
    })
  })

  app.put('/communication/templates/:kind', scoped('notifications.manage'), async (request, reply) => {
    const { kind } = request.params as { kind: string }
    if (!TEMPLATE_KINDS.includes(kind as TemplateKind)) return reply.code(404).send({ error: 'NOT_FOUND' })
    const parsed = templateBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!parsed.data.subject.trim() || !parsed.data.body.trim()) return reply.code(400).send({ error: 'TEMPLATE_EMPTY' })
    const tenantId = request.auth!.tenantId!
    await withTenant(tenantId, async (ctx) => {
      const _id = `${tenantId}:${kind}`
      const before = await ctx.messageTemplates.findOne({ _id })
      const after = await ctx.messageTemplates.findOneAndUpdate(
        { _id },
        { $set: { kind: kind as TemplateKind, ...parsed.data, updatedAt: new Date(), updatedBy: request.auth!.sub } },
        { upsert: true, returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'template.update',
        entity: 'messageTemplate',
        entityId: kind,
        before,
        after,
      })
    })
    return reply.send({ kind, tokens: TEMPLATE_TOKENS[kind as TemplateKind], customised: true, ...parsed.data })
  })

  /** Back to the built-in wording. */
  app.delete('/communication/templates/:kind', scoped('notifications.manage'), async (request, reply) => {
    const { kind } = request.params as { kind: TemplateKind }
    if (!TEMPLATE_KINDS.includes(kind)) return reply.code(404).send({ error: 'NOT_FOUND' })
    const tenantId = request.auth!.tenantId!
    await withTenant(tenantId, async (ctx) => {
      const before = await ctx.messageTemplates.findOne({ _id: `${tenantId}:${kind}` })
      if (before) {
        await ctx.messageTemplates.deleteOne({ _id: before._id })
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'template.reset',
          entity: 'messageTemplate',
          entityId: kind,
          before,
          after: null,
        })
      }
    })
    return reply.send({ kind, tokens: TEMPLATE_TOKENS[kind], customised: false, ...DEFAULT_TEMPLATES[kind] })
  })

  // -------------------------------------------------------- settings --

  app.get('/communication/settings', scoped('notifications.manage'), async (request, reply) => {
    const tenantId = request.auth!.tenantId!
    return reply.send(await withTenant(tenantId, (ctx) => loadCommunication(ctx, tenantId)))
  })

  app.put('/communication/settings', scoped('notifications.manage'), async (request, reply) => {
    const parsed = settingsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const saved = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.communicationSettings.findOne({ _id: tenantId })
      const after = await ctx.communicationSettings.findOneAndUpdate(
        { _id: tenantId },
        { $set: { ...parsed.data, updatedAt: new Date() } },
        { upsert: true, returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'communication.settings',
        entity: 'communicationSettings',
        entityId: tenantId,
        before,
        after,
      })
      return effectiveCommunication(after)
    })
    return reply.send(saved)
  })

  // ---------------------------------------------------- fee reminders --

  app.get('/finance/reminders', scoped('finance.reminders'), async (request, reply) => {
    const parsed = reminderQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const rows = await withTenant(tenantId, async (ctx) => {
      const settings = await loadCommunication(ctx, tenantId)
      return dueReminders(ctx, {
        branchIds: branches.branchIds,
        asOf: todayIso(),
        daysBefore: parsed.data.daysBefore ?? settings.feeReminders.daysBefore,
        repeatDays: settings.feeReminders.repeatDays,
      })
    })
    return reply.send({ invoices: rows })
  })

  app.post('/finance/reminders/send', scoped('finance.reminders'), async (request, reply) => {
    const parsed = reminderSend.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const asOf = todayIso()
    const outcome = await withTenant(tenantId, async (ctx) => {
      const settings = await loadCommunication(ctx, tenantId)
      const rows = await dueReminders(ctx, {
        branchIds: branches.branchIds,
        asOf,
        daysBefore: parsed.data.daysBefore ?? settings.feeReminders.daysBefore,
        repeatDays: settings.feeReminders.repeatDays,
        invoiceIds: parsed.data.invoiceIds,
      })
      const out = await sendReminders(ctx, tenantId, rows, { asOf, trigger: 'manual', actorId: request.auth!.sub })
      if (out.invoices > 0) {
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'finance.reminders.send',
          entity: 'tenant',
          entityId: tenantId,
          meta: { ...out },
        })
      }
      return out
    })
    nudgeQueue()
    return reply.send(outcome)
  })

  /** Expiring-document notices now, whatever the automatic setting. */
  app.post('/communication/documents-expiring/send', scoped('notifications.manage'), async (request, reply) => {
    const parsed = z.object({ daysBefore: z.number().int().min(1).max(180).optional() }).safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    // Tenant-wide: the notice covers every branch's students.
    if ((await callerBranchIds(request)) !== null) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const outcome = await withTenant(tenantId, async (ctx) => {
      const settings = await loadCommunication(ctx, tenantId)
      const out = await documentsExpiring(ctx, tenantId, {
        asOf: todayIso(),
        daysBefore: parsed.data.daysBefore ?? settings.documentExpiry.daysBefore,
        trigger: 'manual',
        actorId: request.auth!.sub,
      })
      if (out.documents > 0) {
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'documents.expiring.send',
          entity: 'tenant',
          entityId: tenantId,
          meta: { ...out },
        })
      }
      return out
    })
    nudgeQueue()
    return reply.send(outcome)
  })

  // ---------------------------------------------------- delivery log --

  app.get('/communication/log', scoped('notifications.manage'), async (request, reply) => {
    const parsed = logQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<NotificationJobDoc> = {}
    // Jobs from before 6.1 have no kind: they are absence notices.
    if (parsed.data.kind === 'absence') filter.kind = { $in: ['absence', null] } as Filter<NotificationJobDoc>['kind']
    else if (parsed.data.kind) filter.kind = parsed.data.kind
    if (parsed.data.status) filter.status = parsed.data.status
    if (parsed.data.sourceId) filter.sourceId = parsed.data.sourceId
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    const tenantId = request.auth!.tenantId!
    const { rows, counts } = await withTenant(tenantId, async (ctx) => {
      const rows = await ctx.notificationJobs.find(filter).sort({ createdAt: -1 }).limit(parsed.data.limit).toArray()
      const scope: Filter<NotificationJobDoc> = branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}
      const counts = {
        pending: await ctx.notificationJobs.countDocuments({ ...scope, status: { $in: ['pending', 'processing'] } }),
        failed: await ctx.notificationJobs.countDocuments({ ...scope, status: 'failed' }),
        dead: await ctx.notificationJobs.countDocuments({ ...scope, status: 'dead' }),
      }
      return { rows, counts }
    })
    return reply.send({ entries: rows.map(jobResponse), counts })
  })

  // ------------------------------------------------ delivery channels --

  /** Whether email and SMS can go out, for the settings page. Addresses
   * and credentials never leave the server. */
  app.get('/communication/channels', scoped('notifications.manage'), async (_request, reply) => {
    return reply.send({ email: emailStatus(), sms: smsStatus() })
  })

  /** Sends one test message straight away (not through the queue), so an
   * administrator sees at once whether the provider accepts it. */
  app.post('/communication/test-send', scoped('notifications.manage'), async (request, reply) => {
    const parsed = testSendBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const { channel, to } = parsed.data
    if (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return reply.code(400).send({ error: 'INVALID_EMAIL' })
    const tenantId = request.auth!.tenantId!
    const school = await schoolName(tenantId)
    let outcome: { ok: true; providerMessageId: string | null } | { ok: false; error: string }
    try {
      const sent = await deliver({
        channel,
        to,
        subject: 'Test message / رسالة تجريبية',
        body:
          channel === 'email'
            ? `This is a test email from ${school || 'your school'}. If you can read it, email delivery works.\n\nهذه رسالة تجريبية. إذا وصلتك فإن إرسال البريد يعمل.`
            : `Test SMS from ${school || 'your school'}: SMS delivery works. رسالة تجريبية.`,
      })
      outcome = { ok: true, providerMessageId: sent.providerMessageId }
    } catch (error) {
      outcome = { ok: false, error: deliveryErrorCode(error) }
    }
    await withTenant(tenantId, (ctx) =>
      recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'notification.test',
        entity: 'tenant',
        entityId: tenantId,
        meta: { channel, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }) },
      }),
    )
    if (!outcome.ok) return reply.code(409).send({ error: 'SEND_FAILED', reason: outcome.error })
    return reply.send(outcome)
  })

  /** Queues every given-up message again (in the caller's branches), e.g.
   * once email is set up after messages died as EMAIL_NOT_CONFIGURED. */
  app.post('/communication/log/retry', scoped('notifications.manage'), async (request, reply) => {
    const parsed = bulkRetryBody.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const branches = await branchFilter(request, undefined)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const filter: Filter<NotificationJobDoc> = { status: { $in: ['dead', 'failed'] } }
    if (parsed.data.kind === 'absence') filter.kind = { $in: ['absence', null] } as Filter<NotificationJobDoc>['kind']
    else if (parsed.data.kind) filter.kind = parsed.data.kind
    if (parsed.data.error) filter.lastError = parsed.data.error
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    const requeued = await withTenant(tenantId, async (ctx) => {
      const jobs = await ctx.notificationJobs.find(filter).limit(2000).toArray()
      const now = new Date()
      let n = 0
      for (const job of jobs) {
        const after = await ctx.notificationJobs.findOneAndUpdate(
          { _id: job._id, status: job.status },
          { $set: { status: 'pending', nextAttemptAt: now, maxAttempts: job.attempts + 1, updatedAt: now } },
        )
        if (after) n++
      }
      if (n > 0) {
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'notification.retryAll',
          entity: 'tenant',
          entityId: tenantId,
          meta: { requeued: n, kind: parsed.data.kind ?? null, error: parsed.data.error ?? null },
        })
      }
      return n
    })
    if (requeued > 0) nudgeQueue()
    return reply.send({ requeued })
  })

  /** Tries a failed or given-up message again. */
  app.post('/communication/log/:id/retry', scoped('notifications.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const result = await transact(tenantId, async (ctx) => {
      const job = await ctx.notificationJobs.findOne({ _id: id })
      if (!job) throw new Abort('NOT_FOUND')
      if (job.branchId && !(await callerCanUseBranch(request, job.branchId))) throw new Abort('NOT_FOUND')
      if (job.status !== 'dead' && job.status !== 'failed') throw new Abort('NOT_FAILED')
      const after = await ctx.notificationJobs.findOneAndUpdate(
        { _id: id, status: job.status },
        {
          $set: { status: 'pending', nextAttemptAt: new Date(), maxAttempts: job.attempts + 1, updatedAt: new Date() },
        },
        { returnDocument: 'after' },
      )
      if (!after) throw new Abort('NOT_FAILED')
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'notification.retry',
        entity: 'notification',
        entityId: id,
        branchId: job.branchId || null,
        meta: { kind: job.kind ?? 'absence', lastError: job.lastError },
      })
      return after
    })
    if (isFailure(result)) return sendFailure(reply, result)
    nudgeQueue()
    return reply.send(jobResponse(result))
  })
}
