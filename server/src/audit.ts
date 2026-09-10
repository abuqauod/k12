import { randomUUID } from 'node:crypto'
import type { AuditLogDoc, TenantScope } from './db.js'

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
    before?: unknown
    after?: unknown
    meta?: Record<string, unknown>
  },
): Promise<void> {
  const meta: Record<string, unknown> = { ...(entry.meta ?? {}) }
  if ('before' in entry) meta.before = entry.before ?? null
  if ('after' in entry) meta.after = entry.after ?? null
  await auditLog.insertOne({
    _id: randomUUID(),
    actorId: entry.actorId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    meta,
    createdAt: new Date(),
  })
}
