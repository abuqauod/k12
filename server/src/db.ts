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
   * Proven by clicking a real emailed link — accepting an invite or
   * resetting a password, both of which require receiving mail at this
   * address. False for a user created directly (seed, create-admin) until
   * they do one of those; not otherwise gated on anywhere yet, but recorded
   * so a future feature (or a support conversation) can tell a real invite
   * flow apart from a typo'd address that never got read.
   */
  emailVerified: boolean
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
  /**
   * Which branches this person can see and act in. `null` (or absent, for
   * memberships created before branches existed) means every branch — the
   * tenant-wide default an owner/admin normally wants. A non-empty array
   * confines them: a homeroom teacher assigned to one campus.
   */
  branchIds: string[] | null
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

// --------------------------------------------------------------------- SIS --
// Student records, academic years, and attendance. Deliberately real
// collections with real CRUD, not another key under the generic
// /datasets/:key blob sync that `fleet` and (the old) `students` used —
// attendance alone can run to hundreds of thousands of rows a year
// (252 students × ~180 school days), and needs per-day writes and
// server-side filtering that a single JSON blob with one revision number
// can't give: two teachers marking different classes the same morning would
// otherwise conflict with each other over one document.

export interface Guardian {
  name: string
  relationship: string
  phone: string
  secondaryPhone: string | null
  email: string | null
  /** The contact a school calls first. Exactly one guardian should have this
   * set; enforced in application code (see students/routes.ts), not here. */
  isPrimary: boolean
}

/**
 * Field names deliberately match the existing client-side `Student` type
 * (`timetable-ui/src/domain/students.ts`) — `givenName`/`studentGroup`/
 * `studentNumber`/`stopId`/`transportMode`, not `firstName`/`cohort`/
 * `admissionNumber`/nested `transport` — so the bus-routing solver and
 * RoutesPage, which already depend on that vocabulary, don't need to learn
 * a second one. This collection replaces the transport-only student roster
 * that used to live under the generic /datasets/:key blob sync (key
 * "students"); the new SIS fields (guardians, dob, ...) are additions to
 * the same shape, not a rename of it.
 */
export interface StudentDoc extends Document {
  _id: string
  tenantId: string
  /** School-assigned, human-facing — distinct from `_id`. Unique per tenant. */
  studentNumber: string
  givenName: string
  familyName: string
  givenNameAr: string | null
  familyNameAr: string | null
  dob: string | null
  gender: 'male' | 'female' | null
  /** Links to the timetable cohort, matching `Lesson.studentGroup`. */
  studentGroup: string
  status: 'enrolled' | 'graduated' | 'withdrawn' | 'inquiry'
  admissionDate: string | null
  address: string | null
  medicalNotes: string | null
  guardians: Guardian[]
  /** Where this student boards. Empty means not yet placed on a route. */
  stopId: string
  transportMode: 'TWO_WAY' | 'MORNING' | 'EVENING' | 'NONE'
  /** Required for an active student. The number called first if the bus is
   * delayed — kept even though `guardians` also carries phones, since the
   * bus-routing feature (RoutesPage, VRP solver) reads this flat pair
   * directly and predates the guardians model. */
  primaryPhone: string
  secondaryPhone: string
  createdAt: Date
  updatedAt: Date
}

export interface AcademicTerm {
  id: string
  name: string
  startDate: string
  endDate: string
}

export interface AcademicYearDoc extends Document {
  _id: string
  tenantId: string
  name: string
  startDate: string
  endDate: string
  terms: AcademicTerm[]
  /** At most one year per tenant should have this set — enforced in
   * application code (see academicYears/routes.ts), not here. */
  current: boolean
  createdAt: Date
}

export interface AttendanceRecordDoc extends Document {
  /** `${tenantId}:${studentId}:${date}` — one record per student per day,
   * so re-marking the same day is an update, not a duplicate. */
  _id: string
  tenantId: string
  studentId: string
  /** Denormalized from the student so a day's/branch's register and the
   * absence sweep don't each need a second lookup. Kept in step on write. */
  branchId: string
  classId: string
  /** ISO yyyy-mm-dd — a day, not a timestamp; there is no time zone to get
   * wrong when the whole record is "this calendar day". */
  date: string
  status: 'present' | 'absent' | 'late' | 'excused'
  note: string | null
  markedBy: string
  markedAt: Date
}

// ------------------------------------------------------------- branches --
// A tenant is one school *organisation*; a branch is one campus of it.
// Every tenant has at least one (a "Main" branch is backfilled for schools
// that predate the concept — see migrate.ts), so a single-campus school
// never has to think about branches. Classes, students and attendance all
// carry a branchId so finance and certificates can join on it later.

export interface BranchDoc extends Document {
  _id: string
  tenantId: string
  name: string
  /** Short, url-safe, unique within the tenant — used in the (cosmetic)
   * per-branch login path and anywhere a compact label is wanted. */
  code: string
  address: string | null
  /** IANA zone (e.g. "Asia/Amman"). The absence sweep reads "now" and the
   * cutoff time in this zone, so a 10:00 cutoff means 10:00 local. */
  timezone: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

/**
 * A homeroom / form class — the group a student belongs to for the daily
 * register, distinct from a timetable "room" (a physical space) and from
 * `Lesson.studentGroup` (a free-text label the solver uses). `studentGroup`
 * on a student is kept equal to `${gradeLevel} ${name}` so the two models
 * stay legible to each other.
 */
export interface SchoolClassDoc extends Document {
  _id: string
  tenantId: string
  branchId: string
  /** "KG1", "Grade 1" — the year; classes sharing one sit together in the UI. */
  gradeLevel: string
  /** "Stars", "A" — the section within the grade. */
  name: string
  /** Seats. Enrolment past this is allowed but flagged. */
  capacity: number
  /** A membership userId, or null if not assigned yet. */
  homeroomTeacherId: string | null
  academicYearId: string | null
  active: boolean
  createdAt: Date
  updatedAt: Date
}

// -------------------------------------------------------- notifications --
// Per-branch settings for the unexplained-absence follow-up, plus a log row
// for every message the system sends (or tries to). The log doubles as the
// idempotency record: a student with a 'sent' row for a date is not
// contacted again for that date.

export type NotifyChannel = 'email' | 'sms'

export interface NotificationSettingsDoc extends Document {
  /** `${tenantId}:${branchId}` — one per branch. */
  _id: string
  tenantId: string
  branchId: string
  absenceNotifyEnabled: boolean
  /** "HH:mm" in the branch timezone. The sweep runs at or after this. */
  cutoffTime: string
  /** Channels to attempt, in order. SMS is accepted here but not yet wired
   * to a provider — see notifications/channels.ts. */
  channels: NotifyChannel[]
  /** When true, a student with no record at all counts as absent for the
   * purpose of notifying; when false, only an explicit 'absent' does. */
  notifyOnUnmarked: boolean
  /** 0 = Sunday … 6 = Saturday. Days the sweep runs. */
  schoolDays: number[]
  emailSubject: string
  emailBody: string
  smsBody: string
  /** ISO date the automatic sweep last ran for this branch — stops it
   * firing twice in one day. */
  lastSweptDate: string | null
  updatedAt: Date
}

export interface NotificationLogDoc extends Document {
  /** `${tenantId}:${branchId}:${studentId}:${date}:${channel}` — idempotent
   * per student per day per channel. */
  _id: string
  tenantId: string
  branchId: string
  studentId: string
  date: string
  channel: NotifyChannel
  /** The address or number actually used. */
  to: string
  guardianName: string
  status: 'sent' | 'failed' | 'skipped'
  error: string | null
  /** 'auto' = the scheduled sweep; 'manual' = someone pressed the button. */
  trigger: 'auto' | 'manual'
  actorId: string | null
  createdAt: Date
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

  /**
   * Scoped delete. Added late and used sparingly — most "removals" here are a
   * status flip, not an erase — but a few things (an empty class, a mis-typed
   * branch) genuinely have no reason to linger. The tenant filter is forced
   * in exactly as it is for reads, so this can't reach another tenant's row.
   */
  deleteOne(filter: Filter<T>) {
    return this.col.deleteOne(this.scope(filter), { session: this.session })
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
  students: TenantScope<StudentDoc>
  academicYears: TenantScope<AcademicYearDoc>
  attendance: TenantScope<AttendanceRecordDoc>
  branches: TenantScope<BranchDoc>
  classes: TenantScope<SchoolClassDoc>
  notificationSettings: TenantScope<NotificationSettingsDoc>
  notificationLog: TenantScope<NotificationLogDoc>
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
        students: new TenantScope(db.collection<StudentDoc>('students'), tenantId, session),
        academicYears: new TenantScope(db.collection<AcademicYearDoc>('academicYears'), tenantId, session),
        attendance: new TenantScope(db.collection<AttendanceRecordDoc>('attendance'), tenantId, session),
        branches: new TenantScope(db.collection<BranchDoc>('branches'), tenantId, session),
        classes: new TenantScope(db.collection<SchoolClassDoc>('classes'), tenantId, session),
        notificationSettings: new TenantScope(
          db.collection<NotificationSettingsDoc>('notificationSettings'),
          tenantId,
          session,
        ),
        notificationLog: new TenantScope(
          db.collection<NotificationLogDoc>('notificationLog'),
          tenantId,
          session,
        ),
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
  /**
   * The absence-notification sweep is a vendor-level cron: it has to ask
   * "which branches, across every tenant, are due a sweep right now?" before
   * any one tenant's context exists — the same cross-tenant shape as
   * `/admin/*`. It reads these two here, then does the per-branch work
   * (students, attendance, log writes) back inside `withTenant`.
   */
  branches: Collection<BranchDoc>
  notificationSettings: Collection<NotificationSettingsDoc>
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
    branches: database.collection<BranchDoc>('branches'),
    notificationSettings: database.collection<NotificationSettingsDoc>('notificationSettings'),
  })
}
