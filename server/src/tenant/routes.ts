import type { FastifyInstance } from 'fastify'
import { withoutTenant } from '../db.js'
import { authenticate, requirePermission } from '../auth/guard.js'

/**
 * The tenant's own organization profile and subscription status —
 * READ ONLY, same reasoning as branches/routes.ts: `name`/`plan`/`status`/
 * `seats`/`validUntil`/`graceDays` are a vendor-provisioning concern
 * (`admin/routes.ts`'s `PATCH /admin/tenants/:id` is the only write
 * surface), not something this route ever accepts a change to.
 *
 * Deliberately does NOT require `requireActiveSubscription` — the whole
 * point is that a school with a lapsed subscription can still see why
 * (`status`/`validUntil`/`graceDays`) instead of only ever learning it as
 * the error payload of some other blocked request. Every other tenant
 * route already staying gated by `requireActiveSubscription` is correct;
 * this one route is the deliberate exception.
 */
export function registerTenantRoutes(app: FastifyInstance): void {
  app.get(
    '/tenant',
    { preHandler: [authenticate, requirePermission('settings.read')] },
    async (request, reply) => {
      const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: request.auth!.tenantId! }))
      if (!tenant) return reply.code(404).send({ error: 'UNKNOWN_TENANT' })
      return reply.send({
        id: tenant._id,
        name: tenant.name,
        plan: tenant.plan,
        status: tenant.status,
        validUntil: tenant.validUntil,
        graceDays: tenant.graceDays,
      })
    },
  )
}
