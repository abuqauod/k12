import type { FastifyReply, FastifyRequest } from 'fastify'
import { withoutTenant } from '../db.js'
import { verifyAccessToken } from './tokens.js'
import type { AccessClaims, Role } from './tokens.js'

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AccessClaims
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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
    await reply.code(401).send({ error: 'MISSING_TOKEN' })
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
