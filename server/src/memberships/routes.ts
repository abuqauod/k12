import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withoutTenant, withTenant } from '../db.js'
import { authenticate, requireRole } from '../auth/guard.js'
import { EmailNotConfiguredError } from '../email.js'
import { inviteUserToTenant } from './invite.js'

/**
 * A school managing its own staff — distinct from `/admin/*`, which is the
 * vendor operating across schools. Everything here is scoped to the caller's
 * own `tenantId` (from the JWT), never a parameter, so one school's admin
 * can't reach into another's roster by changing an id in the URL.
 */

const inviteBody = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'scheduler', 'viewer']),
  displayName: z.string().min(1).max(200).optional(),
})

const roleBody = z.object({ role: z.enum(['owner', 'admin', 'scheduler', 'viewer']) })

export function registerMembershipRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: [authenticate, requireRole('admin')] }

  app.get('/memberships', guarded, async (request, reply) => {
    const tenantId = request.auth!.tenantId!
    const memberships = await withTenant(tenantId, (ctx) => ctx.memberships.find().toArray())
    const users = await withoutTenant((db) =>
      db.users.find({ _id: { $in: memberships.map((m) => m.userId) } }).toArray(),
    )
    const byId = new Map(users.map((u) => [u._id, u]))

    return reply.send({
      members: memberships.map((m) => {
        const user = byId.get(m.userId)
        return {
          userId: m.userId,
          role: m.role,
          email: user?.email ?? null,
          displayName: user?.displayName ?? null,
          active: user?.active ?? false,
        }
      }),
    })
  })

  app.post('/memberships/invite', guarded, async (request, reply) => {
    const parsed = inviteBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    // Only an owner can create another owner — an admin can invite anyone up
    // to (and including) admin, but not hand out ownership of the school.
    if (parsed.data.role === 'owner' && request.auth!.role !== 'owner') {
      return reply.code(403).send({ error: 'FORBIDDEN', required: 'owner' })
    }

    const tenantId = request.auth!.tenantId!
    const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
    if (!tenant) return reply.code(404).send({ error: 'UNKNOWN_TENANT' })

    try {
      const invite = await inviteUserToTenant({
        email: parsed.data.email,
        tenantId,
        tenantName: tenant.name,
        role: parsed.data.role,
        inviterName: request.auth!.email,
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

  app.patch('/memberships/:userId', guarded, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const parsed = roleBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    if (parsed.data.role === 'owner' && request.auth!.role !== 'owner') {
      return reply.code(403).send({ error: 'FORBIDDEN', required: 'owner' })
    }

    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, async (ctx) => {
      const target = await ctx.memberships.findOne({ userId })
      if (!target) return { kind: 'not_found' as const }

      if (target.role === 'owner' && parsed.data.role !== 'owner') {
        const owners = await ctx.memberships.find({ role: 'owner' }).toArray()
        if (owners.length <= 1) return { kind: 'last_owner' as const }
      }

      await ctx.memberships.findOneAndUpdate({ userId }, { $set: { role: parsed.data.role } })
      return { kind: 'ok' as const }
    })

    if (result.kind === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    if (result.kind === 'last_owner') {
      return reply.code(409).send({ error: 'CANNOT_DEMOTE_LAST_OWNER' })
    }
    return reply.send({ ok: true })
  })

  app.delete('/memberships/:userId', guarded, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const tenantId = request.auth!.tenantId!

    const result = await withTenant(tenantId, async (ctx) => {
      const target = await ctx.memberships.findOne({ userId })
      if (!target) return { kind: 'not_found' as const }

      if (target.role === 'owner') {
        const owners = await ctx.memberships.find({ role: 'owner' }).toArray()
        if (owners.length <= 1) return { kind: 'last_owner' as const }
      }

      return { kind: 'ok' as const }
    })

    if (result.kind === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    if (result.kind === 'last_owner') {
      return reply.code(409).send({ error: 'CANNOT_REMOVE_LAST_OWNER' })
    }

    // The actual delete happens outside the transaction above — TenantScope
    // has no delete method (deliberately: it's the one write dataset/audit
    // code never needs, so it was never added). Revoking sessions is
    // best-effort, done in the same pass since both are unscoped writes.
    await withoutTenant(async (db) => {
      await db.memberships.deleteOne({ _id: `${tenantId}:${userId}` })
      await db.refreshTokens.updateMany(
        { userId, tenantId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
    })
    return reply.code(204).send()
  })
}
