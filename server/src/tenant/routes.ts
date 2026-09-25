import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant, withoutTenant } from '../db.js'
import type { TenantProfile } from '../db.js'
import { authenticate, requireActiveSubscription, requirePermission } from '../auth/guard.js'
import { recordAudit } from '../audit.js'

/**
 * The tenant's own organization profile and subscription status.
 *
 * `name`/`plan`/`status`/`seats`/`validUntil`/`graceDays` are a
 * vendor-provisioning concern (`admin/routes.ts`'s `PATCH /admin/tenants/:id`
 * is their only write surface). The school itself may edit only `profile`
 * (contact details, SAMS 1.11) — the PATCH schema is strict, so any other
 * field is rejected rather than ignored.
 *
 * GET deliberately does NOT require `requireActiveSubscription` — a school
 * with a lapsed subscription can still see why (`status`/`validUntil`/
 * `graceDays`) instead of only ever learning it as the error payload of
 * some other blocked request.
 */

const EMPTY_PROFILE: TenantProfile = {
  nameAr: null,
  phone: null,
  email: null,
  address: null,
  website: null,
  taxNumber: null,
}

const text = (max: number) => z.string().trim().max(max).nullable()

const profileBody = z
  .object({
    profile: z
      .object({
        nameAr: text(200),
        phone: text(40),
        email: z.string().trim().email().max(200).nullable(),
        address: text(500),
        website: text(200),
        taxNumber: text(60),
      })
      .partial()
      .strict(),
  })
  .strict()

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
        profile: { ...EMPTY_PROFILE, ...tenant.profile },
      })
    },
  )

  app.patch(
    '/tenant',
    { preHandler: [authenticate, requireActiveSubscription, requirePermission('settings.manage')] },
    async (request, reply) => {
      const parsed = profileBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
      const tenantId = request.auth!.tenantId!
      const before = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
      if (!before) return reply.code(404).send({ error: 'UNKNOWN_TENANT' })
      // Blank strings are stored as null, so "cleared" has one representation.
      const changes = Object.fromEntries(
        Object.entries(parsed.data.profile).map(([key, value]) => [key, value === '' ? null : value]),
      )
      const profile: TenantProfile = { ...EMPTY_PROFILE, ...before.profile, ...changes }
      await withoutTenant((db) =>
        db.tenants.updateOne({ _id: tenantId }, { $set: { profile, updatedAt: new Date() } }),
      )
      await withTenant(tenantId, (ctx) =>
        recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'tenant.profile.update',
          entity: 'tenant',
          entityId: tenantId,
          before: before.profile ?? EMPTY_PROFILE,
          after: profile,
        }),
      )
      return reply.send({ profile })
    },
  )
}
