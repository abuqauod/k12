import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { AssetEventType, TenantContext } from '../db.js'
import { withTenant } from '../db.js'
import { callerCanUseBranch } from '../auth/guard.js'
import { activeCodes, ensureDefaults } from '../settings/lookups.js'

/** Shared by the operations modules (SAMS Phase 5). */

export const EXPIRING_DAYS = 60

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** Checks a settings-list code is active; null passes. */
export async function checkCode(tenantId: string, kind: string, code: string | null | undefined): Promise<boolean> {
  if (code === null || code === undefined) return true
  await ensureDefaults(tenantId, kind)
  return withTenant(tenantId, async (ctx) => (await activeCodes(ctx, kind)).has(code))
}

/** Loads a branch-scoped record and checks the caller may use its branch. */
export async function recordAccess<T extends { branchId: string }>(
  request: FastifyRequest,
  load: (ctx: TenantContext) => Promise<T | null>,
): Promise<{ ok: true; doc: T } | { ok: false; status: number; error: string }> {
  const doc = await withTenant(request.auth!.tenantId!, load)
  if (!doc) return { ok: false, status: 404, error: 'NOT_FOUND' }
  if (!(await callerCanUseBranch(request, doc.branchId))) return { ok: false, status: 403, error: 'BRANCH_FORBIDDEN' }
  return { ok: true, doc }
}

export async function assetEvent(
  ctx: TenantContext,
  tenantId: string,
  e: { assetId: string; branchId: string; type: AssetEventType; date: string; from?: string | null; to?: string | null; note?: string | null; cost?: number | null; actorId: string | null },
): Promise<void> {
  await ctx.assetEvents.insertOne({
    _id: randomUUID(),
    tenantId,
    assetId: e.assetId,
    branchId: e.branchId,
    type: e.type,
    date: e.date,
    from: e.from ?? null,
    to: e.to ?? null,
    note: e.note ?? null,
    cost: e.cost ?? null,
    actorId: e.actorId,
    createdAt: new Date(),
  })
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
