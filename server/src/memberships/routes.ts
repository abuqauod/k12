import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { withTenant, withoutTenant } from '../db.js'
import { recordAudit } from '../audit.js'
import type { MembershipDoc } from '../db.js'
import { authenticate, callerScopes, loadCallerMembership, requirePermission } from '../auth/guard.js'
import { PRESETS, ROLE_KEYS, ROLE_SCOPES, scopesFor, type RoleKey } from '../auth/scopes.js'
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

const RANKS = ['owner', 'admin', 'scheduler', 'viewer'] as const

/** Either a plain rank (`role`) or a named preset (`roleKey`, SAMS 1.8) —
 * never both. `branchIds` may accompany a preset that must be
 * branch-confined. */
const grantShape = {
  role: z.enum(RANKS).optional(),
  roleKey: z.enum(ROLE_KEYS).optional(),
  branchIds: z.array(z.string().min(1)).nullable().optional(),
}
const oneOf = (v: { role?: unknown; roleKey?: unknown }) => (v.role === undefined) !== (v.roleKey === undefined)

const inviteBody = z
  .object({ email: z.string().email(), displayName: z.string().min(1).max(200).optional(), ...grantShape })
  .refine(oneOf)

const roleBody = z.object(grantShape).refine(oneOf)

/** `null` (or an empty array, normalised to null) means every branch. */
const branchesBody = z.object({
  branchIds: z.array(z.string().min(1)).nullable(),
})

type Grant = { role: MembershipDoc['role']; roleKey: RoleKey | null; branchIds: string[] | null | undefined }
type GrantCheck = { ok: true; grant: Grant } | { ok: false; status: number; error: string; required?: string }

/**
 * The rules every role grant passes, whether by invite or by change:
 *  - only an owner can hand out ownership;
 *  - nobody can grant a scope they don't hold themselves (no escalation);
 *  - a branch-confined preset needs at least one known branch.
 * `currentBranchIds` is the target's existing confinement, for a change that
 * doesn't restate it.
 */
async function checkGrant(
  request: FastifyRequest,
  body: z.infer<typeof roleBody>,
  currentBranchIds: string[] | null,
): Promise<GrantCheck> {
  const roleKey = body.roleKey ?? null
  const role = roleKey ? PRESETS[roleKey].rank : body.role!

  // The live membership, not the token: a just-demoted owner's JWT still
  // says owner for up to 15 minutes.
  const callerRole = (await loadCallerMembership(request))?.role ?? request.auth!.role
  if (role === 'owner' && callerRole !== 'owner') {
    return { ok: false, status: 403, error: 'FORBIDDEN', required: 'owner' }
  }

  const held = await callerScopes(request)
  for (const scope of scopesFor(role, roleKey)) {
    if (!held.has(scope)) return { ok: false, status: 403, error: 'SCOPE_ESCALATION', required: scope }
  }

  const given = body.branchIds === undefined ? undefined : body.branchIds?.length ? body.branchIds : null
  // A body that states branchIds (even null) is what gets written, so it
  // alone must satisfy the rule; otherwise the existing confinement stays.
  const effective = body.branchIds !== undefined ? given : currentBranchIds
  if (roleKey && PRESETS[roleKey].requiresBranches && !effective?.length) {
    return { ok: false, status: 400, error: 'BRANCHES_REQUIRED' }
  }
  if (given) {
    const known = await withoutTenant((db) =>
      db.branches.find({ tenantId: request.auth!.tenantId!, _id: { $in: given } }).toArray(),
    )
    if (known.length !== given.length) return { ok: false, status: 400, error: 'UNKNOWN_BRANCH' }
  }
  return { ok: true, grant: { role, roleKey, branchIds: given } }
}

export function registerMembershipRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: [authenticate, requirePermission('memberships.manage')] }

  app.get('/memberships', guarded, async (request, reply) => {
    const members = await listMembers(request.auth!.tenantId!)
    return reply.send({ members })
  })

  /** What each rank and preset grants — the Team settings preview reads
   * this, so the UI can never drift from what the server enforces. */
  app.get('/memberships/roles', guarded, async (_request, reply) => {
    return reply.send({
      ranks: RANKS.map((rank) => ({ rank, scopes: [...ROLE_SCOPES[rank]].sort() })),
      presets: ROLE_KEYS.map((key) => ({
        key,
        rank: PRESETS[key].rank,
        requiresBranches: PRESETS[key].requiresBranches,
        scopes: [...PRESETS[key].scopes].sort(),
      })),
    })
  })

  app.post('/memberships/invite', guarded, async (request, reply) => {
    const parsed = inviteBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const check = await checkGrant(request, parsed.data, null)
    if (!check.ok) return reply.code(check.status).send({ error: check.error, required: check.required })

    const tenantId = request.auth!.tenantId!
    const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
    if (!tenant) return reply.code(404).send({ error: 'UNKNOWN_TENANT' })

    try {
      const invite = await inviteUserToTenant({
        email: parsed.data.email,
        tenantId,
        tenantName: tenant.name,
        role: check.grant.role,
        roleKey: check.grant.roleKey,
        branchIds: check.grant.branchIds ?? null,
        inviterName: request.auth!.email,
        displayName: parsed.data.displayName,
      })
      if (invite.outcome !== 'already_member') {
        await withTenant(tenantId, (ctx) =>
          recordAudit(ctx.auditLog, {
            actorId: request.auth!.sub,
            action: 'membership.invite',
            entity: 'membership',
            entityId: invite.userId,
            after: { email: parsed.data.email, role: check.grant.role, roleKey: check.grant.roleKey, branchIds: check.grant.branchIds ?? null },
          }),
        )
      }
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

    const tenantId = request.auth!.tenantId!
    const target = await withoutTenant((db) => db.memberships.findOne({ _id: `${tenantId}:${userId}` }))
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND' })

    const check = await checkGrant(request, parsed.data, target.branchIds ?? null)
    if (!check.ok) return reply.code(check.status).send({ error: check.error, required: check.required })

    const { role, roleKey, branchIds } = check.grant
    const result = await changeMemberRole(tenantId, userId, role, roleKey, request.auth!.sub, branchIds)
    if (result === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    if (result === 'last_owner') return reply.code(409).send({ error: 'CANNOT_DEMOTE_LAST_OWNER' })
    return reply.send({ ok: true })
  })

  app.patch('/memberships/:userId/branches', guarded, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const parsed = branchesBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const tenantId = request.auth!.tenantId!
    const branchIds = parsed.data.branchIds && parsed.data.branchIds.length > 0 ? parsed.data.branchIds : null
    if (branchIds) {
      const known = await withoutTenant((db) =>
        db.branches.find({ tenantId, _id: { $in: branchIds } }).toArray(),
      )
      if (known.length !== branchIds.length) return reply.code(400).send({ error: 'UNKNOWN_BRANCH' })
    } else {
      const target = await withoutTenant((db) => db.memberships.findOne({ _id: `${tenantId}:${userId}` }))
      if (target?.roleKey && PRESETS[target.roleKey]?.requiresBranches) {
        return reply.code(400).send({ error: 'BRANCHES_REQUIRED' })
      }
    }

    const result = await setMemberBranches(tenantId, userId, branchIds, request.auth!.sub)
    if (result === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send({ ok: true, branchIds })
  })

  app.delete('/memberships/:userId', guarded, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    const tenantId = request.auth!.tenantId!
    const before = await withoutTenant((db) => db.memberships.findOne({ _id: `${tenantId}:${userId}` }))
    const result = await removeMember(tenantId, userId)
    if (result === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    if (result === 'last_owner') return reply.code(409).send({ error: 'CANNOT_REMOVE_LAST_OWNER' })
    await withTenant(tenantId, (ctx) =>
      recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'membership.remove',
        entity: 'membership',
        entityId: userId,
        before,
        after: null,
      }),
    )
    return reply.code(204).send()
  })
}
