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
  const membership = await withoutTenant((db) =>
    db.memberships.findOne({ _id: `${auth.tenantId}:${auth.sub}` }),
  )
  return membership?.branchIds ?? null
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
// A named-scope layer on top of the 4-role rank system above, not a
// replacement for it. `requireRole`/`roleAtLeast` stay exactly as they are —
// every existing route keeps working unmodified — but every NEW route from
// here on should be written against `requirePermission`/`callerHasPermission`
// instead of a fresh `requireRole` call, because a rank comparison can only
// ever express "this action needs at least role X." It cannot express "can
// approve a refund but not manage fee structures" (two admin-tier actions
// with no rank relationship to each other) — real cases this app already
// needs (finance/routes.ts's discount gate, parents/routes.ts's
// financialResponsibility gate) and will need more of as the admin surface
// grows.
//
// `ROLE_SCOPES` below is DERIVED from today's `requireRole` call sites, not
// designed fresh — every existing route's authorization behavior is
// reproduced exactly once it's switched from `requireRole(x)` to
// `requirePermission('module.write')`, so migrating a route is a no-op for
// callers, not a silent behavior change. A handful of scopes with no route
// yet (branches.manage, settings.*, search.read, dashboard.read,
// audit.export) are declared now so the bundle table doesn't need touching
// again for each of the several PRs that will consume them.
//
// This is Layer 1 of a two-layer design. Layer 2 — per-membership
// `customScopes`/`deniedScopes` fields on `MembershipDoc` for real
// per-tenant customization beyond a role's bundle — is deliberately NOT
// built here. Nothing today needs a school to define its own named role;
// they need finer per-action gates, which this layer already provides.
// Build Layer 2 only once a real case appears that this doesn't cover.

export type PermissionScope =
  | 'academicYears.read'
  | 'academicYears.write'
  | 'attendance.read'
  | 'attendance.write'
  | 'audit.export'
  | 'audit.read'
  | 'branches.manage'
  | 'branches.read'
  | 'classes.read'
  | 'classes.write'
  | 'dashboard.read'
  | 'datasets.read'
  | 'datasets.write'
  | 'enrollments.read'
  | 'enrollments.write'
  | 'finance.manage'
  | 'finance.read'
  | 'finance.write'
  | 'memberships.manage'
  | 'notifications.manage'
  | 'notifications.run'
  | 'parents.manage'
  | 'parents.read'
  | 'parents.write'
  | 'search.read'
  | 'settings.manage'
  | 'settings.read'
  | 'students.read'
  | 'students.write'
  | 'transport.manage'
  | 'transport.read'
  | 'transport.write'

/** Every read-only scope, granted at every role including `viewer`. Mirrors
 * every module's existing `readGuard`/`authenticate`-only route today.
 * `audit.read` is deliberately NOT here — it's admin-only today
 * (`auditlog/routes.ts`), unlike every other module's read side. */
const VIEWER_SCOPES: readonly PermissionScope[] = [
  'academicYears.read',
  'attendance.read',
  'branches.read',
  'classes.read',
  'dashboard.read',
  'datasets.read',
  'enrollments.read',
  'finance.read',
  'parents.read',
  'search.read',
  'settings.read',
  'students.read',
  'transport.read',
]

/** Adds the routine day-to-day write actions — mirrors every module's
 * existing `requireRole('scheduler')` write guard. */
const SCHEDULER_SCOPES: readonly PermissionScope[] = [
  ...VIEWER_SCOPES,
  'academicYears.write',
  'attendance.write',
  'datasets.write',
  'finance.write',
  'notifications.run',
  'parents.write',
  'students.write',
  'transport.write',
]

/** Adds the higher-trust actions — mirrors every module's existing
 * `requireRole('admin')` guard (`classes.write`/`enrollments.write` are
 * admin-only today, not scheduler, unlike most other modules' write side —
 * reproduced here exactly, not normalized to match the others). */
const ADMIN_SCOPES: readonly PermissionScope[] = [
  ...SCHEDULER_SCOPES,
  'audit.export',
  'audit.read',
  'branches.manage',
  'classes.write',
  'enrollments.write',
  'finance.manage',
  'memberships.manage',
  'notifications.manage',
  'parents.manage',
  'settings.manage',
  'transport.manage',
]

/** Same bundle as admin for now — owner's extra powers (e.g. "only an owner
 * can grant the owner role") stay an explicit separate check in
 * memberships/service.ts, not modeled as a scope, matching how that rule
 * already works today under plain rank comparison. */
const OWNER_SCOPES: readonly PermissionScope[] = ADMIN_SCOPES

const ROLE_SCOPES: Record<Role, ReadonlySet<PermissionScope>> = {
  viewer: new Set(VIEWER_SCOPES),
  scheduler: new Set(SCHEDULER_SCOPES),
  admin: new Set(ADMIN_SCOPES),
  owner: new Set(OWNER_SCOPES),
}

/** For an inline check inside a handler body — same idiom as `roleAtLeast`,
 * e.g. when only part of a route's behavior needs a scope a lower-privilege
 * caller of the same route doesn't. */
export function callerHasPermission(role: Role | undefined, scope: PermissionScope): boolean {
  return role !== undefined && ROLE_SCOPES[role].has(scope)
}

export function requirePermission(scope: PermissionScope) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!callerHasPermission(request.auth?.role, scope)) {
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
