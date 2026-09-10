import { randomUUID } from 'node:crypto'
import { withoutTenant } from './db.js'

/**
 * A coarse advisory lock in the `locks` collection, so periodic work that a
 * single-process design assumed stays single-writer when the app runs as
 * several instances (Docker replicas, a rolling deploy overlap). Correctness
 * of the notification system does NOT rest on this — the deterministic job
 * `_id` already makes enqueue idempotent — it only stops two instances doing
 * the same scan-and-enqueue at the same moment.
 *
 * A held row self-heals: `expiresAt` (also a TTL index) means a holder that
 * dies mid-run frees the lock automatically after `ttlMs`.
 */

/** Stable per-process id, only for "who holds it" diagnostics. */
const INSTANCE_ID = process.env.INSTANCE_ID ?? `${process.pid}-${randomUUID().slice(0, 8)}`

/**
 * Try to take `name` for `ttlMs`. Returns a release function on success, or
 * `null` if someone else holds an unexpired lock. Acquisition is atomic: the
 * filter matches only a free-or-expired row, and `upsert` turns "no row yet"
 * into an insert that a racing caller's duplicate-key error loses.
 */
export async function acquireLock(
  name: string,
  ttlMs: number,
): Promise<null | (() => Promise<void>)> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs)
  try {
    const res = await withoutTenant((db) =>
      db.locks.findOneAndUpdate(
        { _id: name, expiresAt: { $lt: now } },
        { $set: { holder: INSTANCE_ID, acquiredAt: now, expiresAt } },
        { upsert: true, returnDocument: 'after' },
      ),
    )
    if (!res) return null
  } catch (error) {
    // Duplicate key: the row existed and was NOT expired, so the filter
    // missed and upsert tried to insert. Someone else holds it.
    if (isDuplicateKeyError(error)) return null
    throw error
  }

  let released = false
  return async () => {
    if (released) return
    released = true
    await withoutTenant((db) => db.locks.deleteOne({ _id: name, holder: INSTANCE_ID }))
  }
}

/** Run `fn` only if `name` is free; otherwise do nothing and return null. */
export async function withLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const release = await acquireLock(name, ttlMs)
  if (!release) return null
  try {
    return await fn()
  } finally {
    await release()
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000
}
