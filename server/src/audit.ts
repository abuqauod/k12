import { randomUUID } from 'node:crypto'
import type { AuditLogDoc, TenantScope } from './db.js'
import { currentRequestContext } from './requestContext.js'

/**
 * One place to append to `auditLog`. For a sensitive mutation (an
 * enrollment change, a transfer, a guardian edit, an attendance correction,
 * a role/branch assignment) pass `before` / `after` — they land in `meta`
 * so the log answers "what did this look like before" without a second
 * system. `before` is null for a create; `after` is null for a delete.
 *
 * Call it inside the same `withTenant` transaction as the write it records,
 * so the two commit together or not at all.
 */
export async function recordAudit(
  auditLog: TenantScope<AuditLogDoc>,
  entry: {
    actorId: string | null
    action: string
    entity: string
    entityId: string
    /** The branch this mutation belongs to, when the entity has one — lets
     * the audit feed be branch-filtered the same way finance/attendance
     * already are. Omitted (not just `null`) for genuinely tenant-wide
     * actions (a parent's own profile, membership changes, tenant
     * settings) — those have no branch to attribute. Rows recorded before
     * this field existed are never backfilled (`null`), same "kept as
     * written" convention as `AttendanceRecordDoc`. */
    branchId?: string | null
    before?: unknown
    after?: unknown
    meta?: Record<string, unknown>
    /** Required by the route on sensitive actions (void, withdraw, delete). */
    reason?: string | null
  },
): Promise<void> {
  const context = currentRequestContext()
  const meta: Record<string, unknown> = { ...(entry.meta ?? {}) }
  if ('before' in entry) meta.before = entry.before ?? null
  if ('after' in entry) meta.after = entry.after ?? null
  await auditLog.insertOne({
    _id: randomUUID(),
    actorId: entry.actorId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    branchId: entry.branchId ?? null,
    meta,
    ip: context.ip,
    userAgent: context.userAgent,
    reason: entry.reason ?? context.reason ?? null,
    createdAt: new Date(),
  })
}
