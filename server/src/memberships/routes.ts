import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withoutTenant } from '../db.js'
import { authenticate, requireRole } from '../auth/guard.js'
import { EmailNotConfiguredError } from '../email.js'
import { inviteUserToTenant } from './invite.js'
import { changeMemberRole, listMembers, removeMember, setMemberBranches } from './service.js'

/**
 * A school managing its own staff — distinct from `/admin/*`, which is the
 * vendor operating across schools. Everything here is scoped to the caller's
 * own `tenantId` (from the JWT), never a parameter, so one school's admin
 * can't reach into another's roster by changing an id in the URL. The
 * platform-admin equivalent (`admin/routes.ts`) calls the same
 * `service.ts` functions with a tenant id from the URL instead.
 */

const inviteBody = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'scheduler', 'viewer']),
  displayName: z.string().min(1).max(200).optional(),
})

const roleBody = z.object({ role: z.enum(['owner', 'admin', 'scheduler', 'viewer']) })

/** `null` (or an empty array, normalised to null) means every branch. */
const branchesBody = z.object({
  branchIds: z.array(z.string().min(1)).nullable(),
})

export function registerMembershipRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: [authenticate, requireRole('admin')] }

  app.get('/memberships', guarded, async (request, reply) => {
    const members = await listMembers(request.auth!.tenantId!)
    return reply.send({ members })
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

    const result = await changeMemberRole(request.auth!.tenantId!, userId, parsed.data.role)
    if (result === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    if (result === 'last_owner') return reply.code(409).send({ error: 'CANNOT_DEMOTE_LAST_OWNER' })
    return reply.send({ ok: true })
  })

  app.patch('/memberships/:userId/branches', guarded, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const parsed = branchesBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const branchIds = parsed.data.branchIds && parsed.data.branchIds.length > 0 ? parsed.data.branchIds : null
    if (branchIds) {
      const known = await withoutTenant((db) =>
        db.branches.find({ tenantId: request.auth!.tenantId!, _id: { $in: branchIds } }).toArray(),
      )
      if (known.length !== branchIds.length) return reply.code(400).send({ error: 'UNKNOWN_BRANCH' })
    }

    const result = await setMemberBranches(request.auth!.tenantId!, userId, branchIds)
    if (result === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send({ ok: true, branchIds })
  })

  app.delete('/memberships/:userId', guarded, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const result = await removeMember(request.auth!.tenantId!, userId)
    if (result === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    if (result === 'last_owner') return reply.code(409).send({ error: 'CANNOT_REMOVE_LAST_OWNER' })
    return reply.code(204).send()
  })
}
