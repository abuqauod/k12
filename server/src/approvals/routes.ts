import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { ApprovalRequestDoc } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerHasPermission,
  callerScopes,
  requireActiveSubscription,
} from '../auth/guard.js'
import { approvalType, approvalTypes } from './registry.js'
import { createRequest, transition } from './service.js'

/**
 * Approval requests (SAMS 1.10). Authority is per type: raising a request
 * needs the type's `requestScope`, deciding needs its `decideScope`, and
 * both need the request's branch. `approvals.decide` is only the admin
 * override for cancelling someone else's request.
 */

const ERROR_STATUS: Record<string, number> = {
  UNKNOWN_TYPE: 400,
  INVALID_PAYLOAD: 400,
  NOT_FOUND: 404,
  BRANCH_FORBIDDEN: 403,
  SELF_DECISION: 403,
  ALREADY_PENDING: 409,
  ALREADY_DECIDED: 409,
  // Codes the registered types return.
  UNKNOWN_INVOICE: 404,
  UNKNOWN_LINE_ITEM: 404,
  INVOICE_VOID: 409,
  INVOICE_PAID: 409,
  DISCOUNT_OUT_OF_RANGE: 400,
  LINE_ALREADY_DISCOUNTED: 409,
}

const createBody = z.object({
  type: z.string().min(1),
  entityId: z.string().min(1),
  payload: z.record(z.unknown()),
  comment: z.string().trim().max(1000).nullable().default(null),
})

const decideBody = z.object({ comment: z.string().trim().max(1000).nullable().default(null) })

const listQuery = z.object({
  view: z.enum(['mine', 'toDecide', 'all']).default('all'),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  type: z.string().optional(),
  entity: z.string().optional(),
  entityId: z.string().optional(),
})

function toResponse(doc: ApprovalRequestDoc) {
  return {
    id: doc._id,
    type: doc.type,
    entity: doc.entity,
    entityId: doc.entityId,
    branchId: doc.branchId,
    status: doc.status,
    payload: doc.payload,
    summary: doc.summary,
    requestedBy: doc.requestedBy,
    decidedBy: doc.decidedBy,
    decidedAt: doc.decidedAt?.toISOString() ?? null,
    comments: doc.comments.map((c) => ({ ...c, at: c.at.toISOString() })),
    createdAt: doc.createdAt.toISOString(),
  }
}

const inBranches = (branchId: string | null, allowed: string[] | null) =>
  allowed === null || (branchId !== null && allowed.includes(branchId))

/** Types whose requests the caller may decide. */
async function decidableTypes(request: FastifyRequest): Promise<string[]> {
  const held = await callerScopes(request)
  return approvalTypes()
    .filter((def) => held.has(def.decideScope))
    .map((def) => def.type)
}

/** May the caller see this request at all? Requester, or a decider for its
 * type within its branch. Anyone else gets a 404, not a 403. */
async function canSee(request: FastifyRequest, doc: ApprovalRequestDoc): Promise<boolean> {
  if (doc.requestedBy === request.auth!.sub) return true
  const def = approvalType(doc.type)
  if (!def || !(await callerHasPermission(request, def.decideScope))) return false
  return inBranches(doc.branchId, await callerBranchIds(request))
}

/** "To decide": decidable types, in the caller's branches, not their own.
 * Shared with the dashboard's pending-approvals count. */
export async function toDecideFilter(request: FastifyRequest): Promise<Filter<ApprovalRequestDoc>> {
  const allowed = await callerBranchIds(request)
  return {
    type: { $in: await decidableTypes(request) },
    requestedBy: { $ne: request.auth!.sub },
    ...(allowed === null ? {} : { branchId: { $in: allowed } }),
  }
}

export function registerApprovalRoutes(app: FastifyInstance): void {
  const guard = { preHandler: [authenticate, requireActiveSubscription] }

  app.get('/approvals/types', guard, async (request, reply) => {
    const held = await callerScopes(request)
    return reply.send({
      types: approvalTypes().map((def) => ({
        type: def.type,
        entity: def.entity,
        canRequest: held.has(def.requestScope),
        canDecide: held.has(def.decideScope),
      })),
    })
  })

  app.post('/approvals', guard, async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const def = approvalType(parsed.data.type)
    if (!def) return reply.code(400).send({ error: 'UNKNOWN_TYPE' })
    if (!(await callerHasPermission(request, def.requestScope))) {
      return reply.code(403).send({ error: 'FORBIDDEN', required: def.requestScope })
    }
    const result = await createRequest(request.auth!.tenantId!, {
      ...parsed.data,
      actorId: request.auth!.sub,
      allowedBranchIds: await callerBranchIds(request),
    })
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 409).send({ error: result.error })
    return reply.code(201).send(toResponse(result.request))
  })

  app.get('/approvals', guard, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { view, status, type, entity, entityId } = parsed.data
    const me = request.auth!.sub

    const toDecide = await toDecideFilter(request)
    const mine: Filter<ApprovalRequestDoc> = { requestedBy: me }
    // Narrowing filters are ANDed onto the view — never merged into it, or a
    // `type` filter would replace the view's own decidable-types restriction.
    const clauses: Filter<ApprovalRequestDoc>[] = [
      view === 'mine' ? mine : view === 'toDecide' ? toDecide : { $or: [mine, toDecide] },
    ]
    if (status) clauses.push({ status })
    if (type) clauses.push({ type })
    if (entity) clauses.push({ entity })
    if (entityId) clauses.push({ entityId })
    const filter: Filter<ApprovalRequestDoc> = { $and: clauses }

    const docs = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.approvalRequests.find(filter).sort({ createdAt: -1 }).limit(200).toArray(),
    )
    return reply.send({ approvals: docs.map(toResponse) })
  })

  app.get('/approvals/:id', guard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const doc = await withTenant(request.auth!.tenantId!, (ctx) => ctx.approvalRequests.findOne({ _id: id }))
    if (!doc || !(await canSee(request, doc))) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(doc))
  })

  for (const [path, to] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
    ['cancel', 'cancelled'],
  ] as const) {
    app.post(`/approvals/:id/${path}`, guard, async (request, reply) => {
      const { id } = request.params as { id: string }
      const parsed = decideBody.safeParse(request.body ?? {})
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
      if (to === 'rejected' && !parsed.data.comment) return reply.code(400).send({ error: 'COMMENT_REQUIRED' })

      const tenantId = request.auth!.tenantId!
      const doc = await withTenant(tenantId, (ctx) => ctx.approvalRequests.findOne({ _id: id }))
      if (!doc || !(await canSee(request, doc))) {
        // An approvals.decide holder may reach a request only to cancel it.
        const override =
          doc &&
          to === 'cancelled' &&
          (await callerHasPermission(request, 'approvals.decide')) &&
          inBranches(doc.branchId, await callerBranchIds(request))
        if (!override) return reply.code(404).send({ error: 'NOT_FOUND' })
      }

      const def = approvalType(doc!.type)
      if (to === 'cancelled') {
        const isRequester = doc!.requestedBy === request.auth!.sub
        if (!isRequester && !(await callerHasPermission(request, 'approvals.decide'))) {
          return reply.code(403).send({ error: 'FORBIDDEN', required: 'approvals.decide' })
        }
      } else {
        if (!def) return reply.code(409).send({ error: 'UNKNOWN_TYPE' })
        if (!(await callerHasPermission(request, def.decideScope))) {
          return reply.code(403).send({ error: 'FORBIDDEN', required: def.decideScope })
        }
        if (!inBranches(doc!.branchId, await callerBranchIds(request))) {
          return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
        }
      }

      const result = await transition(tenantId, id, { to, actorId: request.auth!.sub, comment: parsed.data.comment })
      if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 409).send({ error: result.error })
      return reply.send(toResponse(result.request))
    })
  }
}
