import type { FastifyReply, FastifyRequest } from 'fastify'
import { MongoServerError } from 'mongodb'
import { withTenant } from '../db.js'
import type { TenantContext } from '../db.js'
import { authenticate, callerBranchIds, requireActiveSubscription, requirePermission } from '../auth/guard.js'
import type { PermissionScope } from '../auth/scopes.js'

/** Shared plumbing for the Phase 3 finance modules (discounts, scholarships,
 * refunds, expenses, reports). */

export const scoped = (scope: PermissionScope) => ({
  preHandler: [authenticate, requireActiveSubscription, requirePermission(scope)],
})

/** Thrown inside a transaction to roll it back with a typed error. */
export class FinanceAbort extends Error {
  constructor(
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

export type Failure = { ok: false; error: string; extra?: Record<string, unknown> }

const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000

/** Runs `fn` in one transaction; a `FinanceAbort` (or a second pending
 * approval for the same thing) rolls it back and comes out as a failure. */
export async function transact<T>(tenantId: string, fn: (ctx: TenantContext) => Promise<T>): Promise<T | Failure> {
  try {
    return await withTenant(tenantId, fn)
  } catch (error) {
    if (error instanceof FinanceAbort) return { ok: false, error: error.code, extra: error.extra }
    if (isDuplicateKey(error)) return { ok: false, error: 'ALREADY_PENDING' }
    throw error
  }
}

export const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false

export const ERROR_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  UNKNOWN_INVOICE: 404,
  UNKNOWN_STUDENT: 404,
  UNKNOWN_DISCOUNT_TYPE: 404,
  UNKNOWN_VENDOR: 404,
  UNKNOWN_PAYMENT: 404,
  BRANCH_FORBIDDEN: 403,
  FORBIDDEN: 403,
  SELF_DECISION: 403,
  INVALID_BODY: 400,
  INVALID_CATEGORY: 400,
  INVALID_PAYMENT_METHOD: 400,
  VALUE_OUT_OF_RANGE: 400,
  REASON_REQUIRED: 400,
}

export function sendFailure(reply: FastifyReply, failure: Failure) {
  return reply.code(ERROR_STATUS[failure.error] ?? 409).send({ error: failure.error, ...(failure.extra ?? {}) })
}

/** A branch filter for a list: the one asked for (if allowed), else the
 * caller's branches (null = every branch). */
export async function branchFilter(
  request: FastifyRequest,
  branchId: string | undefined,
): Promise<{ ok: true; branchIds: string[] | null } | { ok: false }> {
  const allowed = await callerBranchIds(request)
  if (branchId) {
    if (allowed !== null && !allowed.includes(branchId)) return { ok: false }
    return { ok: true, branchIds: [branchId] }
  }
  return { ok: true, branchIds: allowed }
}

export const todayIso = () => new Date().toISOString().slice(0, 10)

/** "10%" or the amount in minor units, for approval summaries. */
export const describeValue = (type: 'amount' | 'percent', value: number) =>
  type === 'percent' ? `${value}%` : String(value)

export async function studentName(ctx: TenantContext, studentId: string): Promise<string> {
  const s = await ctx.students.findOne({ _id: studentId })
  return s ? `${s.givenName} ${s.familyName}`.trim() : studentId
}
