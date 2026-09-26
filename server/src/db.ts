import { GridFSBucket, MongoClient } from 'mongodb'
import type { RoleKey } from './auth/scopes.js'
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

/** A GridFS bucket on the app database. Only `documents/store.ts` uses
 * this: GridFS has no tenant scope of its own, so that module stamps every
 * file with its tenant and checks it on every read (see the note there). */
export async function gridFsBucket(bucketName: string): Promise<GridFSBucket> {
  return new GridFSBucket(await getDb(), { bucketName })
}

export async function ping(): Promise<void> {
  const db = await getDb()
  await db.command({ ping: 1 })
}

// --------------------------------------------------------------- admissions --

/** SAMS 2.5. `converted` is final: the applicant is now a student. */
export type ApplicationStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'accepted'
  | 'rejected'
  | 'waitlisted'
  | 'converted'
  | 'withdrawn'

/** A parent or guardian named on an application. `existingParentId` links
 * to a parent already on file (a sibling's family); otherwise conversion
 * creates one. */
export interface ApplicationGuardian {
  id: string
  fullName: string
  relationship: string
  phone: string
  email: string | null
  preferredLanguage: GuardianLanguage
  primaryContact: boolean
  existingParentId: string | null
}

export interface ApplicationDoc extends Document {
  _id: string
  tenantId: string
  /** APP-000123, per tenant. */
  applicationNumber: string
  branchId: string
  academicYearId: string
  /** The grade applied for, e.g. "Grade 3" — a class is chosen on conversion. */
  gradeLevel: string
  applicant: {
    givenName: string
    familyName: string
    givenNameAr: string | null
    familyNameAr: string | null
    dob: string | null
    gender: 'male' | 'female' | null
    nationality: string | null
    nationalId: string | null
    previousSchool: string | null
  }
  guardians: ApplicationGuardian[]
  /** An `admissionSource` settings-list code. */
  source: string | null
  notes: string | null
  /** `documentCategory` codes this applicant must provide (the checklist). */
  requiredDocuments: string[]
  status: ApplicationStatus
  decision: {
    outcome: 'accepted' | 'rejected' | 'waitlisted'
    note: string | null
    decidedBy: string
    decidedAt: Date
    approvalRequestId: string
  } | null
  submittedAt: Date | null
  convertedStudentId: string | null
  convertedAt: Date | null
  withdrawnReason: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

// --------------------------------------------------------------- documents --

export interface TenantProfile {
  nameAr: string | null
  phone: string | null
  email: string | null
  address: string | null
  website: string | null
  taxNumber: string | null
}

export interface TenantDoc extends Document {
  _id: string
  slug: string
  name: string
  /** School-editable contact details (SAMS 1.11, PATCH /tenant). Everything
   * else on this document stays vendor-only. */
  profile?: TenantProfile
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
  /** Named role preset (SAMS 1.8). Absent/null = scopes come from `role`
   * alone, exactly as before presets existed. When set, `role` holds the
   * preset's base rank. See auth/scopes.ts. */
  roleKey?: RoleKey | null
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
  /** Denormalized from the mutation's own branch context, so the audit feed
   * can be branch-filtered the same way finance/attendance already are.
   * Null for tenant-wide actions and for every row recorded before this
   * field existed — never backfilled, same "kept as written" convention as
   * `AttendanceRecordDoc.branchId`. */
  branchId: string | null
  meta: Record<string, unknown>
  /** Who and where (SAMS 1.12): the client IP and user agent of the request
   * that made the change; null for background jobs and rows written before
   * these existed (never backfilled). */
  ip?: string | null
  userAgent?: string | null
  /** Why — required on sensitive actions (void, withdraw, delete, archive). */
  reason?: string | null
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
  grant: {
    tenantId: string
    role: MembershipDoc['role']
    roleKey?: RoleKey | null
    branchIds?: string[] | null
  } | null
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
/** SAMS 2.2: someone to call in an emergency who is not necessarily a
 * parent or guardian (a grandparent, a neighbour). */
export interface EmergencyContact {
  id: string
  name: string
  relationship: string
  phone: string
  alternatePhone: string | null
  notes: string | null
}

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
  /**
   * The old per-student guardian list. SAMS 2.3 moved every guardian onto
   * a parent link (`ParentStudentLinkDoc`, backfill.ts's
   * `retireEmbeddedGuardians`), which renames this to `legacyGuardians`.
   * Present only on a record the migration hasn't reached yet; nothing
   * writes it any more.
   */
  guardians?: Guardian[]
  /** The frozen pre-2.3 guardian list, kept as history. Never read by the app. */
  legacyGuardians?: Guardian[]
  // SAMS 2.2 profile. Optional: records created before 2.2 lack them, and
  // every reader treats a missing field as null / [].
  preferredName?: string | null
  nationality?: string | null
  nationalId?: string | null
  /** An `admissionSource` lookup code (settings lists, SAMS 1.11). */
  admissionSource?: string | null
  previousSchool?: string | null
  emergencyContacts?: EmergencyContact[]
  /** Custody or pickup restrictions ("father may not collect"). Returned
   * and editable only with `students.custody`, and its text never enters
   * the audit log (only that it changed). */
  custodyNotes?: string | null
  /** Where this student boards. Empty means not yet placed on a route. */
  stopId: string
  transportMode: 'TWO_WAY' | 'MORNING' | 'EVENING' | 'NONE'
  /** The student's own pickup point, set by dragging a pin on the routes map
   * (RoutesPage / StudentDetailDialog) — independent of `stopId`, which is a
   * reference into the client-held fleet stop list. Null until set. */
  lat: number | null
  lng: number | null
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

/**
 * `pending`: planned, not started (next year's place, a re-enrollment not
 * yet begun) — it doesn't touch the student's cached class. `cancelled`: a
 * pending row that won't happen; kept, never deleted (SAMS 2.4).
 * `completed`: closed at year end when next year's place started (2.6).
 */
export type EnrollmentStatus =
  | 'active'
  | 'pending'
  | 'withdrawn'
  | 'graduated'
  | 'transferred'
  | 'cancelled'
  /** SAMS 2.6: the year finished and the student moved on to next year's
   * enrollment (promoted or held back). */
  | 'completed'

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
  /** Free text captured on withdraw / transfer / cancel. */
  reason: string | null
  /** A `withdrawalReason` settings-list code, on a withdrawn row (SAMS
   * 2.4). Absent on rows written before it existed. */
  reasonCode?: string | null
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

// --------------------------------------------------------------- parents --
// A parent/guardian as a real, independent record — distinct from the
// embedded `Guardian[]` on `StudentDoc`, which continues to drive absence
// notifications unchanged (notifyByEmail/notifyBySms/preferredLanguage are
// read directly by the sweep — see notifications/sweep.ts). This collection
// is the actual Parent Management feature: many-to-many with students via
// `ParentStudentLinkDoc`, never a duplicated blob on either side. It is the
// join a future Payments/Finance module (Parent -> Students -> Enrollment ->
// Fees -> Invoices -> Payments) will read `financialResponsibility` from to
// decide who is billed for a student.

export type ParentStatus = 'active' | 'inactive' | 'archived'
export type PreferredContactMethod = 'phone' | 'email' | 'sms' | 'whatsapp'

export interface ParentDoc extends Document {
  _id: string
  tenantId: string
  fullName: string
  fullNameAr: string | null
  nationalId: string | null
  primaryPhone: string
  alternativePhone: string | null
  email: string | null
  address: string | null
  city: string | null
  preferredContactMethod: PreferredContactMethod
  /** Language for messages to this parent (absence notifications). Absent
   * on records created before SAMS 2.3: read as 'en'. */
  preferredLanguage?: GuardianLanguage
  /** `archived` is a status flip, never a delete — historical
   * `ParentStudentLinkDoc` rows referencing this id must keep resolving. */
  status: ParentStatus
  occupation: string | null
  employer: string | null
  emergencyContactName: string | null
  emergencyContactPhone: string | null
  notes: string | null
  /**
   * Account-level placeholder for a future parent portal. `enabled` is a
   * flag only — nothing authenticates against it yet. `userId` stays null
   * until a real portal-login feature links this parent to a `UserDoc`.
   * Distinct from `ParentStudentLinkDoc.portalAccess`, which is
   * per-relationship ("may this parent see *this* student's data").
   */
  portalAccess: { enabled: boolean; userId: string | null }
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
  archivedAt: Date | null
  archivedBy: string | null
}

/**
 * The many-to-many join: one student can have several parents, one parent
 * several students. This — not a duplicated blob on either side — is the
 * real relationship. Unique on (tenantId, parentId, studentId) regardless of
 * `active`, so "removing" a relationship is always a flip to `active: false`
 * and "restoring" it flips back, never a second insert — the DB-level
 * backstop for never losing relationship history (see schema.ts).
 */
export interface ParentStudentLinkDoc extends Document {
  _id: string
  tenantId: string
  parentId: string
  studentId: string
  /** Free text, same convention as `Guardian.relationship` — "Father",
   * "Mother", "Legal Guardian", not a closed enum. */
  relationshipType: string
  primaryContact: boolean
  secondaryContact: boolean
  emergencyContact: boolean
  authorizedPickup: boolean
  /** Anticipates Finance: who is billed for this student. Setting this to
   * `true` requires `admin` — see `auth/guard.ts`'s `roleAtLeast` and the
   * inline check in `parents/routes.ts`. */
  financialResponsibility: boolean
  communicationPermissions: { email: boolean; sms: boolean }
  /** Per-relationship portal grant — may this parent see/act on *this*
   * student via the future portal. Requires `admin` to set, same reasoning
   * as `financialResponsibility`. */
  portalAccess: boolean
  /** A former relationship kept for history, never deleted. */
  active: boolean
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
}

// --------------------------------------------------------------- finance --
// Fee structures, invoices, payments and receipts — the "core loop" of
// Finance & Accounting. Reads `ParentStudentLinkDoc.financialResponsibility`
// (above) to know who is billed, but nothing here writes to students/,
// parents/, or enrollments/ — this module is a consumer of the SIS, the
// same relationship parents/ has to students/.
//
// Money is stored as an integer in the tenant's smallest currency unit
// (fils/cents — "minor units"), never a float: summing many invoice lines
// and payments over months of partial payments would otherwise accumulate
// floating-point drift. Every amount field in this section is minor units;
// conversion to a displayed major-unit amount happens only at the UI
// boundary (timetable-ui/src/domain/finance.ts).

/** A `paymentMethod` lookup code (SAMS 1.11) — the built-ins are cash,
 * bank_transfer, card, cheque, other; schools may add their own. */
export type PaymentMethod = string

/** SAMS 1.11: one tenant-scoped collection for every settings list. A kind
 * (paymentMethod, documentCategory, …) is registered in
 * settings/lookups.ts; entries are never deleted, only deactivated, so
 * records that reference a code keep resolving. */
export interface LookupDoc extends Document {
  _id: string
  tenantId: string
  kind: string
  /** Immutable, unique per tenant + kind; what other records store. */
  code: string
  label: string
  labelAr: string | null
  active: boolean
  order: number
  /** Seeded default rather than school-created. */
  builtIn: boolean
  createdAt: Date
  updatedAt: Date
}
export type InvoiceStatus = 'open' | 'partially_paid' | 'paid' | 'void'

// --------------------------------------------------------------- documents --

/** SAMS 2.1: records a document can be attached to. Staff and applications
 * join this list in later phases. */
export type DocumentOwnerType = 'student' | 'parent' | 'application' | 'scholarship' | 'expense' | 'employee'
export type DocumentVerificationStatus = 'unverified' | 'verified' | 'rejected'

/**
 * One version of one uploaded document. The bytes live in the document
 * store (GridFS today, see documents/store.ts); this row is the metadata.
 * Uploading a replacement adds a row with the same `seriesId` and the next
 * `version` and clears `isCurrent` on the previous one, so history is
 * never overwritten. Archiving flags every version of the series; nothing
 * is deleted.
 */
export interface DocumentDoc extends Document {
  _id: string
  tenantId: string
  ownerType: DocumentOwnerType
  ownerId: string
  /** The owner's branch at upload, for the audit feed and lists. Access is
   * always re-checked against the live owner, never this copy. */
  branchId: string | null
  /** A `documentCategory` lookup code (SAMS 1.11). */
  categoryCode: string
  seriesId: string
  version: number
  isCurrent: boolean
  fileId: string
  fileName: string
  /** Detected from the file's own bytes, never taken from the client. */
  mime: string
  size: number
  sha256: string
  /** YYYY-MM-DD, for documents that lapse (IDs, medical forms). */
  expiresAt: string | null
  verification: {
    status: DocumentVerificationStatus
    by: string | null
    at: Date | null
    note: string | null
  }
  uploadedBy: string
  createdAt: Date
  archivedAt: Date | null
  archivedBy: string | null
}

// --------------------------------------------------------------- approvals --

/** SAMS 1.10: one shared approval mechanism. A module registers a type
 * (server/src/approvals/registry.ts); requests of every type live here. */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface ApprovalComment {
  id: string
  actorId: string
  body: string
  at: Date
  kind: 'request' | 'approve' | 'reject' | 'cancel'
}

export interface ApprovalRequestDoc extends Document {
  _id: string
  tenantId: string
  type: string
  entity: string
  entityId: string
  /** Resolved from the entity at request time, for branch isolation. */
  branchId: string | null
  status: ApprovalStatus
  /** Type-specific, validated by the type's schema; stored as submitted. */
  payload: Record<string, unknown>
  /** Short label for queues, so they need no per-type rendering. */
  summary: string
  /** One pending request per key (partial unique index), e.g. per line. */
  dedupeKey: string
  requestedBy: string
  decidedBy: string | null
  decidedAt: Date | null
  comments: ApprovalComment[]
  /** Compare-and-set guard: every transition bumps it. */
  version: number
  createdAt: Date
  updatedAt: Date
}
export type DiscountType = 'amount' | 'percent'

/**
 * A reusable price list for one grade, at one branch, for one academic
 * year — not per class section. `SchoolClassDoc.gradeLevel` already groups
 * sections that share a curriculum year ("Grade 3 A" / "Grade 3 B" both
 * have `gradeLevel: "Grade 3"`), and tuition/transport/activity fees are
 * set per grade in practice, not per section. A per-class override, if a
 * school ever needs one, is an additive field later (old documents
 * implicitly apply to the whole grade) — not a migration.
 */
export interface FeeStructureLineItem {
  /** Stable id within the structure, so an invoice line generated from it
   * can record `sourceFeeItemId` and survive the template being edited
   * later. */
  id: string
  label: string
  labelAr: string | null
  /** Minor units. */
  amount: number
}

export interface FeeStructureDoc extends Document {
  _id: string
  tenantId: string
  branchId: string
  academicYearId: string
  /** Matches `SchoolClassDoc.gradeLevel` exactly — not validated against
   * the live set of classes (a fee structure can exist before any class
   * for that grade does), but expected to line up so invoice generation's
   * mismatch check (finance/service.ts) is meaningful. */
  gradeLevel: string
  name: string
  lineItems: FeeStructureLineItem[]
  /** A former structure kept for history — invoices already generated from
   * it keep resolving; never deleted, only deactivated (same "archived,
   * never erased" convention as `ParentDoc.status`). */
  active: boolean
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
}

/**
 * One line on an invoice. Either copied from a `FeeStructureLineItem` at
 * generation time (`sourceFeeItemId` set) or added after generation as a
 * one-off adjustment (`sourceFeeItemId` null — real schools always have
 * one-off adjustments). `netAmount` is denormalized (amount minus the
 * computed discount, floored at 0) so nothing reading an invoice ever has
 * to redo discount math; it is recomputed by finance/service.ts on every
 * write to this line.
 */
export interface InvoiceLineItem {
  id: string
  label: string
  labelAr: string | null
  sourceFeeItemId: string | null
  /** Minor units. */
  amount: number
  /** Setting or changing this requires admin+ — see finance/routes.ts, same
   * inline-check idiom as parents/routes.ts's `financialResponsibility`.
   * Not a separate scholarship entity (out of scope for this PR) — just a
   * per-line reduction. */
  discount: { type: DiscountType; value: number } | null
  /** Minor units. */
  netAmount: number
}

/** SAMS 3.2: an invoice-level reduction from a named discount type or an
 * approved scholarship. `amount` is recomputed on every invoice write
 * (finance/service.ts `price`): a percent applies to the lines' net sum. */
export interface InvoiceAdjustment {
  id: string
  source: 'discount' | 'scholarship'
  /** `DiscountTypeDoc._id` or `ScholarshipDoc._id`. */
  refId: string
  label: string
  type: DiscountType
  value: number
  /** Minor units. */
  amount: number
  appliedAt: Date
  appliedBy: string | null
}

/** SAMS 3.1: one dated part of an invoice's total. */
export interface InvoiceInstallment {
  id: string
  /** ISO yyyy-mm-dd. */
  dueDate: string
  /** Minor units. */
  amount: number
}

/**
 * One student, one billing period (one academic year — nothing outside
 * `academicYears/routes.ts` reads `AcademicYearDoc.terms` today, confirmed
 * by grep, so per-term billing is not what this bills against).
 * `branchId`/`academicYearId` are captured from the student's active
 * enrollment at generation time and then kept as issued — a later transfer
 * does not rewrite a past invoice, same "kept as written" reasoning as
 * `AttendanceRecordDoc`.
 */
export interface InvoiceDoc extends Document {
  _id: string
  tenantId: string
  studentId: string
  branchId: string
  academicYearId: string
  /** Forward-hook, always null today — real per-term billing is out of
   * this PR's scope. Kept so a later feature is additive, not a
   * migration, same idiom as `ParentStudentLinkDoc.financialResponsibility`
   * being a hook before this PR existed. */
  termId: string | null
  /** The template this was generated from, or null for an invoice built
   * entirely from one-off lines. Null does not mean anything went wrong —
   * kept only so the UI can show provenance. */
  feeStructureId: string | null
  /** Human-facing, sequential, unique per tenant — see `FinanceCounterDoc`.
   * Never re-used, even if the invoice is later voided. */
  invoiceNumber: string
  issueDate: string
  dueDate: string | null
  lineItems: InvoiceLineItem[]
  /** Minor units — sum of `lineItems[].netAmount`, denormalized and
   * recomputed on every line-item write in the same transaction. */
  total: number
  /** SAMS 3.1 installment plan; absent or empty = one payment by dueDate.
   * Its amounts sum to `total` when set; a later line change that moves
   * the total leaves the plan flagged as not matching until it is redone. */
  installments?: InvoiceInstallment[]
  /** SAMS 3.2; absent = none. `total` is the lines' net sum less these. */
  adjustments?: InvoiceAdjustment[]
  status: InvoiceStatus
  notes: string | null
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
  voidedAt: Date | null
  voidedBy: string | null
}

/**
 * One payment against one invoice — full or partial; several rows per
 * invoice is the normal partial-payment case, not an edge case. `studentId`
 * is denormalized from the invoice so "this student's payment history" is
 * one indexed query, not a join through invoices (same reasoning as
 * `AttendanceRecordDoc.branchId`).
 */
export type PaymentConfirmation = 'pending' | 'confirmed' | 'rejected'

export interface PaymentDoc extends Document {
  _id: string
  tenantId: string
  invoiceId: string
  studentId: string
  /** Minor units. */
  amount: number
  method: PaymentMethod
  /** Cheque number, transfer reference, card auth code — free text. */
  reference: string | null
  /** ISO yyyy-mm-dd the payment was actually received, which may differ
   * from `createdAt` (a late-entered cash payment). */
  paidAt: string
  /** Who physically paid — written down at the cash desk, independent of
   * `payerParentId` below (not every payer is a system parent record). */
  payerName: string
  /** Best-effort match against an active, financially-responsible
   * `ParentStudentLinkDoc` for this student at record time — informational
   * only, never required to resolve. Null if none matched. */
  payerParentId: string | null
  notes: string | null
  receivedBy: string | null
  /** SAMS 3.4: payments taken together (one amount spread over several
   * invoices) share it, and one receipt. Absent on older payments. */
  batchId?: string
  /** SAMS 3.4: a cheque or transfer can wait for confirmation; until it is
   * confirmed it counts toward nothing and has no receipt. Absent =
   * confirmed (every payment before 3.4). */
  confirmation?: PaymentConfirmation
  confirmedAt?: Date | null
  confirmedBy?: string | null
  createdAt: Date
  /** A mis-recorded payment is voided (money actually handed back is a
   * refund, SAMS 3.3), never edited, so the audit trail always shows what
   * was really entered and when it was reversed. */
  voidedAt: Date | null
  voidedBy: string | null
}

/**
 * A structured receipt *record* generated as a side effect of recording a
 * payment — never created standalone, so an orphan receipt with no
 * matching payment is impossible. Deliberately not a stored PDF: no PDF
 * library exists anywhere in this codebase (confirmed by grep), so the UI
 * renders/prints this from structured data in the browser instead of the
 * app generating a document server-side. Denormalizes amount/method/
 * studentId off the payment on purpose (same "kept as written" reasoning
 * as `PaymentDoc.voidedAt` above) — a receipt already handed to a parent
 * must keep showing what it said at issue time even if the payment is
 * later voided.
 */
export interface ReceiptDoc extends Document {
  _id: string
  tenantId: string
  paymentId: string
  invoiceId: string
  studentId: string
  receiptNumber: string
  /** Minor units. */
  amount: number
  method: PaymentMethod
  payerName: string
  issueDate: string
  /** SAMS 3.4: how the amount was spread; one entry for a single invoice.
   * Absent on older receipts. */
  allocations?: { paymentId: string; invoiceId: string; invoiceNumber: string; amount: number }[]
  createdAt: Date
  createdBy: string | null
}

/**
 * Backs sequential, human-facing `invoiceNumber`/`receiptNumber` — the one
 * new mechanism this section introduces that has no existing precedent in
 * this codebase (everything else here uses `randomUUID()`). `_id` is
 * `` `${tenantId}:${kind}` `` (`kind` is `'invoiceNumber'` or
 * `'receiptNumber'`), same composite-key convention as `DatasetDoc`/
 * `SchoolCalendarDoc` — required because a bare `_id` like
 * `"invoiceNumber"` would collide across tenants in the shared collection.
 */
export interface FinanceCounterDoc extends Document {
  _id: string
  tenantId: string
  seq: number
}

/** SAMS 3.2: a named, reusable discount (sibling, staff child, early
 * payment…) applied to invoices as an adjustment. Deactivated, never
 * deleted, so invoices keep pointing at it. */
export interface DiscountTypeDoc extends Document {
  _id: string
  tenantId: string
  name: string
  nameAr: string | null
  type: DiscountType
  value: number
  active: boolean
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
}

/** SAMS 3.2/3.3/3.5: records that go through an approval (1.10). They are
 * created `pending` together with their approval request; the request's
 * outcome moves them on. */
export type ScholarshipStatus = 'pending' | 'active' | 'rejected' | 'cancelled' | 'revoked'
export type RefundStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'paid'
export type ExpenseStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'paid'

/** A formal award for one student for one academic year. Once approved it
 * applies to every non-void invoice of that student and year, including
 * ones generated later. Supporting documents attach to it (2.1). */
export interface ScholarshipDoc extends Document {
  _id: string
  tenantId: string
  studentId: string
  branchId: string
  academicYearId: string
  name: string
  type: DiscountType
  value: number
  reason: string
  status: ScholarshipStatus
  requestedBy: string
  decidedBy: string | null
  decidedAt: Date | null
  revokedAt: Date | null
  revokedBy: string | null
  revokeReason: string | null
  createdAt: Date
  updatedAt: Date
}

/** Money returned against an invoice: requested, approved, then paid out.
 * Only a paid refund reduces what the invoice has been paid. */
export interface RefundDoc extends Document {
  _id: string
  tenantId: string
  refundNumber: string
  invoiceId: string
  studentId: string
  branchId: string
  /** Minor units. */
  amount: number
  reason: string
  status: RefundStatus
  requestedBy: string
  decidedBy: string | null
  decidedAt: Date | null
  /** ISO yyyy-mm-dd, set when paid out. */
  paidAt: string | null
  paidBy: string | null
  method: PaymentMethod | null
  reference: string | null
  createdAt: Date
  updatedAt: Date
}

export interface VendorDoc extends Document {
  _id: string
  tenantId: string
  name: string
  contactName: string | null
  phone: string | null
  email: string | null
  taxNumber: string | null
  notes: string | null
  active: boolean
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
}

/** Money the school spends: submitted, approved, then paid. */
export interface ExpenseDoc extends Document {
  _id: string
  tenantId: string
  expenseNumber: string
  branchId: string
  /** An `expenseCategory` lookup code (SAMS 1.11). */
  categoryCode: string
  vendorId: string | null
  description: string
  /** Minor units. */
  amount: number
  /** ISO yyyy-mm-dd the cost was incurred. */
  expenseDate: string
  /** The vendor's own invoice number, if any. */
  reference: string | null
  status: ExpenseStatus
  requestedBy: string
  decidedBy: string | null
  decidedAt: Date | null
  paidAt: string | null
  paidBy: string | null
  method: PaymentMethod | null
  paymentReference: string | null
  createdAt: Date
  updatedAt: Date
}

// -------------------------------------------------------------------- hr --
// SAMS Phase 4. An employee is a person the school employs, kept apart from
// `MembershipDoc` (a login): many staff never sign in, and a login can be
// linked to its employee record through `userId`. Departments, positions,
// and contract types are settings lists (1.11); leave types
// carry an entitlement, so they have their own collection.

export type EmployeeStatus = 'active' | 'terminated'

export interface EmployeeDoc extends Document {
  _id: string
  tenantId: string
  /** EMP-000001, sequential per tenant. */
  employeeNumber: string
  /** The branch the employee works at. */
  branchId: string
  givenName: string
  familyName: string
  fullNameAr: string | null
  gender: 'male' | 'female' | null
  dob: string | null
  nationality: string | null
  nationalId: string | null
  phone: string | null
  email: string | null
  address: string | null
  /** `department` / `position` lookup codes. */
  departmentCode: string | null
  positionCode: string | null
  hireDate: string
  status: EmployeeStatus
  terminationDate: string | null
  terminationReason: string | null
  /** Optional link to a login (UserDoc._id) — for self-service leave. */
  userId: string | null
  emergencyContactName: string | null
  emergencyContactPhone: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
}

/** One employment contract. Never edited away: a renewal is a new row and
 * the old one is closed as `renewed`. At most one contract per employee
 * covers any given day. */
export interface ContractDoc extends Document {
  _id: string
  tenantId: string
  employeeId: string
  /** The employee's branch when the contract was made, for isolation. */
  branchId: string
  /** A `contractType` lookup code. */
  typeCode: string
  startDate: string
  /** Null = open-ended. */
  endDate: string | null
  /** Monthly, minor units; visible only with `hr.salary.read`. */
  salary: number | null
  hoursPerWeek: number | null
  notes: string | null
  closedReason: 'renewed' | 'terminated' | 'ended' | null
  closedAt: Date | null
  renewedFromId: string | null
  createdAt: Date
  createdBy: string | null
}

export type EmploymentEventType =
  | 'hire'
  | 'branch_change'
  | 'department_change'
  | 'position_change'
  | 'contract_start'
  | 'contract_renew'
  | 'contract_end'
  | 'terminate'
  | 'rehire'

/** Employment history: what changed and when, written with each change. */
export interface EmploymentEventDoc extends Document {
  _id: string
  tenantId: string
  employeeId: string
  branchId: string
  type: EmploymentEventType
  /** ISO yyyy-mm-dd the change took effect. */
  date: string
  from: string | null
  to: string | null
  note: string | null
  actorId: string | null
  createdAt: Date
}

export interface LeaveTypeDoc extends Document {
  _id: string
  tenantId: string
  /** Immutable, unique per tenant; what requests store. */
  code: string
  name: string
  nameAr: string | null
  /** Working days per calendar year; null = not limited (e.g. unpaid). */
  daysPerYear: number | null
  paid: boolean
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface LeaveRequestDoc extends Document {
  _id: string
  tenantId: string
  employeeId: string
  branchId: string
  typeCode: string
  startDate: string
  endDate: string
  /** Working days in the range (branch calendar), fixed at request time. */
  days: number
  reason: string | null
  status: LeaveStatus
  requestedBy: string
  decidedBy: string | null
  decidedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** A change to a balance on top of the yearly entitlement (carry-over,
 * correction). Days may be negative. */
export interface LeaveAdjustmentDoc extends Document {
  _id: string
  tenantId: string
  employeeId: string
  branchId: string
  typeCode: string
  year: number
  days: number
  reason: string
  createdAt: Date
  createdBy: string | null
}

export type StaffAttendanceStatus = 'present' | 'absent' | 'late' | 'excused' | 'leave'

export interface StaffAttendanceDoc extends Document {
  _id: string
  tenantId: string
  employeeId: string
  branchId: string
  date: string
  status: StaffAttendanceStatus
  /** "HH:MM", optional. */
  checkIn: string | null
  checkOut: string | null
  note: string | null
  recordedBy: string | null
  updatedAt: Date
}

// ----------------------------------------------------------- transport --
// Bus routing — depot/buses/stops/routing-rules for one branch. Previously
// existed only as an opaque JSON blob synced through the generic
// `/datasets/:key` endpoint (see datasets/routes.ts), with no real branch
// scoping, permission gating, or audit trail — the last module in the app
// built that way. This is its real, first-class replacement: `BusDoc` and
// `StopDoc` are ordinary branch-scoped collections (soft-deactivated, same
// "archived, never erased" convention as `ParentDoc`/`FeeStructureDoc`), and
// `TransportSettingsDoc` is a per-branch settings singleton, same shape as
// `NotificationSettingsDoc`. The actual vehicle-routing computation (which
// bus visits which stop, in what order) stays entirely client-side — nothing
// here persists a solved route, only the inputs to computing one.

export interface BusDoc extends Document {
  _id: string
  tenantId: string
  branchId: string
  name: string
  seats: number
  /** A former bus kept for history — same "archived, never erased"
   * convention as `ParentDoc.status`/`FeeStructureDoc.active`. Deactivating
   * a bus unpins every stop pointing at it (see transport/routes.ts). */
  active: boolean
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
}

export interface StopDoc extends Document {
  _id: string
  tenantId: string
  branchId: string
  name: string
  lat: number
  lng: number
  /** Hard-pins this stop to one bus — the solver never reassigns it. Null
   * means the solver picks the bus freely. Validated against a real,
   * active, same-branch `BusDoc` at write time (transport/routes.ts) —
   * unlike most cross-references in this codebase, a mismatch here would
   * silently cross a branch boundary and break a hard solver constraint,
   * not just look wrong on screen. */
  pinnedBusId: string | null
  /** A former stop kept for history. Deactivating one clears `stopId` back
   * to unassigned on every student who was pointed at it (transport/routes.ts)
   * — a stale reference here wouldn't just look wrong, it would silently
   * break that student's routing computation. */
  active: boolean
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
}

/**
 * One per branch (`${tenantId}:${branchId}`, same idiom as
 * `NotificationSettingsDoc`) — the depot location and the routing-rule
 * constants the client-side VRP solver needs (see timetable-ui's
 * `domain/fleet.ts` `FleetSettings` for the field-by-field rationale each of
 * these mirrors). A branch with no row yet behaves as if it had the
 * defaults in transport/settings.ts — same "effective settings" pattern as
 * `notifications/settings.ts`.
 */
export interface TransportSettingsDoc extends Document {
  _id: string
  tenantId: string
  branchId: string
  depotName: string
  depotLat: number
  depotLng: number
  /** Straight-line distance is multiplied by this to approximate road length. */
  roadFactor: number
  averageSpeedKph: number
  /** Minutes spent stationary at each stop. */
  dwellMinutes: number
  /** No child may ride longer than this, from their stop to the school. */
  maxRideMinutes: number
  /** Earliest a bus may leave the depot, "HH:MM:SS". */
  earliestDeparture: string
  /** First period start, from the timetable calendar. */
  bellTime: string
  /** Buses must be parked this many minutes before the bell. */
  arrivalBufferMinutes: number
  /** OSRM base url. Empty falls back to straight-line estimates. */
  osrmUrl: string
  /** A student's own pin further than this from their assigned stop is
   * flagged "needs review" and, if `doorToDoorEnabled`, routed to directly. */
  outlierThresholdMeters: number
  doorToDoorEnabled: boolean
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
  /** The recipient: a parent's id since SAMS 2.3 (an embedded guardian's
   * id on older jobs). The name is kept so the log doesn't change shape. */
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

  /** Scoped bulk delete — same forced tenant filter; for removing a record's
   * dependent rows together with it (e.g. a mistakenly created student). */
  deleteMany(filter: Filter<T>) {
    return this.col.deleteMany(this.scope(filter), { session: this.session })
  }
}

export interface TenantContext {
  datasets: TenantScope<DatasetDoc>
  datasetVersions: TenantScope<DatasetVersionDoc>
  auditLog: TenantScope<AuditLogDoc>
  lookups: TenantScope<LookupDoc>
  documents: TenantScope<DocumentDoc>
  applications: TenantScope<ApplicationDoc>
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
  parents: TenantScope<ParentDoc>
  parentStudentLinks: TenantScope<ParentStudentLinkDoc>
  feeStructures: TenantScope<FeeStructureDoc>
  invoices: TenantScope<InvoiceDoc>
  approvalRequests: TenantScope<ApprovalRequestDoc>
  payments: TenantScope<PaymentDoc>
  receipts: TenantScope<ReceiptDoc>
  financeCounters: TenantScope<FinanceCounterDoc>
  discountTypes: TenantScope<DiscountTypeDoc>
  scholarships: TenantScope<ScholarshipDoc>
  refunds: TenantScope<RefundDoc>
  vendors: TenantScope<VendorDoc>
  expenses: TenantScope<ExpenseDoc>
  employees: TenantScope<EmployeeDoc>
  contracts: TenantScope<ContractDoc>
  employmentEvents: TenantScope<EmploymentEventDoc>
  leaveTypes: TenantScope<LeaveTypeDoc>
  leaveRequests: TenantScope<LeaveRequestDoc>
  leaveAdjustments: TenantScope<LeaveAdjustmentDoc>
  staffAttendance: TenantScope<StaffAttendanceDoc>
  buses: TenantScope<BusDoc>
  stops: TenantScope<StopDoc>
  transportSettings: TenantScope<TransportSettingsDoc>
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
        lookups: new TenantScope(db.collection<LookupDoc>('lookups'), tenantId, session),
        documents: new TenantScope(db.collection<DocumentDoc>('documents'), tenantId, session),
        applications: new TenantScope(db.collection<ApplicationDoc>('applications'), tenantId, session),
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
        parents: new TenantScope(db.collection<ParentDoc>('parents'), tenantId, session),
        parentStudentLinks: new TenantScope(
          db.collection<ParentStudentLinkDoc>('parentStudentLinks'),
          tenantId,
          session,
        ),
        feeStructures: new TenantScope(
          db.collection<FeeStructureDoc>('feeStructures'),
          tenantId,
          session,
        ),
        invoices: new TenantScope(db.collection<InvoiceDoc>('invoices'), tenantId, session),
        approvalRequests: new TenantScope(
          db.collection<ApprovalRequestDoc>('approvalRequests'),
          tenantId,
          session,
        ),
        payments: new TenantScope(db.collection<PaymentDoc>('payments'), tenantId, session),
        receipts: new TenantScope(db.collection<ReceiptDoc>('receipts'), tenantId, session),
        financeCounters: new TenantScope(
          db.collection<FinanceCounterDoc>('financeCounters'),
          tenantId,
          session,
        ),
        discountTypes: new TenantScope(db.collection<DiscountTypeDoc>('discountTypes'), tenantId, session),
        scholarships: new TenantScope(db.collection<ScholarshipDoc>('scholarships'), tenantId, session),
        refunds: new TenantScope(db.collection<RefundDoc>('refunds'), tenantId, session),
        vendors: new TenantScope(db.collection<VendorDoc>('vendors'), tenantId, session),
        expenses: new TenantScope(db.collection<ExpenseDoc>('expenses'), tenantId, session),
        employees: new TenantScope(db.collection<EmployeeDoc>('employees'), tenantId, session),
        contracts: new TenantScope(db.collection<ContractDoc>('contracts'), tenantId, session),
        employmentEvents: new TenantScope(db.collection<EmploymentEventDoc>('employmentEvents'), tenantId, session),
        leaveTypes: new TenantScope(db.collection<LeaveTypeDoc>('leaveTypes'), tenantId, session),
        leaveRequests: new TenantScope(db.collection<LeaveRequestDoc>('leaveRequests'), tenantId, session),
        leaveAdjustments: new TenantScope(db.collection<LeaveAdjustmentDoc>('leaveAdjustments'), tenantId, session),
        staffAttendance: new TenantScope(db.collection<StaffAttendanceDoc>('staffAttendance'), tenantId, session),
        buses: new TenantScope(db.collection<BusDoc>('buses'), tenantId, session),
        stops: new TenantScope(db.collection<StopDoc>('stops'), tenantId, session),
        transportSettings: new TenantScope(
          db.collection<TransportSettingsDoc>('transportSettings'),
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
