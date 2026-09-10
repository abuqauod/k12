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

export type GuardianLanguage = 'en' | 'ar'

export interface Guardian {
  /** Stable id within the student's guardian list — so notification
   * preferences, the send log and the audit trail can name one guardian
   * without relying on array position. */
  id: string
  name: string
  relationship: string
  phone: string
  secondaryPhone: string | null
  email: string | null
  /** The contact a school calls first — a display/ordering hint only. It is
   * NOT how notification recipients are chosen (that is the per-channel
   * opt-in flags below), so a student is never left uncontactable because
   * the wrong box was ticked. At most one guardian should have this set;
   * enforced in application code (see students/routes.ts), not here. */
  isPrimary: boolean
  /** Which language this guardian's notifications are rendered in. */
  preferredLanguage: GuardianLanguage
  /** Per-channel opt-in. A guardian with neither set is never messaged. */
  notifyByEmail: boolean
  notifyBySms: boolean
  /** A former guardian kept for history — excluded from every notification. */
  active: boolean
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
  /**
   * `branchId` / `classId` / `academicYearId` / `studentGroup` are a
   * denormalised cache of the student's *active* enrollment (see
   * `EnrollmentDoc`). The enrollment is the source of truth for where a
   * student is and their history; these fields are kept in step with it on
   * every enrollment write (create / transfer / withdraw) so the common
   * "who is in class X right now" lookup and the timetable solver don't each
   * need a join. Never write them from a request body — always derive.
   */
  branchId: string
  classId: string
  academicYearId: string
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

export type AttendanceStatus =
  | 'present'
  | 'absent'
  | 'late'
  | 'excused'
  | 'early_departure'
// "unmarked" is not a stored value — it is the absence of a record for a
// (student, date). The register renders it; nothing writes it.

export interface AttendanceRecordDoc extends Document {
  /** `${tenantId}:${studentId}:${date}` — one record per student per day.
   * A backing unique index on `{tenantId, studentId, date}` (schema.ts)
   * makes a duplicate impossible even if a caller bypasses this id. */
  _id: string
  tenantId: string
  studentId: string
  /** Denormalised from the student's active enrollment at mark time, so a
   * day's / branch's register and the absence sweep are one indexed query,
   * and so the record still says which branch/class/year it belonged to
   * after the student moves. Kept as written — a later transfer does not
   * rewrite past attendance. */
  branchId: string
  classId: string
  academicYearId: string
  enrollmentId: string
  /** ISO yyyy-mm-dd — a day, not a timestamp; there is no time zone to get
   * wrong when the whole record is "this calendar day". */
  date: string
  status: AttendanceStatus
  note: string | null
  /** First mark. */
  markedBy: string
  markedAt: Date
  /** Last correction, if any — null on a record that was never changed. The
   * full before/after trail is in `attendanceCorrections`. */
  updatedBy: string | null
  updatedAt: Date | null
}

/**
 * One row per change to an existing attendance record — status or note. The
 * record itself always holds the current value; this is the trail of how it
 * got there, for the "who changed this and why" question a school will ask.
 */
export interface AttendanceCorrectionDoc extends Document {
  _id: string
  tenantId: string
  attendanceId: string
  studentId: string
  branchId: string
  date: string
  from: { status: AttendanceStatus; note: string | null }
  to: { status: AttendanceStatus; note: string | null }
  reason: string | null
  changedBy: string
  changedAt: Date
}

// ------------------------------------------------------------ enrollment --
// The record of a student being in one class, in one branch, for one
// academic year, over a date range. This — not the cache fields on
// `StudentDoc` — is the source of truth for where a student is and where
// they have been. At most one enrollment per (tenant, student) is `active`
// at a time (a partial unique index in schema.ts enforces it); a transfer
// closes the old one and opens a new one in the same transaction, so the
// history is continuous and nothing is lost when a student changes class or
// the year rolls over.

export type EnrollmentStatus = 'active' | 'withdrawn' | 'graduated' | 'transferred'

export interface EnrollmentDoc extends Document {
  _id: string
  tenantId: string
  studentId: string
  branchId: string
  classId: string
  academicYearId: string
  /** ISO yyyy-mm-dd. */
  startDate: string
  /** ISO yyyy-mm-dd, or null while still active. */
  endDate: string | null
  status: EnrollmentStatus
  /** For a `transferred` row: the enrollment it was replaced by. */
  supersededBy: string | null
  /** Free text captured on withdraw / transfer. */
  reason: string | null
  createdAt: Date
  createdBy: string | null
  updatedAt: Date
}

// -------------------------------------------------------- school calendar --
// Per-branch working week and holidays. The authority for "is `date` a
// session day for this branch" — consulted by the absence sweep (no point
// chasing absentees on a day off) and by enrollment date validation. One
// document per branch; `notificationSettings.schoolDays` is migrated into
// `workingDays` here and no longer read, so there is a single source of
// truth for the working week.

export interface SchoolHoliday {
  /** ISO yyyy-mm-dd. */
  date: string
  name: string
}

export interface SchoolCalendarDoc extends Document {
  /** `${tenantId}:${branchId}` — one per branch. */
  _id: string
  tenantId: string
  branchId: string
  /** 0 = Sunday … 6 = Saturday. A normal week's session days. */
  workingDays: number[]
  /** Specific non-session dates on top of the weekly pattern. */
  holidays: SchoolHoliday[]
  updatedAt: Date
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
// Delivery is a queue: an absence sweep (or the manual button) ENQUEUES one
// `NotificationJobDoc` per (student, guardian, channel, date); a separate
// worker drains the queue, recording a `NotificationAttemptDoc` per try and
// backing off between retries. This keeps enqueue fast and independent of a
// slow or failing provider, and lets several app instances process the
// queue at once — each job is claimed atomically (pending -> processing).
//
//   NotificationJob ──< NotificationAttempt >── Provider (channels.ts)
//
// `NotifyChannel` is `email | sms` today; WhatsApp / push are a new case in
// channels.ts plus a value here, not a schema change.

export type NotifyChannel = 'email' | 'sms'

export interface NotificationSettingsDoc extends Document {
  /** `${tenantId}:${branchId}` — one per branch. */
  _id: string
  tenantId: string
  branchId: string
  absenceNotifyEnabled: boolean
  /** "HH:mm" in the branch timezone. The sweep enqueues at or after this. */
  cutoffTime: string
  /** Channels to attempt for each guardian who has opted into them. */
  channels: NotifyChannel[]
  /** When true, a student with no record at all counts as absent for the
   * purpose of notifying; when false, only an explicit 'absent' does. */
  notifyOnUnmarked: boolean
  /**
   * @deprecated The working week now lives on `SchoolCalendarDoc.workingDays`
   * (migrated across, single source of truth). Kept on the type only so old
   * documents still parse; nothing reads it.
   */
  schoolDays?: number[]
  /** English templates. `{studentName} {date} {schoolName} {branchName}`. */
  emailSubject: string
  emailBody: string
  smsBody: string
  /** Arabic templates — used for a guardian whose `preferredLanguage` is
   * 'ar'. Blank falls back to the English template above. */
  emailSubjectAr: string
  emailBodyAr: string
  smsBodyAr: string
  /** ISO date the automatic sweep last enqueued for this branch — stops it
   * enqueueing twice in one day. */
  lastSweptDate: string | null
  updatedAt: Date
}

export type NotificationJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'dead'
  | 'skipped'

export interface NotificationJobDoc extends Document {
  /**
   * `${tenantId}:${branchId}:${studentId}:${date}:${channel}:${guardianId}`
   * — deterministic, so re-running a sweep for the same day re-touches the
   * same jobs instead of creating duplicates (`$setOnInsert`), and two app
   * instances enqueueing at once converge on the same set.
   */
  _id: string
  tenantId: string
  branchId: string
  studentId: string
  guardianId: string
  date: string
  channel: NotifyChannel
  /** Address or phone actually used. */
  to: string
  guardianName: string
  language: GuardianLanguage
  subject: string
  body: string
  status: NotificationJobStatus
  attempts: number
  maxAttempts: number
  /** When the worker may next try this job (backoff). Null once terminal. */
  nextAttemptAt: Date | null
  lastError: string | null
  /** The provider's own id for the accepted message, when it returns one. */
  providerMessageId: string | null
  /** 'auto' = the scheduled sweep; 'manual' = someone pressed the button. */
  trigger: 'auto' | 'manual'
  actorId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface NotificationAttemptDoc extends Document {
  _id: string
  tenantId: string
  jobId: string
  channel: NotifyChannel
  attemptNo: number
  status: 'sent' | 'failed'
  providerMessageId: string | null
  error: string | null
  startedAt: Date
  finishedAt: Date
}

/**
 * A coarse advisory lock, so the periodic work a single-writer design
 * assumed (the absence sweep deciding "enqueue today's jobs") stays
 * single-writer when the app runs as several instances. Whoever holds an
 * unexpired row owns the job; the row self-heals via `expiresAt` if the
 * holder dies mid-run. Per-notification idempotency does NOT depend on this
 * (the deterministic job `_id` does) — this only prevents duplicated work.
 */
export interface LockDoc extends Document {
  /** The lock name, e.g. "absence-sweep". */
  _id: string
  holder: string
  acquiredAt: Date
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

  /**
   * Scoped bulk update — for the "close every other active enrollment / unset
   * `current` on every other year" shape, where a per-doc loop would be
   * needless round-trips. Same forced tenant filter as everything else.
   */
  updateMany(filter: Filter<T>, update: UpdateFilter<T>) {
    return this.col.updateMany(this.scope(filter), update, { session: this.session })
  }

  countDocuments(filter: Filter<T> = {} as Filter<T>) {
    return this.col.countDocuments(this.scope(filter), { session: this.session })
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
  attendanceCorrections: TenantScope<AttendanceCorrectionDoc>
  enrollments: TenantScope<EnrollmentDoc>
  branches: TenantScope<BranchDoc>
  classes: TenantScope<SchoolClassDoc>
  schoolCalendars: TenantScope<SchoolCalendarDoc>
  notificationSettings: TenantScope<NotificationSettingsDoc>
  notificationJobs: TenantScope<NotificationJobDoc>
  notificationAttempts: TenantScope<NotificationAttemptDoc>
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
        attendanceCorrections: new TenantScope(
          db.collection<AttendanceCorrectionDoc>('attendanceCorrections'),
          tenantId,
          session,
        ),
        enrollments: new TenantScope(db.collection<EnrollmentDoc>('enrollments'), tenantId, session),
        branches: new TenantScope(db.collection<BranchDoc>('branches'), tenantId, session),
        classes: new TenantScope(db.collection<SchoolClassDoc>('classes'), tenantId, session),
        schoolCalendars: new TenantScope(
          db.collection<SchoolCalendarDoc>('schoolCalendars'),
          tenantId,
          session,
        ),
        notificationSettings: new TenantScope(
          db.collection<NotificationSettingsDoc>('notificationSettings'),
          tenantId,
          session,
        ),
        notificationJobs: new TenantScope(
          db.collection<NotificationJobDoc>('notificationJobs'),
          tenantId,
          session,
        ),
        notificationAttempts: new TenantScope(
          db.collection<NotificationAttemptDoc>('notificationAttempts'),
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
   * The absence-notification sweep is a vendor-level cron: it asks "which
   * branches, across every tenant, are due right now?" before any one
   * tenant's context exists — the same cross-tenant shape as `/admin/*`. It
   * reads branches / settings / calendars here to decide, then does the
   * per-branch enqueue work back inside `withTenant`. The queue worker
   * likewise claims and delivers jobs across all tenants (each job carries
   * its own `tenantId`), and takes the `absence-sweep` advisory lock so
   * multiple instances don't each enqueue the same day.
   */
  branches: Collection<BranchDoc>
  notificationSettings: Collection<NotificationSettingsDoc>
  schoolCalendars: Collection<SchoolCalendarDoc>
  notificationJobs: Collection<NotificationJobDoc>
  notificationAttempts: Collection<NotificationAttemptDoc>
  locks: Collection<LockDoc>
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
    schoolCalendars: database.collection<SchoolCalendarDoc>('schoolCalendars'),
    notificationJobs: database.collection<NotificationJobDoc>('notificationJobs'),
    notificationAttempts: database.collection<NotificationAttemptDoc>('notificationAttempts'),
    locks: database.collection<LockDoc>('locks'),
  })
}
