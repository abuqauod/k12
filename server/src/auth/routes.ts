import { randomUUID } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { withoutTenant } from '../db.js'
import { EmailNotConfiguredError, sendPasswordResetEmail } from '../email.js'
import { consumeActionToken, createActionToken, PASSWORD_RESET_TTL_MS } from './actionTokens.js'
import { authenticate } from './guard.js'
import { clearLoginFailures, isLockedOut, recordLoginFailure } from './rateLimit.js'
import { createRefreshToken, hashRefreshToken, signAccessToken } from './tokens.js'
import type { Role } from './tokens.js'

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** Optional when the user belongs to exactly one school. */
  tenantSlug: z.string().optional(),
})

const refreshBody = z.object({ refreshToken: z.string().min(1) })
const forgotPasswordBody = z.object({ email: z.string().email() })
const resetPasswordBody = z.object({ token: z.string().min(1), password: z.string().min(8) })
const acceptInviteBody = z.object({ token: z.string().min(1), password: z.string().min(8) })
const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
})

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

    if (await isLockedOut(email)) {
      return reply.code(429).send({ error: 'TOO_MANY_ATTEMPTS' })
    }

    const user = await withoutTenant((db) => db.users.findOne({ email }))

    // Same response whether the user is unknown or the password is wrong, so
    // the endpoint cannot be used to enumerate staff email addresses. An
    // invited-but-not-yet-accepted user has no passwordHash yet — that's
    // "not recognised" too, not a crash.
    const ok = user?.passwordHash ? await verify(user.passwordHash, password).catch(() => false) : false
    if (!user || !user.active || !ok) {
      await recordLoginFailure(email)
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' })
    }
    await clearLoginFailures(email)

    // The vendor's own account: no single school's context, so tenant
    // selection doesn't apply. See UserDoc.platformAdmin.
    if (user.platformAdmin) {
      const { refreshTokenId: _refreshTokenId, ...tokens } = await issueSession({
        userId: user._id,
        email,
        platformAdmin: true,
      })
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
          role: null,
        },
        tenant: null,
        platformAdmin: true,
      })
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

    const { refreshTokenId: _refreshTokenId, ...tokens } = await issueSession({
      userId: user._id,
      email,
      tenantId: chosen.tenantId,
      role: chosen.role,
    })
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

    let session: Awaited<ReturnType<typeof issueSession>>
    if (result.tenantId === null) {
      // Platform-admin session — re-check the flag fresh, same reasoning as
      // requirePlatformAdmin: revocation should take effect immediately.
      const user = await withoutTenant((db) => db.users.findOne({ _id: result.userId }))
      if (!user?.platformAdmin) return reply.code(403).send({ error: 'NOT_A_MEMBER' })
      session = await issueSession({ userId: result.userId, email: result.email, platformAdmin: true })
    } else {
      const membership = await withoutTenant((db) =>
        db.memberships.findOne({ _id: `${result.tenantId}:${result.userId}` }),
      )
      if (!membership) return reply.code(403).send({ error: 'NOT_A_MEMBER' })
      session = await issueSession({
        userId: result.userId,
        email: result.email,
        tenantId: result.tenantId,
        role: membership.role,
      })
    }

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
    return reply.send({
      userId: auth.sub,
      email: auth.email,
      tenantId: auth.tenantId ?? null,
      role: auth.role ?? null,
      platformAdmin: auth.platformAdmin ?? false,
    })
  })

  /** Every active (non-revoked, non-expired) session for the caller. */
  app.get('/auth/sessions', { preHandler: authenticate }, async (request, reply) => {
    const sessions = await withoutTenant((db) =>
      db.refreshTokens
        .find({ userId: request.auth!.sub, revokedAt: null, expiresAt: { $gt: new Date() } })
        .sort({ issuedAt: -1 })
        .toArray(),
    )
    return reply.send({
      sessions: sessions.map((s) => ({
        id: s._id,
        tenantId: s.tenantId,
        issuedAt: s.issuedAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
      })),
    })
  })

  app.delete('/auth/sessions/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await withoutTenant((db) =>
      db.refreshTokens.updateOne(
        { _id: id, userId: request.auth!.sub, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      ),
    )
    if (result.matchedCount === 0) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.code(204).send()
  })

  /**
   * Always the same response whether or not the email exists — the one place
   * that isn't true is when SMTP itself isn't configured, which isn't a
   * secret worth protecting.
   */
  app.post('/auth/forgot-password', async (request, reply) => {
    const parsed = forgotPasswordBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const email = parsed.data.email.toLowerCase()

    const user = await withoutTenant((db) => db.users.findOne({ email }))
    if (user?.active) {
      const token = await createActionToken({
        userId: user._id,
        purpose: 'password_reset',
        ttlMs: PASSWORD_RESET_TTL_MS,
      })
      try {
        await sendPasswordResetEmail({ to: email, token })
      } catch (error) {
        if (error instanceof EmailNotConfiguredError) {
          return reply.code(501).send({ error: 'EMAIL_NOT_CONFIGURED' })
        }
        request.log.error(error, 'failed to send password reset email')
        return reply.code(502).send({ error: 'EMAIL_SEND_FAILED' })
      }
    }
    return reply.send({ ok: true })
  })

  app.post('/auth/reset-password', async (request, reply) => {
    const parsed = resetPasswordBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const result = await consumeActionToken(parsed.data.token, 'password_reset')
    if (!result.ok) return reply.code(400).send({ error: `TOKEN_${result.error}` })

    const passwordHash = await hashPassword(parsed.data.password)
    await withoutTenant(async (db) => {
      // Completing a reset proves control of the mailbox, same as accepting
      // an invite does — mark it verified if it wasn't already.
      await db.users.updateOne({ _id: result.userId }, { $set: { passwordHash, emailVerified: true } })
      // A reset means the old password may have leaked — end every session,
      // not just issue a new password alongside the old sessions.
      await db.refreshTokens.updateMany(
        { userId: result.userId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
    })
    return reply.send({ ok: true })
  })

  /** Sets a first password for a user created by an invite (see admin/memberships routes). */
  app.post('/auth/accept-invite', async (request, reply) => {
    const parsed = acceptInviteBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const result = await consumeActionToken(parsed.data.token, 'invite')
    if (!result.ok) return reply.code(400).send({ error: `TOKEN_${result.error}` })

    const passwordHash = await hashPassword(parsed.data.password)
    await withoutTenant(async (db) => {
      await db.users.updateOne(
        { _id: result.userId },
        // Accepting the invite is the proof: they received mail at this
        // address and clicked a real link in it.
        { $set: { passwordHash, active: true, emailVerified: true } },
      )
      if (result.grant) {
        const { tenantId, role } = result.grant
        await db.memberships.updateOne(
          { _id: `${tenantId}:${result.userId}` },
          {
            $set: { tenantId, userId: result.userId, role },
            $setOnInsert: { createdAt: new Date(), branchIds: null },
          },
          { upsert: true },
        )
      }
    })
    return reply.send({ ok: true })
  })

  app.post('/auth/change-password', { preHandler: authenticate }, async (request, reply) => {
    const parsed = changePasswordBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const user = await withoutTenant((db) => db.users.findOne({ _id: request.auth!.sub }))
    const ok = user?.passwordHash
      ? await verify(user.passwordHash, parsed.data.currentPassword).catch(() => false)
      : false
    if (!user || !ok) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' })

    const passwordHash = await hashPassword(parsed.data.newPassword)
    await withoutTenant(async (db) => {
      await db.users.updateOne({ _id: user._id }, { $set: { passwordHash } })
      // Same reasoning as a reset: a changed password ends every session,
      // this request's own included — sign in again with the new one.
      await db.refreshTokens.updateMany(
        { userId: user._id, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
    })
    return reply.send({ ok: true })
  })
}

interface SessionParams {
  userId: string
  email: string
  tenantId?: string
  role?: Role
  platformAdmin?: boolean
}

async function issueSession(params: SessionParams) {
  const accessToken = await signAccessToken({
    sub: params.userId,
    email: params.email,
    tenantId: params.tenantId,
    role: params.role,
    platformAdmin: params.platformAdmin,
  })
  const refresh = createRefreshToken()
  const refreshTokenId = randomUUID()
  const expiresAt = new Date(Date.now() + config.refreshTokenDays * 86_400_000)

  await withoutTenant((db) =>
    db.refreshTokens.insertOne({
      _id: refreshTokenId,
      userId: params.userId,
      tenantId: params.tenantId ?? null,
      email: params.email,
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
