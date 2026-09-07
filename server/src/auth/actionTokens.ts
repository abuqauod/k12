import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { withoutTenant } from '../db.js'
import type { MembershipDoc } from '../db.js'

/**
 * A single mechanism for both "accept your invite" and "reset your
 * password" — both are a one-time bearer token that lets an otherwise
 * unauthenticated request set a password, so there is exactly one
 * expiry/consumption path to get right instead of two similar ones.
 */

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000

export async function createActionToken(params: {
  userId: string
  purpose: 'invite' | 'password_reset'
  /** Invite only: the membership to create once the token is accepted. */
  grant?: { tenantId: string; role: MembershipDoc['role'] }
  ttlMs: number
}): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await withoutTenant((db) =>
    db.actionTokens.insertOne({
      _id: randomUUID(),
      userId: params.userId,
      purpose: params.purpose,
      tokenHash: hashToken(token),
      grant: params.grant ?? null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + params.ttlMs),
      usedAt: null,
    }),
  )
  return token
}

export type ConsumeResult =
  | { ok: true; userId: string; grant: { tenantId: string; role: MembershipDoc['role'] } | null }
  | { ok: false; error: 'INVALID' | 'EXPIRED' | 'USED' }

/** Marks the token used in the same step as validating it — it cannot be
 * read twice and accepted twice. */
export async function consumeActionToken(
  token: string,
  purpose: 'invite' | 'password_reset',
): Promise<ConsumeResult> {
  const tokenHash = hashToken(token)
  return withoutTenant(async (db) => {
    const doc = await db.actionTokens.findOne({ tokenHash, purpose })
    if (!doc) return { ok: false, error: 'INVALID' }
    if (doc.usedAt) return { ok: false, error: 'USED' }
    if (doc.expiresAt.getTime() < Date.now()) return { ok: false, error: 'EXPIRED' }
    await db.actionTokens.updateOne({ _id: doc._id }, { $set: { usedAt: new Date() } })
    return { ok: true, userId: doc.userId, grant: doc.grant }
  })
}
