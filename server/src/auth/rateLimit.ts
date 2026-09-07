import { withoutTenant } from '../db.js'

/**
 * Login brute-force protection, keyed by email rather than IP: a single
 * account being guessed from many IPs is the more likely real attack, and
 * this needs no infrastructure beyond the database already in use. One
 * document per email; the TTL index in schema.ts ages out anything quiet.
 */
const MAX_ATTEMPTS = 10
const WINDOW_MS = 15 * 60 * 1000
const LOCK_MS = 15 * 60 * 1000

export async function isLockedOut(email: string): Promise<boolean> {
  return withoutTenant(async (db) => {
    const doc = await db.loginAttempts.findOne({ _id: email })
    return Boolean(doc?.lockedUntil && doc.lockedUntil.getTime() > Date.now())
  })
}

export async function recordLoginFailure(email: string): Promise<void> {
  await withoutTenant(async (db) => {
    const now = new Date()
    const existing = await db.loginAttempts.findOne({ _id: email })
    const count = (existing?.count ?? 0) + 1
    const lockedUntil = count >= MAX_ATTEMPTS ? new Date(now.getTime() + LOCK_MS) : existing?.lockedUntil ?? null
    await db.loginAttempts.updateOne(
      { _id: email },
      { $set: { count, lockedUntil, expiresAt: new Date(now.getTime() + WINDOW_MS) } },
      { upsert: true },
    )
  })
}

export async function clearLoginFailures(email: string): Promise<void> {
  await withoutTenant((db) => db.loginAttempts.deleteOne({ _id: email }))
}
