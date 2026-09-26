import type { ZodType } from 'zod'
import type { ApprovalRequestDoc, TenantContext } from '../db.js'
import type { PermissionScope } from '../auth/scopes.js'

/**
 * SAMS 1.10: the one approval mechanism every module shares. A module
 * registers a type once at startup; requests of every type are stored in
 * `approvalRequests` and move through the same pending → approved |
 * rejected | cancelled lifecycle (service.ts). Nothing here is
 * module-specific — admissions, refunds, scholarships, leave, etc. each
 * add a type rather than their own approval table.
 */

export type ApprovalOutcome = { ok: true } | { ok: false; error: string }

export type ResolveResult =
  | { ok: true; branchId: string | null; dedupeKey: string; summary: string }
  | { ok: false; error: string }

export interface ApprovalType<P = Record<string, unknown>> {
  type: string
  /** The entity requests of this type point at (e.g. 'invoice'). */
  entity: string
  /** Who may raise a request. */
  requestScope: PermissionScope
  /** Who may approve or reject one. */
  decideScope: PermissionScope
  payloadSchema: ZodType<P>
  /** Validates against current data at request time; resolves the branch
   * (for isolation), a dedupe key (one pending request per key) and a
   * display summary. */
  resolve(ctx: TenantContext, entityId: string, payload: P): Promise<ResolveResult>
  /** Applies the approved change. Runs in the same transaction as the
   * decision; an error rolls the decision back and the request stays
   * pending. Must re-check current data — it may have changed since. */
  onApproved(ctx: TenantContext, request: ApprovalRequestDoc, actorId: string): Promise<ApprovalOutcome>
  /** Optional: runs in the same transaction when a request is rejected or
   * cancelled — for types whose entity carries its own status (a refund,
   * an expense) and must follow the decision. */
  onClosed?(
    ctx: TenantContext,
    request: ApprovalRequestDoc,
    outcome: 'rejected' | 'cancelled',
    actorId: string,
  ): Promise<void>
}

const types = new Map<string, ApprovalType>()

export function registerApprovalType<P>(def: ApprovalType<P>): void {
  if (types.has(def.type)) throw new Error(`approval type already registered: ${def.type}`)
  types.set(def.type, def as unknown as ApprovalType)
}

export function approvalType(type: string): ApprovalType | undefined {
  return types.get(type)
}

export function approvalTypes(): ApprovalType[] {
  return [...types.values()]
}
