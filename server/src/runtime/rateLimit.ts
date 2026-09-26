import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * SAMS 8.4 — a per-IP request budget for the endpoints anyone can call
 * without signing in (login, password reset, invites, refresh). The
 * per-account lockout in `auth/rateLimit.ts` stops guessing one password;
 * this stops one address hammering many accounts or flooding reset emails.
 *
 * In memory, fixed window: one API process serves a school deployment, and
 * a restart forgiving the counters is harmless. Several instances behind a
 * balancer each keep their own budget, which only loosens the limit.
 */

interface Bucket {
  count: number
  resetAt: number
}

export interface Limit {
  /** Requests allowed per window per IP. */
  max: number
  windowMs: number
}

export function createLimiter(name: string, limit: Limit) {
  const buckets = new Map<string, Bucket>()
  let lastSweep = Date.now()

  const hit = (key: string, now = Date.now()): { ok: boolean; retryAfterS: number } => {
    // Drop expired buckets now and then so the map cannot grow without end.
    if (now - lastSweep > limit.windowMs) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k)
      lastSweep = now
    }
    let bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + limit.windowMs }
      buckets.set(key, bucket)
    }
    bucket.count++
    return { ok: bucket.count <= limit.max, retryAfterS: Math.ceil((bucket.resetAt - now) / 1000) }
  }

  /** A Fastify preHandler: 429 RATE_LIMITED with Retry-After once over. */
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (process.env.RATE_LIMITS === 'off') return
    const result = hit(`${name}:${request.ip}`)
    if (!result.ok) {
      reply.header('retry-after', String(result.retryAfterS))
      return reply.code(429).send({ error: 'RATE_LIMITED' })
    }
  }

  return { hit, guard, reset: () => buckets.clear() }
}

/** Sign-in, reset and invites: generous enough for a school behind one NAT. */
export const authLimiter = createLimiter('auth', { max: Number(process.env.RATE_LIMIT_AUTH ?? 60), windowMs: 60_000 })
/** Token refresh: every open tab of every user behind one school NAT. */
export const refreshLimiter = createLimiter('refresh', { max: Number(process.env.RATE_LIMIT_REFRESH ?? 600), windowMs: 60_000 })
/** Emails sent to an address on request (password reset): tight. */
export const emailLimiter = createLimiter('email', { max: Number(process.env.RATE_LIMIT_EMAIL ?? 10), windowMs: 15 * 60_000 })
