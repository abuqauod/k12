import { z } from 'zod'
import type { ApplicationDoc, TenantContext } from '../db.js'
import { registerApprovalType } from '../approvals/registry.js'
import { recordAudit } from '../audit.js'
import { checklist, checklistComplete } from './service.js'

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
    return { ok: true }
  },
})
