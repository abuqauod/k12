import { withoutTenant, withTenant } from '../db.js'
import type { MembershipDoc } from '../db.js'
import { recordAudit } from '../audit.js'

/**
 * Shared by the self-service API (`/memberships`, tenantId from the
 * caller's own JWT) and the platform-admin API
 * (`/admin/tenants/:id/members`, tenantId from the URL) — same operations,
 * reached two ways, so this is the one implementation both call into.
 */

export interface MemberSummary {
  userId: string
  role: MembershipDoc['role']
  /** Named preset (SAMS 1.8), or null for a plain rank. */
  roleKey: MembershipDoc['roleKey']
  email: string | null
  displayName: string | null
  active: boolean
  emailVerified: boolean
  /** null = every branch (the owner/admin default). */
  branchIds: string[] | null
}

export async function listMembers(tenantId: string): Promise<MemberSummary[]> {
  const memberships = await withTenant(tenantId, (ctx) => ctx.memberships.find().toArray())
  const users = await withoutTenant((db) =>
    db.users.find({ _id: { $in: memberships.map((m) => m.userId) } }).toArray(),
  )
  const byId = new Map(users.map((u) => [u._id, u]))
  return memberships.map((m) => {
    const user = byId.get(m.userId)
    return {
      userId: m.userId,
      role: m.role,
      roleKey: m.roleKey ?? null,
      email: user?.email ?? null,
      displayName: user?.displayName ?? null,
      active: user?.active ?? false,
      emailVerified: user?.emailVerified ?? false,
      branchIds: m.branchIds ?? null,
    }
  })
}

/**
 * Confine a member to specific branches, or (null) give them every branch.
 * A no-op-safe unscoped write with an explicit compound id, same pattern as
 * `removeMember`.
 */
export async function setMemberBranches(
  tenantId: string,
  userId: string,
  branchIds: string[] | null,
  actorId: string | null = null,
): Promise<'ok' | 'not_found'> {
  return withTenant(tenantId, async (ctx) => {
    const before = await ctx.memberships.findOne({ userId })
    if (!before) return 'not_found'
    await ctx.memberships.findOneAndUpdate({ userId }, { $set: { branchIds } })
    await recordAudit(ctx.auditLog, {
      actorId,
      action: 'membership.branches',
      entity: 'membership',
      entityId: userId,
      before: { branchIds: before.branchIds ?? null },
      after: { branchIds },
    })
    return 'ok' as const
  })
}

export type RoleChangeResult = 'ok' | 'not_found' | 'last_owner'

/**
 * Refuses to leave a tenant with zero owners — checked and applied inside
 * one transaction so a concurrent change can't slip through between the
 * check and the write.
 */
export async function changeMemberRole(
  tenantId: string,
  userId: string,
  role: MembershipDoc['role'],
  /** Null clears any preset — a plain rank change. */
  roleKey: MembershipDoc['roleKey'] = null,
  actorId: string | null = null,
  /** Set together with a preset that must be branch-confined. */
  branchIds?: string[] | null,
): Promise<RoleChangeResult> {
  return withTenant(tenantId, async (ctx) => {
    const target = await ctx.memberships.findOne({ userId })
    if (!target) return 'not_found'

    if (target.role === 'owner' && role !== 'owner') {
      const owners = await ctx.memberships.find({ role: 'owner' }).toArray()
      if (owners.length <= 1) return 'last_owner'
    }

    await ctx.memberships.findOneAndUpdate(
      { userId },
      { $set: { role, roleKey, ...(branchIds !== undefined ? { branchIds } : {}) } },
    )
    await recordAudit(ctx.auditLog, {
      actorId,
      action: 'membership.role',
      entity: 'membership',
      entityId: userId,
      before: { role: target.role, roleKey: target.roleKey ?? null, branchIds: target.branchIds ?? null },
      after: { role, roleKey, branchIds: branchIds !== undefined ? branchIds : (target.branchIds ?? null) },
    })
    return 'ok'
  })
}

export type RemoveMemberResult = 'ok' | 'not_found' | 'last_owner'

export async function removeMember(tenantId: string, userId: string): Promise<RemoveMemberResult> {
  const check = await withTenant(tenantId, async (ctx) => {
    const target = await ctx.memberships.findOne({ userId })
    if (!target) return 'not_found' as const
    if (target.role === 'owner') {
      const owners = await ctx.memberships.find({ role: 'owner' }).toArray()
      if (owners.length <= 1) return 'last_owner' as const
    }
    return 'ok' as const
  })
  if (check !== 'ok') return check

  // TenantScope has no delete method (deliberately — see db.ts), so the
  // actual removal is an unscoped write with an explicit tenantId, same
  // pattern used everywhere else a membership write happens outside a
  // TenantScope-covered transaction. Revoking sessions is best-effort, done
  // in the same pass since both are unscoped writes.
  await withoutTenant(async (db) => {
    await db.memberships.deleteOne({ _id: `${tenantId}:${userId}` })
    await db.refreshTokens.updateMany(
      { userId, tenantId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    )
  })
  return 'ok'
}
