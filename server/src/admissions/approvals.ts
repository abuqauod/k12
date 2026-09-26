import { z } from 'zod'
import type { ApplicationDoc, TenantContext } from '../db.js'
import { registerApprovalType } from '../approvals/registry.js'
import { recordAudit } from '../audit.js'
import { checklist, checklistComplete } from './service.js'
import { notifyContact, schoolName } from '../notifications/messages.js'

/**
 * An admissions decision (SAMS 2.5) goes through the shared approval
 * engine (1.10): whoever reviews the application (admissions.manage)
 * proposes accept / reject / waitlist, and someone with admissions.decide
 * (never the proposer) approves it. Accepting needs a complete document
 * checklist, checked both when proposed and again when approved.
 */

const payloadSchema = z.object({
  outcome: z.enum(['accepted', 'rejected', 'waitlisted']),
  note: z.string().trim().max(1000).nullish(),
})
type Payload = z.infer<typeof payloadSchema>

/** Where a decision can be proposed from. */
const DECIDABLE: ReadonlySet<ApplicationDoc['status']> = new Set(['under_review', 'waitlisted'])

async function check(
  ctx: TenantContext,
  id: string,
  payload: Payload,
): Promise<{ ok: true; app: ApplicationDoc } | { ok: false; error: string }> {
  const app = await ctx.applications.findOne({ _id: id })
  if (!app) return { ok: false, error: 'UNKNOWN_APPLICATION' }
  if (!DECIDABLE.has(app.status)) return { ok: false, error: 'NOT_UNDER_REVIEW' }
  if (app.status === 'waitlisted' && payload.outcome === 'waitlisted') return { ok: false, error: 'ALREADY_WAITLISTED' }
  if (payload.outcome === 'accepted' && !checklistComplete(await checklist(ctx, app))) {
    return { ok: false, error: 'CHECKLIST_INCOMPLETE' }
  }
  return { ok: true, app }
}

const DECISION_WORDS = {
  en: { accepted: 'accepted', rejected: 'declined', waitlisted: 'placed on the waiting list' },
  ar: { accepted: 'قبول', rejected: 'رفض', waitlisted: 'إدراج (قائمة الانتظار)' },
} as const

registerApprovalType<Payload>({
  type: 'admissions.decision',
  entity: 'application',
  requestScope: 'admissions.manage',
  decideScope: 'admissions.decide',
  payloadSchema,
  async resolve(ctx, id, payload) {
    const checked = await check(ctx, id, payload)
    if (!checked.ok) return checked
    const a = checked.app.applicant
    return {
      ok: true,
      branchId: checked.app.branchId,
      // One open decision per application.
      dedupeKey: `application:${id}`,
      summary: `${checked.app.applicationNumber} · ${a.givenName} ${a.familyName} · ${payload.outcome}`,
    }
  },
  async onApproved(ctx, request, actorId) {
    const payload = request.payload as Payload
    const checked = await check(ctx, request.entityId, payload)
    if (!checked.ok) return checked
    const now = new Date()
    const updated = await ctx.applications.findOneAndUpdate(
      { _id: request.entityId, status: checked.app.status },
      {
        $set: {
          status: payload.outcome,
          decision: {
            outcome: payload.outcome,
            note: payload.note ?? null,
            decidedBy: actorId,
            decidedAt: now,
            approvalRequestId: request._id,
          },
          updatedAt: now,
        },
      },
    )
    if (!updated) return { ok: false, error: 'STALE_REQUEST' }
    await recordAudit(ctx.auditLog, {
      actorId,
      action: `application.${payload.outcome}`,
      entity: 'application',
      entityId: request.entityId,
      branchId: checked.app.branchId,
      before: { status: checked.app.status },
      after: { status: payload.outcome, approvalRequestId: request._id },
      meta: { note: payload.note ?? null },
    })
    // SAMS 6.3: the family hears the outcome.
    const app = checked.app
    const school = await schoolName(app.tenantId)
    const contacts = app.guardians.filter((g) => g.primaryContact)
    for (const g of contacts.length ? contacts : app.guardians.slice(0, 1)) {
      await notifyContact(ctx, app.tenantId, {
        kind: 'admission_decision',
        sourceId: request._id,
        branchId: app.branchId,
        recipientId: `application:${app._id}:${g.id}`,
        name: g.fullName,
        email: g.email,
        phone: g.phone || null,
        language: g.preferredLanguage,
        tokens: {
          guardianName: g.fullName,
          applicantName: `${app.applicant.givenName} ${app.applicant.familyName}`.trim(),
          applicationNumber: app.applicationNumber,
          decision: DECISION_WORDS[g.preferredLanguage][payload.outcome],
          schoolName: school,
        },
        actorId,
      })
    }
    return { ok: true }
  },
})
