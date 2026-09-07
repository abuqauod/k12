import type { FastifyInstance } from 'fastify'
import { withTenant } from '../db.js'
import { authenticate, requireRole } from '../auth/guard.js'

/**
 * Read side of the `auditLog` collection — every dataset create/update
 * already writes to it (see datasets/routes.ts); this is just the first
 * place anything reads it back.
 */
export function registerAuditLogRoutes(app: FastifyInstance): void {
  app.get(
    '/audit-log',
    { preHandler: [authenticate, requireRole('admin')] },
    async (request, reply) => {
      const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 50), 200)
      const tenantId = request.auth!.tenantId!

      const entries = await withTenant(tenantId, (ctx) =>
        ctx.auditLog.find().sort({ createdAt: -1 }).limit(limit).toArray(),
      )

      return reply.send({
        entries: entries.map((e) => ({
          id: e._id,
          actorId: e.actorId,
          action: e.action,
          entity: e.entity,
          entityId: e.entityId,
          meta: e.meta,
          createdAt: e.createdAt.toISOString(),
        })),
      })
    },
  )
}
