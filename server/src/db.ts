import { MongoClient } from 'mongodb'
import type {
  ClientSession,
  Collection,
  Document,
  Filter,
  FindOneAndUpdateOptions,
  OptionalUnlessRequiredId,
  UpdateFilter,
  WithoutId,
} from 'mongodb'
import { config } from './config.js'

// =============================================================================
// Isolation model, honestly stated
//
// The Postgres version of this backend enforced tenant isolation with row-
// level security: a query that forgot its tenant filter returned zero rows,
// enforced by the database itself, not by application code remembering to
// ask correctly. MongoDB has no equivalent — there is no server-side policy
// that can reject a query for lacking a `tenantId` filter.
//
// The replacement here is structural rather than a policy: every
// tenant-scoped read or write in this codebase goes through `TenantScope`
// (below), which merges `tenantId` into every filter and every inserted
// document itself. A handler cannot phrase a query that omits it — there is
// no parameter to leave out. That is weaker than RLS in one real way: a bug
// inside `TenantScope` itself is not caught by anything outside this file,
// where a bug in a Postgres migration was still caught by FORCE ROW LEVEL
// SECURITY. Treat this file with the scrutiny the database used to provide.
// =============================================================================

const client = new MongoClient(config.databaseUrl, {
  maxPoolSize: Number(process.env.MONGO_POOL_MAX ?? 20),
})

let connecting: Promise<MongoClient> | null = null
async function connect(): Promise<MongoClient> {
  connecting ??= client.connect()
  return connecting
}

/** The database named in `DATABASE_URL`'s path — same connection either way. */
async function getDb() {
  const connected = await connect()
  return connected.db()
}

export async function closeClient(): Promise<void> {
  await client.close()
}

export async function ping(): Promise<void> {
  const db = await getDb()
  await db.command({ ping: 1 })
}

// --------------------------------------------------------------- documents --

export interface TenantDoc extends Document {
  _id: string
  slug: string
  name: string
  plan: string
  status: 'active' | 'suspended' | 'cancelled'
  seats: number
  /** Paid-through date (ISO yyyy-mm-dd), or null for no expiry. */
  validUntil: string | null
  /** Bank transfers are slow; do not lock a school out the morning it lapses. */
  graceDays: number
  createdAt: Date
  updatedAt: Date
}

export interface UserDoc extends Document {
  _id: string
  /** Always lower-cased before it is stored or queried — Mongo has no citext. */
  email: string
  /**
   * Null for a user who was invited but hasn't accepted yet — they exist (so
   * the invite and any future membership can reference them) but cannot log
   * in until `POST /auth/accept-invite` sets a real hash.
   */
  passwordHash: string | null
  displayName: string
  displayNameAr: string | null
  active: boolean
  /**
   * The vendor's own operator flag — not a tenant role. Grants access to
   * `/admin/*` (creating tenants, etc.), which by definition happens outside
   * any one school's context. Set only via `npm run create-admin`; there is
   * no API that can grant it, deliberately.
   */
  platformAdmin: boolean
  createdAt: Date
  lastLoginAt: Date | null
}

export interface MembershipDoc extends Document {
  /** `${tenantId}:${userId}` — makes the pair unique without a separate index. */
  _id: string
  tenantId: string
  userId: string
  role: 'owner' | 'admin' | 'scheduler' | 'viewer'
  createdAt: Date
}

export interface RefreshTokenDoc extends Document {
  _id: string
  userId: string
  /** Null for a platform-admin session, which has no single school's context. */
  tenantId: string | null
  /** Denormalized so refresh doesn't need a second lookup to rebuild the JWT. */
  email: string
  /** Only the SHA-256 is stored — a database leak must not yield live sessions. */
  tokenHash: string
  issuedAt: Date
  expiresAt: Date
  revokedAt: Date | null
  rotatedTo: string | null
}

export interface DatasetDoc extends Document {
  /** `${tenantId}:${key}` */
  _id: string
  tenantId: string
  key: string
  revision: number
  problem: unknown
  updatedAt: Date
  updatedBy: string | null
}

export interface DatasetVersionDoc extends Document {
  /** `${tenantId}:${key}:${revision}` */
  _id: string
  tenantId: string
  key: string
  revision: number
  problem: unknown
  createdAt: Date
  createdBy: string | null
}

export interface AuditLogDoc extends Document {
  _id: string
  tenantId: string
  actorId: string | null
  action: string
  entity: string | null
  entityId: string | null
  meta: Record<string, unknown>
  createdAt: Date
}

export interface ApiKeyDoc extends Document {
  _id: string
  tenantId: string
  name: string
  /** Only the SHA-256 is stored, same reasoning as refresh tokens. */
  keyHash: string
  /** First few characters of the real key, kept so a listing can identify
   * which key is which without ever storing or showing the rest of it. */
  keyPreview: string
  /** The role the key acts as on every request — fixed at creation. */
  role: 'admin' | 'scheduler' | 'viewer'
  createdAt: Date
  createdBy: string
  lastUsedAt: Date | null
  revokedAt: Date | null
}

/**
 * A single-use bearer for an action that has to work before the holder is
 * authenticated: accepting an invite (sets a first password) or resetting a
 * forgotten one. Both are the same shape, distinguished by `purpose`, so
 * there is exactly one expiry/consumption code path to get right instead of
 * two similar ones.
 */
export interface ActionTokenDoc extends Document {
  _id: string
  userId: string
  purpose: 'invite' | 'password_reset'
  /** Only the SHA-256 is stored — same reasoning as refresh tokens. */
  tokenHash: string
  /** Invite-only: the membership to create once the invite is accepted. */
  grant: { tenantId: string; role: MembershipDoc['role'] } | null
  createdAt: Date
  expiresAt: Date
  usedAt: Date | null
}

/**
 * Backs login rate limiting / account lockout. One document per email,
 * TTL-expired automatically so a quiet account's history doesn't linger.
 */
export interface LoginAttemptDoc extends Document {
  _id: string
  count: number
  lockedUntil: Date | null
  expiresAt: Date
}

// ---------------------------------------------------------- tenant scoping --

/**
 * Wraps one collection so every operation is confined to one tenant. See the
 * isolation note at the top of this file — this is the whole mechanism.
 */
export class TenantScope<T extends Document> {
  constructor(
    private readonly col: Collection<T>,
    private readonly tenantId: string,
    private readonly session: ClientSession,
  ) {}

  private scope(filter: Filter<T>): Filter<T> {
    return { ...filter, tenantId: this.tenantId } as Filter<T>
  }

  find(filter: Filter<T> = {} as Filter<T>) {
    return this.col.find(this.scope(filter), { session: this.session })
  }

  findOne(filter: Filter<T> = {} as Filter<T>) {
    return this.col.findOne(this.scope(filter), { session: this.session })
  }

  /**
   * `tenantId` is set here, not accepted from the caller. The cast is
   * unavoidable, not a loophole: `T` is generic at this point, so nothing
   * outside this method can construct a document that skips `tenantId` —
   * every caller's document type still requires every other field of `T`.
   */
  async insertOne(doc: Omit<WithoutId<T>, 'tenantId'> & { _id: string }) {
    const withTenant = { ...doc, tenantId: this.tenantId } as unknown as OptionalUnlessRequiredId<T>
    return this.col.insertOne(withTenant, { session: this.session })
  }

  findOneAndUpdate(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options: FindOneAndUpdateOptions = {},
  ) {
    return this.col.findOneAndUpdate(this.scope(filter), update, {
      ...options,
      session: this.session,
    })
  }
}

export interface TenantContext {
  datasets: TenantScope<DatasetDoc>
  datasetVersions: TenantScope<DatasetVersionDoc>
  auditLog: TenantScope<AuditLogDoc>
  /** Scoped view for a signed-in admin managing their own school's staff. */
  memberships: TenantScope<MembershipDoc>
  /** Scoped view for a signed-in admin managing their own school's API keys. */
  apiKeys: TenantScope<ApiKeyDoc>
}

/**
 * Runs `fn` inside a MongoDB transaction (Atlas's free tier is a replica set,
 * so this works there too), with every collection pre-scoped to `tenantId`.
 * Mirrors the old Postgres `withTenant`: one call, no way to touch a
 * tenant-scoped collection without going through the scope.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (ctx: TenantContext) => Promise<T>,
): Promise<T> {
  const db = await getDb()
  const session = client.startSession()
  try {
    let result: T | undefined
    await session.withTransaction(async () => {
      result = await fn({
        datasets: new TenantScope(db.collection<DatasetDoc>('datasets'), tenantId, session),
        datasetVersions: new TenantScope(
          db.collection<DatasetVersionDoc>('datasetVersions'),
          tenantId,
          session,
        ),
        auditLog: new TenantScope(db.collection<AuditLogDoc>('auditLog'), tenantId, session),
        memberships: new TenantScope(db.collection<MembershipDoc>('memberships'), tenantId, session),
        apiKeys: new TenantScope(db.collection<ApiKeyDoc>('apiKeys'), tenantId, session),
      })
    })
    return result as T
  } finally {
    await session.endSession()
  }
}

export interface UnscopedDb {
  tenants: Collection<TenantDoc>
  users: Collection<UserDoc>
  memberships: Collection<MembershipDoc>
  refreshTokens: Collection<RefreshTokenDoc>
  /** Looked up by key hash, before the tenant it belongs to is known. */
  apiKeys: Collection<ApiKeyDoc>
  actionTokens: Collection<ActionTokenDoc>
  loginAttempts: Collection<LoginAttemptDoc>
}

/**
 * For the few operations that are legitimately tenant-less: authenticating by
 * email or API key, reading `tenants` itself, answering "which schools does
 * this user belong to?" during login (the one place Postgres needed a
 * SECURITY DEFINER escape hatch, because RLS otherwise refused to answer that
 * question before a tenant was known), and platform-admin operations that by
 * definition act across tenants. Nothing here bypasses tenant scoping on
 * `datasets` — that collection isn't exposed through this function at all.
 */
export async function withoutTenant<T>(fn: (db: UnscopedDb) => Promise<T>): Promise<T> {
  const database = await getDb()
  return fn({
    tenants: database.collection<TenantDoc>('tenants'),
    users: database.collection<UserDoc>('users'),
    memberships: database.collection<MembershipDoc>('memberships'),
    refreshTokens: database.collection<RefreshTokenDoc>('refreshTokens'),
    apiKeys: database.collection<ApiKeyDoc>('apiKeys'),
    actionTokens: database.collection<ActionTokenDoc>('actionTokens'),
    loginAttempts: database.collection<LoginAttemptDoc>('loginAttempts'),
  })
}
