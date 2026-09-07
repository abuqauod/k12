import { randomUUID } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { withoutTenant } from '../db.js'
import { authenticate } from './guard.js'
import { createRefreshToken, hashRefreshToken, signAccessToken } from './tokens.js'
import type { Role } from './tokens.js'

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** Optional when the user belongs to exactly one school. */
  tenantSlug: z.string().optional(),
})

const refreshBody = z.object({ refreshToken: z.string().min(1) })

export async function hashPassword(plain: string): Promise<string> {
  // argon2id with parameters that cost ~50ms on a small VPS.
  return hash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 })
}

interface UsableMembership {
  tenantId: string
  role: Role
  slug: string
  name: string
  status: string
}

/**
 * "Which schools does this person belong to?" — the one lookup that has to
 * cross tenants, because it runs before a tenant is known. The Postgres
 * version needed a SECURITY DEFINER function to ask this without opening RLS
 * up generally; here it's just two queries, because there is no policy to
 * work around in the first place.
 */
async function membershipsForUser(userId: string): Promise<UsableMembership[]> {
  return withoutTenant(async (db) => {
    const memberships = await db.memberships.find({ userId }).toArray()
    if (memberships.length === 0) return []

    const tenants = await db.tenants
      .find({ _id: { $in: memberships.map((m) => m.tenantId) } })
      .toArray()
    const byId = new Map(tenants.map((t) => [t._id, t]))

    return memberships.flatMap((m): UsableMembership[] => {
      const tenant = byId.get(m.tenantId)
      if (!tenant) return []
      return [{ tenantId: m.tenantId, role: m.role, slug: tenant.slug, name: tenant.name, status: tenant.status }]
    })
  })
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const { password, tenantSlug } = parsed.data
    const email = parsed.data.email.toLowerCase()

    const user = await withoutTenant((db) => db.users.findOne({ email }))

    // Same response whether the user is unknown or the password is wrong, so
    // the endpoint cannot be used to enumerate staff email addresses.
    const ok = user ? await verify(user.passwordHash, password).catch(() => false) : false
    if (!user || !user.active || !ok) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' })
    }

    const memberships = await membershipsForUser(user._id)
    const usable = memberships.filter((row) => row.status === 'active')
    if (usable.length === 0) return reply.code(403).send({ error: 'NO_ACTIVE_TENANT' })

    const chosen = tenantSlug
      ? usable.find((row) => row.slug.toLowerCase() === tenantSlug.toLowerCase())
      : usable[0]
    if (!chosen) return reply.code(403).send({ error: 'NOT_A_MEMBER' })

    // A user in more than one school must say which; the client shows a picker.
    if (!tenantSlug && usable.length > 1) {
      return reply.code(300).send({
        error: 'TENANT_REQUIRED',
        tenants: usable.map((row) => ({ slug: row.slug, name: row.name })),
      })
    }

    const { refreshTokenId: _refreshTokenId, ...tokens } = await issueSession(
      user._id,
      chosen.tenantId,
      chosen.role,
      email,
    )
    await withoutTenant((db) =>
      db.users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } }),
    )

    return reply.send({
      ...tokens,
      user: {
        id: user._id,
        email,
        displayName: user.displayName,
        displayNameAr: user.displayNameAr,
        role: chosen.role,
      },
      tenant: { id: chosen.tenantId, slug: chosen.slug, name: chosen.name },
    })
  })

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = refreshBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const presented = hashRefreshToken(parsed.data.refreshToken)

    const result = await withoutTenant((db) => db.refreshTokens.findOne({ tokenHash: presented }))
    if (!result) return reply.code(401).send({ error: 'INVALID_REFRESH' })

    // Presenting a token that was already rotated means it leaked. Kill the
    // whole family rather than just refusing this one request.
    if (result.rotatedTo || result.revokedAt) {
      await withoutTenant((db) =>
        db.refreshTokens.updateMany(
          { userId: result.userId, revokedAt: null },
          { $set: { revokedAt: new Date() } },
        ),
      )
      return reply.code(401).send({ error: 'REFRESH_REUSED' })
    }

    if (result.expiresAt.getTime() < Date.now()) {
      return reply.code(401).send({ error: 'REFRESH_EXPIRED' })
    }

    const membership = await withoutTenant((db) =>
      db.memberships.findOne({ _id: `${result.tenantId}:${result.userId}` }),
    )
    if (!membership) return reply.code(403).send({ error: 'NOT_A_MEMBER' })

    const session = await issueSession(result.userId, result.tenantId, membership.role, result.email)
    await withoutTenant((db) =>
      db.refreshTokens.updateOne({ _id: result._id }, { $set: { rotatedTo: session.refreshTokenId } }),
    )
    const { refreshTokenId: _refreshTokenId, ...tokens } = session
    return reply.send(tokens)
  })

  app.post('/auth/logout', async (request, reply) => {
    const parsed = refreshBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    await withoutTenant((db) =>
      db.refreshTokens.updateOne(
        { tokenHash: hashRefreshToken(parsed.data.refreshToken), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      ),
    )
    return reply.code(204).send()
  })

  app.get('/auth/me', { preHandler: authenticate }, async (request, reply) => {
    const auth = request.auth
    if (!auth) return reply.code(401).send({ error: 'MISSING_TOKEN' })
    return reply.send({ userId: auth.sub, email: auth.email, tenantId: auth.tenantId, role: auth.role })
  })
}

async function issueSession(userId: string, tenantId: string, role: Role, email: string) {
  const accessToken = await signAccessToken({ sub: userId, tenantId, role, email })
  const refresh = createRefreshToken()
  const refreshTokenId = randomUUID()
  const expiresAt = new Date(Date.now() + config.refreshTokenDays * 86_400_000)

  await withoutTenant((db) =>
    db.refreshTokens.insertOne({
      _id: refreshTokenId,
      userId,
      tenantId,
      email,
      tokenHash: refresh.hash,
      issuedAt: new Date(),
      expiresAt,
      revokedAt: null,
      rotatedTo: null,
    }),
  )

  return {
    accessToken,
    refreshToken: refresh.token,
    expiresAt: expiresAt.toISOString(),
    /** Not sent to the client — used by /auth/refresh to link rotated_to. */
    refreshTokenId,
  }
}
