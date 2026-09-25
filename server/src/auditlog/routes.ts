import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import { parentsHiddenFromBranches } from '../parents/service.js'
import type { AuditLogDoc } from '../db.js'
import { authenticate, callerBranchIds, requirePermission } from '../auth/guard.js'

/**
 * Read side of the `auditLog` collection — every mutation across the app
 * already writes to it via `recordAudit()`; this is where it's read back.
 */

const filterQuery = z.object({
  entity: z.string().max(100).optional(),
  entityId: z.string().max(200).optional(),
  actorId: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
  branchId: z.string().optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  limit: z.string().optional(),
})

/** Shared between the list and export endpoints so the two can never
 * silently drift into showing different rows for the "same" filter. */
async function buildFilter(
  request: Parameters<typeof callerBranchIds>[0],
  query: z.infer<typeof filterQuery>,
): Promise<{ ok: true; filter: Filter<AuditLogDoc> } | { ok: false; error: string }> {
  const allowed = await callerBranchIds(request)
  if (query.branchId && allowed !== null && !allowed.includes(query.branchId)) {
    return { ok: false, error: 'BRANCH_FORBIDDEN' }
  }

  const filter: Filter<AuditLogDoc> = {}
  if (query.entity) filter.entity = query.entity
  if (query.entityId) filter.entityId = query.entityId
  if (query.actorId) filter.actorId = query.actorId
  if (query.action) filter.action = query.action
  if (query.branchId) filter.branchId = query.branchId
  else if (allowed !== null) {
    // SAMS 1.9: rows with no branch are tenant-wide (memberships, settings)
    // or parent records, which belong to branches only through their
    // children. A confined caller sees parent rows for families they can
    // see, and no other branchless rows.
    const hidden = await withTenant(request.auth!.tenantId!, (ctx) => parentsHiddenFromBranches(ctx, allowed))
    filter.$or = [
      { branchId: { $in: allowed } },
      { branchId: null, entity: 'parent', entityId: { $nin: [...hidden] } },
    ]
  }
  if (query.dateFrom || query.dateTo) {
    const range: { $gte?: Date; $lte?: Date } = {}
    if (query.dateFrom) range.$gte = new Date(`${query.dateFrom}T00:00:00.000Z`)
    if (query.dateTo) range.$lte = new Date(`${query.dateTo}T23:59:59.999Z`)
    filter.createdAt = range
  }
  return { ok: true, filter }
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function registerAuditLogRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requirePermission('audit.read')] }

  app.get('/audit-log', readGuard, async (request, reply) => {
    const parsed = filterQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const built = await buildFilter(request, parsed.data)
    if (!built.ok) return reply.code(403).send({ error: built.error })

    const limit = Math.min(Number(parsed.data.limit ?? 50), 200)
    const tenantId = request.auth!.tenantId!

    const entries = await withTenant(tenantId, (ctx) =>
      ctx.auditLog.find(built.filter).sort({ createdAt: -1 }).limit(limit).toArray(),
    )

    return reply.send({
      entries: entries.map((e) => ({
        id: e._id,
        actorId: e.actorId,
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        branchId: e.branchId,
        meta: e.meta,
        ip: e.ip ?? null,
        userAgent: e.userAgent ?? null,
        reason: e.reason ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
    })
  })

  /** Same filters as the list endpoint, unpaginated up to a hard cap — a
   * CSV export is a one-off download, not something a UI paginates. */
  app.get(
    '/audit-log/export',
    { preHandler: [authenticate, requirePermission('audit.export')] },
    async (request, reply) => {
      const parsed = filterQuery.safeParse(request.query)
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
      const built = await buildFilter(request, parsed.data)
      if (!built.ok) return reply.code(403).send({ error: built.error })

      const tenantId = request.auth!.tenantId!
      const entries = await withTenant(tenantId, (ctx) =>
        ctx.auditLog.find(built.filter).sort({ createdAt: -1 }).limit(10_000).toArray(),
      )

      const header = ['createdAt', 'actorId', 'action', 'entity', 'entityId', 'branchId', 'reason', 'ip', 'userAgent', 'meta']
      const rows = entries.map((e) =>
        [
          e.createdAt.toISOString(),
          e.actorId ?? '',
          e.action,
          e.entity ?? '',
          e.entityId ?? '',
          e.branchId ?? '',
          e.reason ?? '',
          e.ip ?? '',
          e.userAgent ?? '',
          JSON.stringify(e.meta),
        ]
          .map((cell) => csvEscape(String(cell)))
          .join(','),
      )
      const csv = [header.join(','), ...rows].join('\r\n')

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="audit-log-${Date.now()}.csv"`)
        .send(csv)
    },
  )
}
