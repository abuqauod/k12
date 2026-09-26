import type { DocumentDoc, TenantContext } from '../db.js'
import { withTenant, withoutTenant } from '../db.js'
import { withLock } from '../lock.js'
import { recordAudit } from '../audit.js'
import { notifyFamilies, schoolName, type Delivered } from '../notifications/messages.js'
import { dueReminders, sendReminders } from './reminders.js'
import { loadCommunication } from './settings.js'

/**
 * SAMS 6.3 document notices, and the once-a-day automatic run of fee
 * reminders and expiring-document notices for schools that turned them on.
 */

async function categoryLabels(ctx: TenantContext, codes: string[]): Promise<Map<string, { en: string; ar: string }>> {
  const rows = await ctx.lookups.find({ kind: 'documentCategory', code: { $in: codes } }).toArray()
  return new Map(rows.map((r) => [r.code, { en: r.label, ar: r.labelAr || r.label }]))
}

const studentName = (s: { givenName: string; familyName: string }) => `${s.givenName} ${s.familyName}`.trim()

/** A student's document was rejected: ask the family for a new copy. */
export async function documentRejected(
  ctx: TenantContext,
  tenantId: string,
  doc: DocumentDoc,
  actorId: string,
): Promise<Delivered | null> {
  if (doc.ownerType !== 'student') return null
  const labels = await categoryLabels(ctx, [doc.categoryCode])
  const label = labels.get(doc.categoryCode) ?? { en: doc.categoryCode, ar: doc.categoryCode }
  const school = await schoolName(tenantId)
  return notifyFamilies(ctx, tenantId, {
    kind: 'document_rejected',
    sourceId: doc._id,
    studentIds: [doc.ownerId],
    recipients: 'all',
    tokens: (student, parent) => ({
      parentName: parent.fullName,
      studentName: studentName(student),
      document: parent.preferredLanguage === 'ar' ? label.ar : label.en,
      note: doc.verification.note ?? '',
      schoolName: school,
    }),
    link: (studentId) => `/portal/children/${studentId}?tab=documents`,
    trigger: 'manual',
    actorId,
  })
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Current student documents expiring within `daysBefore` days. Each is
 * noticed once per expiry date, so a replaced document starts afresh. */
export async function documentsExpiring(
  ctx: TenantContext,
  tenantId: string,
  params: { asOf: string; daysBefore: number; trigger: 'auto' | 'manual'; actorId: string | null },
): Promise<Delivered & { documents: number }> {
  const docs = await ctx.documents
    .find({
      ownerType: 'student',
      isCurrent: true,
      archivedAt: null,
      expiresAt: { $gte: params.asOf, $lte: addDays(params.asOf, params.daysBefore) },
    })
    .toArray()
  const out = { documents: 0, families: 0, inApp: 0, email: 0, sms: 0 }
  if (docs.length === 0) return out
  const labels = await categoryLabels(ctx, [...new Set(docs.map((d) => d.categoryCode))])
  const school = await schoolName(tenantId)
  for (const doc of docs) {
    const label = labels.get(doc.categoryCode) ?? { en: doc.categoryCode, ar: doc.categoryCode }
    const sent = await notifyFamilies(ctx, tenantId, {
      kind: 'document_expiring',
      sourceId: doc._id,
      dedupe: doc.expiresAt!,
      studentIds: [doc.ownerId],
      recipients: 'all',
      tokens: (student, parent) => ({
        parentName: parent.fullName,
        studentName: studentName(student),
        document: parent.preferredLanguage === 'ar' ? label.ar : label.en,
        expiresAt: doc.expiresAt!,
        schoolName: school,
      }),
      link: (studentId) => `/portal/children/${studentId}?tab=documents`,
      trigger: params.trigger,
      actorId: params.actorId,
    })
    if (sent.inApp + sent.email + sent.sms > 0) out.documents++
    out.families += sent.families
    out.inApp += sent.inApp
    out.email += sent.email
    out.sms += sent.sms
  }
  return out
}

/**
 * SAMS 11.3: families of students with an overdue library book. A loan is
 * noticed on its first overdue day and then every `repeatDays` days, never
 * twice in one of those periods (the period is the dedupe key).
 */
export async function libraryOverdueNotices(
  ctx: TenantContext,
  tenantId: string,
  params: { asOf: string; repeatDays: number; branchIds?: string[] | null; loanIds?: string[]; trigger: 'auto' | 'manual'; actorId: string | null },
): Promise<Delivered & { loans: number }> {
  const loans = await ctx.loans
    .find({
      borrowerType: 'student',
      returnedAt: null,
      lostAt: null,
      dueDate: { $lt: params.asOf },
      ...(params.branchIds ? { branchId: { $in: params.branchIds } } : {}),
      ...(params.loanIds ? { _id: { $in: params.loanIds } } : {}),
    })
    .toArray()
  const out = { loans: 0, families: 0, inApp: 0, email: 0, sms: 0 }
  if (loans.length === 0) return out
  const books = new Map((await ctx.books.find({ _id: { $in: [...new Set(loans.map((l) => l.bookId))] } }).toArray()).map((b) => [b._id, b]))
  const lib = await ctx.librarySettings.findOne({ _id: tenantId })
  const perDay = lib?.finePerDay ?? 10
  const school = await schoolName(tenantId)
  const daysLate = (due: string) => Math.round((Date.parse(`${params.asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000)
  for (const loan of loans) {
    const late = daysLate(loan.dueDate)
    const period = Math.floor((late - 1) / Math.max(1, params.repeatDays))
    const fine = late * perDay
    const sent = await notifyFamilies(ctx, tenantId, {
      kind: 'library_overdue',
      sourceId: loan._id,
      dedupe: `p${period}`,
      studentIds: [loan.borrowerId],
      recipients: 'all',
      tokens: (student, parent) => ({
        parentName: parent.fullName,
        studentName: studentName(student),
        title: books.get(loan.bookId)?.title ?? '',
        dueDate: loan.dueDate,
        fine: `${Math.floor(fine / 100)}.${String(fine % 100).padStart(2, '0')}`,
        schoolName: school,
      }),
      trigger: params.trigger,
      actorId: params.actorId,
    })
    if (sent.inApp + sent.email + sent.sms > 0) out.loans++
    out.families += sent.families
    out.inApp += sent.inApp
    out.email += sent.email
    out.sms += sent.sms
  }
  return out
}

/** Runs one tenant's automatic notices for `asOf`, once per day. */
export async function runDailyNotices(tenantId: string, asOf: string): Promise<boolean> {
  return withTenant(tenantId, async (ctx) => {
    const settings = await loadCommunication(ctx, tenantId)
    if (settings.lastRunDate === asOf) return false
    if (!settings.feeReminders.auto && !settings.documentExpiry.auto && !settings.libraryOverdue.auto) return false
    const meta: Record<string, unknown> = {}
    if (settings.feeReminders.auto) {
      const rows = await dueReminders(ctx, {
        branchIds: null,
        asOf,
        daysBefore: settings.feeReminders.daysBefore,
        repeatDays: settings.feeReminders.repeatDays,
      })
      meta.feeReminders = await sendReminders(ctx, tenantId, rows, { asOf, trigger: 'auto', actorId: null })
    }
    if (settings.documentExpiry.auto) {
      meta.documentExpiry = await documentsExpiring(ctx, tenantId, {
        asOf,
        daysBefore: settings.documentExpiry.daysBefore,
        trigger: 'auto',
        actorId: null,
      })
    }
    if (settings.libraryOverdue.auto) {
      meta.libraryOverdue = await libraryOverdueNotices(ctx, tenantId, {
        asOf,
        repeatDays: settings.libraryOverdue.repeatDays,
        trigger: 'auto',
        actorId: null,
      })
    }
    await ctx.communicationSettings.findOneAndUpdate(
      { _id: tenantId },
      { $set: { lastRunDate: asOf, updatedAt: new Date() } },
      { upsert: true },
    )
    await recordAudit(ctx.auditLog, {
      actorId: null,
      action: 'communication.daily',
      entity: 'communicationSettings',
      entityId: tenantId,
      meta,
    })
    return true
  })
}

/** Every tenant with automatic notices on, under one lock. */
export async function runAllDailyNotices(): Promise<void> {
  await withLock('daily-notices', 10 * 60_000, async () => {
    const asOf = new Date().toISOString().slice(0, 10)
    const tenants = await withoutTenant((db) =>
      db.communicationSettings
        .find({ lastRunDate: { $ne: asOf }, $or: [{ 'feeReminders.auto': true }, { 'documentExpiry.auto': true }, { 'libraryOverdue.auto': true }] })
        .toArray(),
    )
    for (const row of tenants) {
      try {
        await runDailyNotices(row.tenantId, asOf)
      } catch (error) {
        console.error(`daily notices failed for tenant ${row.tenantId}`, error)
      }
    }
  })
}
