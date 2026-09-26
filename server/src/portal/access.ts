import { randomUUID } from 'node:crypto'
import { withTenant, withoutTenant } from '../db.js'
import type { ParentDoc, UserDoc } from '../db.js'
import { createActionToken, INVITE_TTL_MS } from '../auth/actionTokens.js'
import { PARENT_ROLE_KEY } from '../auth/scopes.js'
import { EmailNotConfiguredError, sendAccessGrantedEmail, sendInviteEmail } from '../email.js'
import { recordAudit } from '../audit.js'

/**
 * SAMS 6.4: a parent's portal login. Enabling the portal for a parent on
 * file gives their email a login with the `parent` preset — whose only
 * scope is `portal.parent` — and records the user on the parent
 * (`ParentDoc.portalAccess.userId`). A parent who has never set a password
 * gets an invite link; one who already has an account (at another school
 * using the product) just gains access.
 *
 * What they then see is limited twice over: the portal routes look the
 * parent up from the signed-in user, and only students whose link grants
 * portal access are shown.
 */

export type AccountState = 'none' | 'invited' | 'active' | 'disabled'

export interface PortalStatus {
  enabled: boolean
  email: string | null
  account: AccountState
  lastLoginAt: string | null
}

export async function portalStatus(parent: ParentDoc): Promise<PortalStatus> {
  const userId = parent.portalAccess?.userId ?? null
  const user = userId ? await withoutTenant((db) => db.users.findOne({ _id: userId })) : null
  let account: AccountState = 'none'
  if (user) account = !parent.portalAccess.enabled ? 'disabled' : user.passwordHash ? 'active' : 'invited'
  return {
    enabled: Boolean(parent.portalAccess?.enabled && user),
    email: user?.email ?? parent.email,
    account,
    lastLoginAt: user?.lastLoginAt?.toISOString() ?? null,
  }
}

export type EnableResult =
  | { ok: true; emailSent: boolean; emailError: string | null; outcome: 'invited' | 'added' }
  | { ok: false; error: 'EMAIL_REQUIRED' | 'PARENT_INACTIVE' | 'EMAIL_IS_STAFF' | 'EMAIL_IN_USE' }

async function sendInvite(user: UserDoc, tenantId: string, tenantName: string, inviterName: string) {
  const token = await createActionToken({
    userId: user._id,
    purpose: 'invite',
    grant: { tenantId, role: 'viewer', roleKey: PARENT_ROLE_KEY, branchIds: null },
    ttlMs: INVITE_TTL_MS,
  })
  try {
    await sendInviteEmail({ to: user.email, tenantName, inviterName, token })
    return { emailSent: true, emailError: null }
  } catch (error) {
    return {
      emailSent: false,
      emailError: error instanceof EmailNotConfiguredError ? 'EMAIL_NOT_CONFIGURED' : 'EMAIL_SEND_FAILED',
    }
  }
}

export async function enablePortal(params: {
  tenantId: string
  parent: ParentDoc
  actorId: string
  inviterName: string
}): Promise<EnableResult> {
  const { tenantId, parent } = params
  if (parent.status !== 'active') return { ok: false, error: 'PARENT_INACTIVE' }
  if (!parent.email) return { ok: false, error: 'EMAIL_REQUIRED' }
  const email = parent.email.toLowerCase()
  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))

  const prepared = await withoutTenant(async (db) => {
    let user = await db.users.findOne({ email })
    if (user) {
      const membership = await db.memberships.findOne({ _id: `${tenantId}:${user._id}` })
      if (membership && membership.roleKey !== PARENT_ROLE_KEY) return { error: 'EMAIL_IS_STAFF' as const }
      const userId = user._id
      const other = await withTenant(tenantId, (ctx) =>
        ctx.parents.findOne({ 'portalAccess.userId': userId, _id: { $ne: parent._id } }),
      )
      if (other) return { error: 'EMAIL_IN_USE' as const }
    } else {
      const _id = randomUUID()
      await db.users.insertOne({
        _id,
        email,
        passwordHash: null,
        displayName: parent.fullName,
        displayNameAr: parent.fullNameAr,
        active: false,
        platformAdmin: false,
        emailVerified: false,
        createdAt: new Date(),
        lastLoginAt: null,
      })
      user = (await db.users.findOne({ _id }))!
    }
    await db.memberships.updateOne(
      { _id: `${tenantId}:${user._id}` },
      {
        $set: { tenantId, userId: user._id, role: 'viewer', roleKey: PARENT_ROLE_KEY, branchIds: null },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    )
    return { user }
  })
  if ('error' in prepared) return { ok: false, error: prepared.error! }
  const user = prepared.user

  await withTenant(tenantId, async (ctx) => {
    await ctx.parents.findOneAndUpdate(
      { _id: parent._id },
      { $set: { portalAccess: { enabled: true, userId: user._id }, updatedAt: new Date() } },
    )
    await recordAudit(ctx.auditLog, {
      actorId: params.actorId,
      action: 'parent.portal.enable',
      entity: 'parent',
      entityId: parent._id,
      before: { portalAccess: parent.portalAccess },
      after: { portalAccess: { enabled: true, userId: user._id }, email },
    })
  })

  if (user.passwordHash) {
    try {
      await sendAccessGrantedEmail({ to: email, tenantName: tenant?.name ?? '', inviterName: params.inviterName })
      return { ok: true, outcome: 'added', emailSent: true, emailError: null }
    } catch {
      return { ok: true, outcome: 'added', emailSent: false, emailError: null }
    }
  }
  const sent = await sendInvite(user, tenantId, tenant?.name ?? '', params.inviterName)
  return { ok: true, outcome: 'invited', ...sent }
}

/** A fresh invite link for a parent who hasn't set a password yet. */
export async function resendInvite(params: {
  tenantId: string
  parent: ParentDoc
  inviterName: string
}): Promise<{ ok: true; emailSent: boolean; emailError: string | null } | { ok: false; error: 'NOT_ENABLED' | 'ALREADY_ACTIVE' }> {
  const userId = params.parent.portalAccess?.userId
  if (!params.parent.portalAccess?.enabled || !userId) return { ok: false, error: 'NOT_ENABLED' }
  const user = await withoutTenant((db) => db.users.findOne({ _id: userId }))
  if (!user) return { ok: false, error: 'NOT_ENABLED' }
  if (user.passwordHash) return { ok: false, error: 'ALREADY_ACTIVE' }
  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: params.tenantId }))
  return { ok: true, ...(await sendInvite(user, params.tenantId, tenant?.name ?? '', params.inviterName)) }
}

/** Turns the portal off: the membership goes (so the login stops working
 * here at once, see `callerScopes`) and open sessions are revoked. The user
 * id stays on the parent, so turning it back on reuses the same login. */
export async function disablePortal(params: { tenantId: string; parent: ParentDoc; actorId: string }): Promise<boolean> {
  const { tenantId, parent } = params
  const userId = parent.portalAccess?.userId
  if (!parent.portalAccess?.enabled) return false
  if (userId) {
    await withoutTenant(async (db) => {
      await db.memberships.deleteOne({ _id: `${tenantId}:${userId}`, roleKey: PARENT_ROLE_KEY })
      await db.refreshTokens.updateMany({ userId, tenantId, revokedAt: null }, { $set: { revokedAt: new Date() } })
    })
  }
  await withTenant(tenantId, async (ctx) => {
    await ctx.parents.findOneAndUpdate(
      { _id: parent._id },
      { $set: { portalAccess: { enabled: false, userId: userId ?? null }, updatedAt: new Date() } },
    )
    await recordAudit(ctx.auditLog, {
      actorId: params.actorId,
      action: 'parent.portal.disable',
      entity: 'parent',
      entityId: parent._id,
      before: { portalAccess: parent.portalAccess },
      after: { portalAccess: { enabled: false, userId: userId ?? null } },
    })
  })
  return true
}
