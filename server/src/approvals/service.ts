import { randomUUID } from 'node:crypto'
import { MongoServerError } from 'mongodb'
import { withTenant } from '../db.js'
import type { ApprovalComment, ApprovalRequestDoc, ApprovalStatus } from '../db.js'
import { recordAudit } from '../audit.js'
import { approvalType } from './registry.js'

/**
 * Lifecycle of an approval request (SAMS 1.10). Authorization (scopes,
 * branches) is the routes' job; this file owns the state machine:
 *  - only `pending` moves, and only once — every transition is a
 *    compare-and-set on `{status: 'pending', version}`, inside a
 *    transaction, so two deciders can never both win;
 *  - approving runs the type's `onApproved` in the same transaction, so an
 *    approval whose change can no longer be applied rolls back entirely;
 *  - the requester can never decide their own request;
 *  - every transition is audited.
 */

type Fail = { ok: false; error: string }
export type RequestResult = { ok: true; request: ApprovalRequestDoc } | Fail

/** Thrown inside a transaction to roll it back with a typed error. */
class ApprovalAbort extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000

export async function createRequest(
  tenantId: string,
  params: {
    type: string
    entityId: string
    payload: unknown
    comment: string | null
    actorId: string
    /** The requester's branches (null = all); the entity's resolved branch
     * must be among them. */
    allowedBranchIds: string[] | null
  },
): Promise<RequestResult> {
  const def = approvalType(params.type)
  if (!def) return { ok: false, error: 'UNKNOWN_TYPE' }
  const parsed = def.payloadSchema.safeParse(params.payload)
  if (!parsed.success) return { ok: false, error: 'INVALID_PAYLOAD' }

  try {
    return await withTenant(tenantId, async (ctx): Promise<RequestResult> => {
      const resolved = await def.resolve(ctx, params.entityId, parsed.data)
      if (!resolved.ok) return resolved
      if (
        params.allowedBranchIds !== null &&
        (resolved.branchId === null || !params.allowedBranchIds.includes(resolved.branchId))
      ) {
        return { ok: false, error: 'BRANCH_FORBIDDEN' }
      }
      const now = new Date()
      const comments: ApprovalComment[] = params.comment
        ? [{ id: randomUUID(), actorId: params.actorId, body: params.comment, at: now, kind: 'request' }]
        : []
      const _id = randomUUID()
      const doc = {
        _id,
        type: def.type,
        entity: def.entity,
        entityId: params.entityId,
        branchId: resolved.branchId,
        status: 'pending' as const,
        payload: parsed.data as Record<string, unknown>,
        summary: resolved.summary,
        dedupeKey: resolved.dedupeKey,
        requestedBy: params.actorId,
        decidedBy: null,
        decidedAt: null,
        comments,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      await ctx.approvalRequests.insertOne(doc)
      const request = (await ctx.approvalRequests.findOne({ _id }))!
      await recordAudit(ctx.auditLog, {
        actorId: params.actorId,
        action: 'approval.request',
        entity: 'approval',
        entityId: _id,
        branchId: resolved.branchId,
        after: request,
      })
      return { ok: true, request }
    })
  } catch (error) {
    if (isDuplicateKey(error)) return { ok: false, error: 'ALREADY_PENDING' }
    throw error
  }
}

/** Approve, reject or cancel a pending request. */
export async function transition(
  tenantId: string,
  id: string,
  params: { to: Exclude<ApprovalStatus, 'pending'>; actorId: string; comment: string | null },
): Promise<RequestResult> {
  try {
    return await withTenant(tenantId, async (ctx): Promise<RequestResult> => {
      const before = await ctx.approvalRequests.findOne({ _id: id })
      if (!before) return { ok: false, error: 'NOT_FOUND' }
      if (before.status !== 'pending') return { ok: false, error: 'ALREADY_DECIDED' }
      const deciding = params.to !== 'cancelled'
      if (deciding && before.requestedBy === params.actorId) return { ok: false, error: 'SELF_DECISION' }
      const def = approvalType(before.type)
      if (deciding && !def) return { ok: false, error: 'UNKNOWN_TYPE' }

      const now = new Date()
      const kind = params.to === 'approved' ? 'approve' : params.to === 'rejected' ? 'reject' : 'cancel'
      const comment: ApprovalComment[] = params.comment
        ? [{ id: randomUUID(), actorId: params.actorId, body: params.comment, at: now, kind }]
        : []
      const after = await ctx.approvalRequests.findOneAndUpdate(
        { _id: id, status: 'pending', version: before.version },
        {
          $set: {
            status: params.to,
            decidedBy: params.actorId,
            decidedAt: now,
            updatedAt: now,
            // Safe to rewrite whole: the version guard means nothing changed since `before`.
            comments: [...before.comments, ...comment],
          },
          $inc: { version: 1 },
        },
        { returnDocument: 'after' },
      )
      if (!after) return { ok: false, error: 'ALREADY_DECIDED' }

      if (params.to === 'approved') {
        const applied = await def!.onApproved(ctx, after, params.actorId)
        if (!applied.ok) throw new ApprovalAbort(applied.error)
      }
      await recordAudit(ctx.auditLog, {
        actorId: params.actorId,
        action: `approval.${kind}`,
        entity: 'approval',
        entityId: id,
        branchId: before.branchId,
        before,
        after,
      })
      return { ok: true, request: after }
    })
  } catch (error) {
    if (error instanceof ApprovalAbort) return { ok: false, error: error.code }
    throw error
  }
}
