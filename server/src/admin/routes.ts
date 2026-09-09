import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withoutTenant } from '../db.js'
import { authenticate, requirePlatformAdmin } from '../auth/guard.js'
import { EmailNotConfiguredError } from '../email.js'
import { inviteUserToTenant } from '../memberships/invite.js'
import { changeMemberRole, listMembers, removeMember } from '../memberships/service.js'
import { createApiKey, listApiKeys, revokeApiKey } from '../apikeys/service.js'

/**
 * The vendor's own console: onboarding a school, recording an offline
 * payment (extending `validUntil`), suspending one that lapsed. Every route
 * here is gated by `requirePlatformAdmin`, not any tenant role — this is the
 * one part of the API that operates across tenants by design.
 */

const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens only')

const createTenantBody = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(200),
  plan: z.string().min(1).max(50).default('standard'),
  seats: z.number().int().positive().default(25),
  validUntil: z.string().date().nullable().default(null),
  graceDays: z.number().int().nonnegative().default(21),
  ownerEmail: z.string().email(),
  ownerName: z.string().min(1).max(200).optional(),
})

const updateTenantBody = z
  .object({
    name: z.string().min(1).max(200),
    plan: z.string().min(1).max(50),
    status: z.enum(['active', 'suspended', 'cancelled']),
    seats: z.number().int().positive(),
    validUntil: z.string().date().nullable(),
    graceDays: z.number().int().nonnegative(),
  })
  .partial()

const inviteBody = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'scheduler', 'viewer']),
  displayName: z.string().min(1).max(200).optional(),
})

const roleBody = z.object({ role: z.enum(['owner', 'admin', 'scheduler', 'viewer']) })

const createKeyBody = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'scheduler', 'viewer']),
})

export function registerAdminRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: [authenticate, requirePlatformAdmin] }

  app.get('/admin/tenants', guarded, async (_request, reply) => {
    const tenants = await withoutTenant((db) => db.tenants.find().sort({ createdAt: -1 }).toArray())
    const counts = await withoutTenant((db) =>
      db.memberships.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$tenantId', count: { $sum: 1 } } },
      ]).toArray(),
    )
    const countByTenant = new Map(counts.map((c) => [c._id, c.count]))

    return reply.send({
      tenants: tenants.map((t) => ({
        id: t._id,
        slug: t.slug,
        name: t.name,
        plan: t.plan,
        status: t.status,
        seats: t.seats,
        memberCount: countByTenant.get(t._id) ?? 0,
        validUntil: t.validUntil,
        graceDays: t.graceDays,
        createdAt: t.createdAt.toISOString(),
      })),
    })
  })

  app.get('/admin/tenants/:id', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: id }))
    if (!tenant) return reply.code(404).send({ error: 'NOT_FOUND' })

    const members = await listMembers(id)

    return reply.send({
      id: tenant._id,
      slug: tenant.slug,
      name: tenant.name,
      plan: tenant.plan,
      status: tenant.status,
      seats: tenant.seats,
      validUntil: tenant.validUntil,
      graceDays: tenant.graceDays,
      createdAt: tenant.createdAt.toISOString(),
      members,
    })
  })

  app.post('/admin/tenants', guarded, async (request, reply) => {
    const parsed = createTenantBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const body = parsed.data

    const existing = await withoutTenant((db) => db.tenants.findOne({ slug: body.slug }))
    if (existing) return reply.code(409).send({ error: 'SLUG_TAKEN' })

    const _id = randomUUID()
    const now = new Date()
    await withoutTenant((db) =>
      db.tenants.insertOne({
        _id,
        slug: body.slug,
        name: body.name,
        plan: body.plan,
        status: 'active',
        seats: body.seats,
        validUntil: body.validUntil,
        graceDays: body.graceDays,
        createdAt: now,
        updatedAt: now,
      }),
    )

    try {
      const invite = await inviteUserToTenant({
        email: body.ownerEmail,
        tenantId: _id,
        tenantName: body.name,
        role: 'owner',
        inviterName: 'K-12 Timetable Studio',
        displayName: body.ownerName,
      })
      return reply.code(201).send({ id: _id, slug: body.slug, ownerInvite: invite.outcome })
    } catch (error) {
      // The tenant exists even if the invite email failed to send — that's
      // recoverable (re-invite the owner), unlike leaving no tenant at all.
      if (error instanceof EmailNotConfiguredError) {
        return reply.code(201).send({ id: _id, slug: body.slug, ownerInvite: 'EMAIL_NOT_CONFIGURED' })
      }
      request.log.error(error, 'failed to send owner invite email')
      return reply.code(201).send({ id: _id, slug: body.slug, ownerInvite: 'EMAIL_SEND_FAILED' })
    }
  })

  app.patch('/admin/tenants/:id', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateTenantBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })

    const result = await withoutTenant((db) =>
      db.tenants.findOneAndUpdate(
        { _id: id },
        { $set: { ...parsed.data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      ),
    )
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send({
      id: result._id,
      slug: result.slug,
      name: result.name,
      plan: result.plan,
      status: result.status,
      seats: result.seats,
      validUntil: result.validUntil,
      graceDays: result.graceDays,
    })
  })

  /** Support path: a platform admin adding someone directly, bypassing the
   * tenant's own admins — e.g. helping a school that's locked itself out. */
  app.post('/admin/tenants/:id/invite', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = inviteBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: id }))
    if (!tenant) return reply.code(404).send({ error: 'NOT_FOUND' })

    try {
      const invite = await inviteUserToTenant({
        email: parsed.data.email,
        tenantId: id,
        tenantName: tenant.name,
        role: parsed.data.role,
        inviterName: 'K-12 Timetable Studio',
        displayName: parsed.data.displayName,
      })
      return reply.send({ outcome: invite.outcome })
    } catch (error) {
      if (error instanceof EmailNotConfiguredError) {
        return reply.code(501).send({ error: 'EMAIL_NOT_CONFIGURED' })
      }
      request.log.error(error, 'failed to send invite email')
      return reply.code(502).send({ error: 'EMAIL_SEND_FAILED' })
    }
  })

  // ------------------------------------------------------------- members --
  // A platform admin isn't held to the tenant self-service "only an owner
  // can grant owner" rule below — they're already fully trusted with this
  // school's data, so there's no extra permission to protect here beyond
  // the last-owner safety guard every path shares (see memberships/service.ts).

  app.patch('/admin/tenants/:id/members/:userId', guarded, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string }
    const parsed = roleBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const result = await changeMemberRole(id, userId, parsed.data.role)
    if (result === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    if (result === 'last_owner') return reply.code(409).send({ error: 'CANNOT_DEMOTE_LAST_OWNER' })
    return reply.send({ ok: true })
  })

  app.delete('/admin/tenants/:id/members/:userId', guarded, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string }
    const result = await removeMember(id, userId)
    if (result === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    if (result === 'last_owner') return reply.code(409).send({ error: 'CANNOT_REMOVE_LAST_OWNER' })
    return reply.code(204).send()
  })

  // ------------------------------------------------------------ api keys --

  app.get('/admin/tenants/:id/api-keys', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const keys = await listApiKeys(id)
    return reply.send({ keys })
  })

  app.post('/admin/tenants/:id/api-keys', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = createKeyBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const created = await createApiKey(id, parsed.data.name, parsed.data.role, request.auth!.sub)
    return reply.code(201).send(created)
  })

  app.delete('/admin/tenants/:id/api-keys/:keyId', guarded, async (request, reply) => {
    const { id, keyId } = request.params as { id: string; keyId: string }
    const found = await revokeApiKey(id, keyId)
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.code(204).send()
  })
}
