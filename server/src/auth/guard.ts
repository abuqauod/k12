import type { FastifyReply, FastifyRequest } from 'fastify'
import { withoutTenant } from '../db.js'
import { hashApiKey } from '../apikeys/hash.js'
import { verifyAccessToken } from './tokens.js'
import type { AccessClaims, Role } from './tokens.js'

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AccessClaims
  }
}

/**
 * Two ways in: a user's JWT (`Authorization: Bearer …`), or a tenant's API
 * key (`X-Api-Key: sk_live_…`) for scripts and integrations that aren't a
 * person. Whichever it is, downstream code only ever looks at `request.auth`
 * — dataset routes don't know or care which kind of caller they're serving.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const apiKey = request.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    const found = await withoutTenant((db) => db.apiKeys.findOne({ keyHash: hashApiKey(apiKey) }))
    if (!found || found.revokedAt) {
      await reply.code(401).send({ error: 'INVALID_API_KEY' })
      return
    }
    void withoutTenant((db) =>
      db.apiKeys.updateOne({ _id: found._id }, { $set: { lastUsedAt: new Date() } }),
    )
    request.auth = {
      sub: `apikey:${found._id}`,
      email: '',
      tenantId: found.tenantId,
      role: found.role,
    }
    return
  }

  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    await reply.code(401).send({ error: 'MISSING_TOKEN' })
    return
  }
  try {
    request.auth = await verifyAccessToken(header.slice(7))
  } catch {
    await reply.code(401).send({ error: 'INVALID_TOKEN' })
  }
}

const RANK: Record<Role, number> = { viewer: 0, scheduler: 1, admin: 2, owner: 3 }

export function requireRole(minimum: Role) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const role = request.auth?.role
    if (!role || RANK[role] < RANK[minimum]) {
      await reply.code(403).send({ error: 'FORBIDDEN', required: minimum })
    }
  }
}

/**
 * Gate for `/admin/*`: the vendor's own operator flag, not a tenant role.
 * Re-checked against the database on every request (like
 * `requireActiveSubscription` below) rather than trusted from the JWT claim,
 * because revoking platform-admin access should take effect immediately, not
 * after the token's 15-minute expiry.
 */
export async function requirePlatformAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.auth) {
    await reply.code(401).send({ error: 'MISSING_TOKEN' })
    return
  }
  const user = await withoutTenant((db) => db.users.findOne({ _id: request.auth!.sub }))
  if (!user?.platformAdmin) {
    await reply.code(403).send({ error: 'FORBIDDEN' })
  }
}

/**
 * Subscription gate. Payment happens offline, so the software's job is only to
 * honour what was recorded: a lapsed tenant keeps working until its grace
 * period runs out, then loses sync rather than losing its data.
 */
export async function requireActiveSubscription(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const tenantId = request.auth?.tenantId
  if (!tenantId) {
    await reply.code(400).send({ error: 'NO_TENANT_CONTEXT' })
    return
  }

  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))

  if (!tenant) {
    await reply.code(403).send({ error: 'UNKNOWN_TENANT' })
    return
  }
  if (tenant.status !== 'active') {
    await reply.code(402).send({ error: 'SUBSCRIPTION_INACTIVE', status: tenant.status })
    return
  }
  if (tenant.validUntil) {
    const deadline = new Date(tenant.validUntil)
    deadline.setDate(deadline.getDate() + tenant.graceDays)
    if (Date.now() > deadline.getTime()) {
      await reply.code(402).send({
        error: 'SUBSCRIPTION_EXPIRED',
        validUntil: tenant.validUntil,
        graceDays: tenant.graceDays,
      })
    }
  }
}
