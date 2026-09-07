import { randomUUID } from 'node:crypto'
import { withoutTenant } from '../db.js'
import type { MembershipDoc } from '../db.js'
import { createActionToken, INVITE_TTL_MS } from '../auth/actionTokens.js'
import { sendInviteEmail } from '../email.js'

export type InviteOutcome = 'invited' | 'added' | 'already_member'

/**
 * Shared by the platform-admin tenant API (inviting a school's first owner)
 * and the per-tenant membership API (an admin inviting their own staff) —
 * one place that decides between the two real cases:
 *
 *  - the email belongs to nobody yet, or to someone who was invited
 *    somewhere and never set a password: create/reuse that user record and
 *    email them an invite link to set one.
 *  - the email already has a working account (they use this product at
 *    another school already): just grant the membership — they sign in with
 *    the credentials they already have, no email needed.
 */
export async function inviteUserToTenant(params: {
  email: string
  tenantId: string
  tenantName: string
  role: MembershipDoc['role']
  inviterName: string
  /** Used only if a brand-new user record has to be created. */
  displayName?: string
}): Promise<{ userId: string; outcome: InviteOutcome }> {
  const email = params.email.toLowerCase()

  return withoutTenant(async (db) => {
    let user = await db.users.findOne({ email })
    if (!user) {
      const _id = randomUUID()
      await db.users.insertOne({
        _id,
        email,
        passwordHash: null,
        displayName: params.displayName ?? email,
        displayNameAr: null,
        active: false,
        platformAdmin: false,
        createdAt: new Date(),
        lastLoginAt: null,
      })
      user = (await db.users.findOne({ _id }))!
    }

    const membershipId = `${params.tenantId}:${user._id}`
    if (await db.memberships.findOne({ _id: membershipId })) {
      return { userId: user._id, outcome: 'already_member' }
    }

    if (user.passwordHash) {
      // Already has working credentials elsewhere — just grant access.
      await db.memberships.insertOne({
        _id: membershipId,
        tenantId: params.tenantId,
        userId: user._id,
        role: params.role,
        createdAt: new Date(),
      })
      return { userId: user._id, outcome: 'added' }
    }

    const token = await createActionToken({
      userId: user._id,
      purpose: 'invite',
      grant: { tenantId: params.tenantId, role: params.role },
      ttlMs: INVITE_TTL_MS,
    })
    await sendInviteEmail({
      to: email,
      tenantName: params.tenantName,
      inviterName: params.inviterName,
      token,
    })
    return { userId: user._id, outcome: 'invited' }
  })
}
