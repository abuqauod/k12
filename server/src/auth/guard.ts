import type { FastifyReply, FastifyRequest } from 'fastify'
import { withoutTenant } from '../db.js'
import { hashApiKey } from '../apikeys/hash.js'
import { verifyAccessToken } from './tokens.js'
import type { AccessClaims, Role } from './tokens.js'
import { scopesFor, type PermissionScope } from './scopes.js'
import type { MembershipDoc } from '../db.js'

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

/**
 * Which branches the caller may act in: `null` means all (an owner/admin, or
 * any API key — a key is tenant-wide by design). A branch-scoped route calls
 * this and then checks the branchId it was given against the result. Cheap
 * enough to call per-request; the membership lookup is a single indexed hit.
 */
export async function callerBranchIds(request: FastifyRequest): Promise<string[] | null> {
  const auth = request.auth
  if (!auth?.tenantId) return null
  if (auth.sub.startsWith('apikey:')) return null
  const membership = await loadCallerMembership(request)
  return membership?.branchIds ?? null
}

const membershipCache = new WeakMap<FastifyRequest, Promise<MembershipDoc | null>>()

/** The caller's own membership, read once per request — branch scoping and
 * scope resolution both need it. Null for API keys and platform sessions. */
export function loadCallerMembership(request: FastifyRequest): Promise<MembershipDoc | null> {
  const auth = request.auth
  if (!auth?.tenantId || auth.sub.startsWith('apikey:')) return Promise.resolve(null)
  let cached = membershipCache.get(request)
  if (!cached) {
    cached = withoutTenant((db) => db.memberships.findOne({ _id: `${auth.tenantId}:${auth.sub}` }))
    membershipCache.set(request, cached)
  }
  return cached
}

/** True when the caller may act in `branchId`. */
export async function callerCanUseBranch(
  request: FastifyRequest,
  branchId: string,
): Promise<boolean> {
  const allowed = await callerBranchIds(request)
  return allowed === null || allowed.includes(branchId)
}

const RANK: Record<Role, number> = { viewer: 0, scheduler: 1, admin: 2, owner: 3 }

/** For an inline check inside a handler body — e.g. a field in the request
 * body needs a higher role than the route's own preHandler requires (see
 * parents/routes.ts's financial-responsibility / portal-access flags). */
export function roleAtLeast(role: Role | undefined, minimum: Role): boolean {
  return role !== undefined && RANK[role] >= RANK[minimum]
}

export function requireRole(minimum: Role) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!roleAtLeast(request.auth?.role, minimum)) {
      await reply.code(403).send({ error: 'FORBIDDEN', required: minimum })
    }
  }
}

// -------------------------------------------------------------- permissions
//
// Named-scope authorization (SAMS 1.1, 1.8). Scope names, the rank bundles
// and the named role presets live in ./scopes.ts. Every route authorizes
// through `requirePermission` / `callerHasPermission` (pinned by
// src/test/permissions.test.ts and src/test/roles.test.ts);
// `requireRole` / `roleAtLeast` remain only for rank rules such as who may
// grant which role.
//
// A member's scopes come from their membership's `roleKey` preset when set,
// else from their rank. The membership is read per request (memoized, and
// shared with `callerBranchIds`), so a preset change applies on the next
// request rather than after the access token expires. API keys carry a
// rank only.
export type { PermissionScope } from './scopes.js'

/** The scopes the caller holds right now. */
export async function callerScopes(request: FastifyRequest): Promise<ReadonlySet<PermissionScope>> {
  const auth = request.auth
  if (!auth) return new Set()
  if (!auth.tenantId || auth.sub.startsWith('apikey:')) return scopesFor(auth.role)
  const membership = await loadCallerMembership(request)
  // A removed member (or a parent whose portal was switched off) keeps a
  // valid token for a few minutes; it must not fall back to its rank.
  if (!membership) return new Set()
  // The membership's rank, not the token's: a demotion applies on the next
  // request, same as a preset change.
  return scopesFor(membership.role, membership.roleKey)
}

/** For an inline check inside a handler body — when only part of a route's
 * behavior needs a scope that other callers of the same route lack. */
export async function callerHasPermission(
  request: FastifyRequest,
  scope: PermissionScope,
): Promise<boolean> {
  return (await callerScopes(request)).has(scope)
}

export function requirePermission(scope: PermissionScope) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!(await callerHasPermission(request, scope))) {
      await reply.code(403).send({ error: 'FORBIDDEN', required: scope })
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
