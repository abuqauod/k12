import { randomUUID } from 'node:crypto'
import type { EnrollmentDoc, EnrollmentStatus, TenantContext } from '../db.js'
import { recordAudit } from '../audit.js'

/**
 * Enrollment is the record of a student being in one class, in one branch,
 * for one academic year, over a date range — and the source of truth for
 * where a student is and where they have been. `student.branchId/classId/
 * academicYearId/studentGroup` are a cache of the *active* enrollment, kept
 * in step here on every write and never trusted from a request body.
 *
 * Every function takes a live `TenantContext` (a `withTenant` transaction)
 * plus the caller's `tenantId`, so a caller composes them with the write
 * that triggered the change and the whole thing commits together. That is
 * also why a transfer — close the old row, open the new one, update the
 * cache — cannot leave a student with zero or two active enrollments.
 */

const today = () => new Date().toISOString().slice(0, 10)

export async function activeEnrollment(
  ctx: TenantContext,
  studentId: string,
): Promise<EnrollmentDoc | null> {
  return ctx.enrollments.findOne({ studentId, status: 'active' })
}

export async function enrollmentHistory(
  ctx: TenantContext,
  studentId: string,
): Promise<EnrollmentDoc[]> {
  return ctx.enrollments.find({ studentId }).sort({ startDate: -1, createdAt: -1 }).toArray()
}

function classLabel(klass: { gradeLevel: string; name: string }): string {
  return `${klass.gradeLevel} ${klass.name}`.trim()
}

/**
 * Resolve the academic year a new enrollment in `classId` belongs to: the
 * class's own year if set, else the tenant's current year. Null means the
 * school has no academic year yet and must create one first.
 */
export async function resolveAcademicYearId(
  ctx: TenantContext,
  classAcademicYearId: string | null,
): Promise<string | null> {
  if (classAcademicYearId) return classAcademicYearId
  const current = await ctx.academicYears.findOne({ current: true })
  return current?._id ?? null
}

export type EnrollResult =
  | { ok: true; enrollment: EnrollmentDoc }
  | { ok: false; error: 'UNKNOWN_CLASS' | 'NO_ACADEMIC_YEAR' | 'ALREADY_ENROLLED' }

/** First enrollment for a student — used by student creation. */
export async function createInitialEnrollment(
  ctx: TenantContext,
  tenantId: string,
  params: { studentId: string; classId: string; startDate?: string; actorId: string | null },
): Promise<EnrollResult> {
  const klass = await ctx.classes.findOne({ _id: params.classId })
  if (!klass) return { ok: false, error: 'UNKNOWN_CLASS' }

  const existing = await activeEnrollment(ctx, params.studentId)
  if (existing) return { ok: false, error: 'ALREADY_ENROLLED' }

  const academicYearId = await resolveAcademicYearId(ctx, klass.academicYearId)
  if (!academicYearId) return { ok: false, error: 'NO_ACADEMIC_YEAR' }

  const now = new Date()
  const enrollment: EnrollmentDoc = {
    _id: randomUUID(),
    tenantId,
    studentId: params.studentId,
    branchId: klass.branchId,
    classId: klass._id,
    academicYearId,
    startDate: params.startDate ?? today(),
    endDate: null,
    status: 'active',
    supersededBy: null,
    reason: null,
    createdAt: now,
    createdBy: params.actorId,
    updatedAt: now,
  }
  await ctx.enrollments.insertOne(enrollment)

  await ctx.students.findOneAndUpdate(
    { _id: params.studentId },
    {
      $set: {
        branchId: klass.branchId,
        classId: klass._id,
        academicYearId,
        studentGroup: classLabel(klass),
        status: 'enrolled',
        updatedAt: now,
      },
    },
  )

  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'enrollment.create',
    entity: 'enrollment',
    entityId: enrollment._id,
    branchId: enrollment.branchId,
    before: null,
    after: enrollment,
  })
  return { ok: true, enrollment }
}

export type TransferResult =
  | { ok: true; from: EnrollmentDoc; to: EnrollmentDoc }
  | { ok: false; error: 'NOT_ENROLLED' | 'UNKNOWN_CLASS' | 'SAME_CLASS' | 'NO_ACADEMIC_YEAR' }

/** Move a student to another class (and, implicitly, its branch). Closes the
 * current active enrollment and opens a new one in one step. */
export async function transferStudent(
  ctx: TenantContext,
  tenantId: string,
  params: {
    studentId: string
    toClassId: string
    effectiveDate?: string
    reason?: string | null
    actorId: string | null
  },
): Promise<TransferResult> {
  const current = await activeEnrollment(ctx, params.studentId)
  if (!current) return { ok: false, error: 'NOT_ENROLLED' }
  if (current.classId === params.toClassId) return { ok: false, error: 'SAME_CLASS' }

  const klass = await ctx.classes.findOne({ _id: params.toClassId })
  if (!klass) return { ok: false, error: 'UNKNOWN_CLASS' }

  const academicYearId = await resolveAcademicYearId(ctx, klass.academicYearId)
  if (!academicYearId) return { ok: false, error: 'NO_ACADEMIC_YEAR' }

  const effectiveDate = params.effectiveDate ?? today()
  const now = new Date()
  const newId = randomUUID()

  const closed = await ctx.enrollments.findOneAndUpdate(
    { _id: current._id, status: 'active' },
    {
      $set: {
        status: 'transferred' satisfies EnrollmentStatus,
        endDate: effectiveDate,
        supersededBy: newId,
        reason: params.reason ?? null,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  )
  // Lost the race to another transfer that already closed this enrollment.
  if (!closed) return { ok: false, error: 'NOT_ENROLLED' }

  const created: EnrollmentDoc = {
    _id: newId,
    tenantId,
    studentId: params.studentId,
    branchId: klass.branchId,
    classId: klass._id,
    academicYearId,
    startDate: effectiveDate,
    endDate: null,
    status: 'active',
    supersededBy: null,
    reason: params.reason ?? null,
    createdAt: now,
    createdBy: params.actorId,
    updatedAt: now,
  }
  await ctx.enrollments.insertOne(created)

  await ctx.students.findOneAndUpdate(
    { _id: params.studentId },
    {
      $set: {
        branchId: klass.branchId,
        classId: klass._id,
        academicYearId,
        studentGroup: classLabel(klass),
        status: 'enrolled',
        updatedAt: now,
      },
    },
  )

  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'enrollment.transfer',
    entity: 'student',
    entityId: params.studentId,
    // The destination branch — where the student (and this audit row's
    // entity) now lives. A single branchId can't represent "moved from A
    // to B" for filtering purposes; the full before/after below still
    // records both branches for anyone who can see this row at all.
    branchId: klass.branchId,
    before: { classId: current.classId, branchId: current.branchId, enrollmentId: current._id },
    after: { classId: klass._id, branchId: klass.branchId, enrollmentId: newId, effectiveDate },
    meta: { reason: params.reason ?? null },
  })

  return { ok: true, from: closed, to: created }
}

export type WithdrawResult =
  | { ok: true; enrollment: EnrollmentDoc }
  | { ok: false; error: 'NOT_ENROLLED' }

export async function withdrawStudent(
  ctx: TenantContext,
  params: {
    studentId: string
    status: 'withdrawn' | 'graduated'
    effectiveDate?: string
    reason?: string | null
    /** `withdrawalReason` code; withdrawals only. */
    reasonCode?: string | null
    actorId: string | null
  },
): Promise<WithdrawResult> {
  const current = await activeEnrollment(ctx, params.studentId)
  if (!current) return { ok: false, error: 'NOT_ENROLLED' }

  const effectiveDate = params.effectiveDate ?? today()
  const now = new Date()
  const closed = await ctx.enrollments.findOneAndUpdate(
    { _id: current._id, status: 'active' },
    {
      $set: {
        status: params.status,
        endDate: effectiveDate,
        reason: params.reason ?? null,
        reasonCode: params.reasonCode ?? null,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  )
  if (!closed) return { ok: false, error: 'NOT_ENROLLED' }

  await ctx.students.findOneAndUpdate(
    { _id: params.studentId },
    { $set: { status: params.status, updatedAt: now } },
  )

  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: `enrollment.${params.status}`,
    entity: 'student',
    entityId: params.studentId,
    branchId: current.branchId,
    before: { status: 'active', enrollmentId: current._id },
    after: { status: params.status, effectiveDate, reasonCode: params.reasonCode ?? null },
    meta: { reason: params.reason ?? null },
  })
  return { ok: true, enrollment: closed }
}

/** Points the student's cached class/branch/year at an enrollment that has
 * just become active. */
async function cacheActive(ctx: TenantContext, e: EnrollmentDoc, klass: { gradeLevel: string; name: string }) {
  await ctx.students.findOneAndUpdate(
    { _id: e.studentId },
    {
      $set: {
        branchId: e.branchId,
        classId: e.classId,
        academicYearId: e.academicYearId,
        studentGroup: classLabel(klass),
        status: 'enrolled',
        updatedAt: new Date(),
      },
    },
  )
}

export type OpenResult =
  | { ok: true; enrollment: EnrollmentDoc }
  | { ok: false; error: 'UNKNOWN_STUDENT' | 'UNKNOWN_CLASS' | 'NO_ACADEMIC_YEAR' | 'ALREADY_ENROLLED' | 'YEAR_TAKEN' }

/**
 * SAMS 2.4: a new enrollment row for an existing student — never an edit
 * of an old one, so history is kept.
 *  - active: a re-enrollment after a withdrawal or graduation. Refused
 *    while the student has an active enrollment (that is a transfer).
 *  - pending: a planned place, e.g. next year's class. Leaves the student's
 *    current class alone until it is activated.
 * Either way, at most one open (active or pending) row per academic year —
 * also enforced by a partial unique index (schema.ts).
 */
export async function openEnrollment(
  ctx: TenantContext,
  tenantId: string,
  params: { studentId: string; classId: string; startDate?: string; pending: boolean; actorId: string | null },
): Promise<OpenResult> {
  const student = await ctx.students.findOne({ _id: params.studentId })
  if (!student) return { ok: false, error: 'UNKNOWN_STUDENT' }
  const klass = await ctx.classes.findOne({ _id: params.classId })
  if (!klass) return { ok: false, error: 'UNKNOWN_CLASS' }
  const academicYearId = await resolveAcademicYearId(ctx, klass.academicYearId)
  if (!academicYearId) return { ok: false, error: 'NO_ACADEMIC_YEAR' }
  if (!params.pending && (await activeEnrollment(ctx, params.studentId))) {
    return { ok: false, error: 'ALREADY_ENROLLED' }
  }
  const sameYear = await ctx.enrollments.findOne({
    studentId: params.studentId,
    academicYearId,
    status: { $in: ['active', 'pending'] },
  })
  if (sameYear) return { ok: false, error: 'YEAR_TAKEN' }

  const now = new Date()
  const enrollment: EnrollmentDoc = {
    _id: randomUUID(),
    tenantId,
    studentId: params.studentId,
    branchId: klass.branchId,
    classId: klass._id,
    academicYearId,
    startDate: params.startDate ?? today(),
    endDate: null,
    status: params.pending ? 'pending' : 'active',
    supersededBy: null,
    reason: null,
    createdAt: now,
    createdBy: params.actorId,
    updatedAt: now,
  }
  await ctx.enrollments.insertOne(enrollment)
  if (!params.pending) await cacheActive(ctx, enrollment, klass)

  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: params.pending ? 'enrollment.plan' : 'enrollment.reenroll',
    entity: 'student',
    entityId: params.studentId,
    branchId: klass.branchId,
    before: params.pending ? null : { status: student.status },
    after: { enrollmentId: enrollment._id, classId: klass._id, academicYearId, status: enrollment.status },
  })
  return { ok: true, enrollment }
}

export type PendingResult =
  | { ok: true; enrollment: EnrollmentDoc }
  | { ok: false; error: 'NOT_FOUND' | 'NOT_PENDING' | 'ALREADY_ENROLLED' | 'UNKNOWN_CLASS' }

/** A pending enrollment starts: it becomes the student's active one. The
 * student must have no active enrollment — close this year's first
 * (withdraw, graduate); rolling a whole school forward is SAMS 2.6. */
export async function activatePending(
  ctx: TenantContext,
  params: { enrollmentId: string; startDate?: string; actorId: string | null },
): Promise<PendingResult> {
  const row = await ctx.enrollments.findOne({ _id: params.enrollmentId })
  if (!row) return { ok: false, error: 'NOT_FOUND' }
  if (row.status !== 'pending') return { ok: false, error: 'NOT_PENDING' }
  if (await activeEnrollment(ctx, row.studentId)) return { ok: false, error: 'ALREADY_ENROLLED' }
  const klass = await ctx.classes.findOne({ _id: row.classId })
  if (!klass) return { ok: false, error: 'UNKNOWN_CLASS' }

  const startDate = params.startDate ?? row.startDate
  const activated = await ctx.enrollments.findOneAndUpdate(
    { _id: row._id, status: 'pending' },
    { $set: { status: 'active', startDate, updatedAt: new Date() } },
    { returnDocument: 'after' },
  )
  if (!activated) return { ok: false, error: 'NOT_PENDING' }
  await cacheActive(ctx, activated, klass)
  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'enrollment.activate',
    entity: 'student',
    entityId: row.studentId,
    branchId: row.branchId,
    before: { enrollmentId: row._id, status: 'pending' },
    after: { enrollmentId: row._id, status: 'active', startDate },
  })
  return { ok: true, enrollment: activated }
}

/** A pending enrollment that won't happen. Kept as `cancelled`. */
export async function cancelPending(
  ctx: TenantContext,
  params: { enrollmentId: string; reason: string; actorId: string | null },
): Promise<PendingResult> {
  const now = new Date()
  const cancelled = await ctx.enrollments.findOneAndUpdate(
    { _id: params.enrollmentId, status: 'pending' },
    { $set: { status: 'cancelled', endDate: today(), reason: params.reason, updatedAt: now } },
    { returnDocument: 'after' },
  )
  if (!cancelled) {
    const exists = await ctx.enrollments.findOne({ _id: params.enrollmentId })
    return { ok: false, error: exists ? 'NOT_PENDING' : 'NOT_FOUND' }
  }
  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'enrollment.cancel',
    entity: 'student',
    entityId: cancelled.studentId,
    branchId: cancelled.branchId,
    before: { enrollmentId: cancelled._id, status: 'pending' },
    after: { enrollmentId: cancelled._id, status: 'cancelled' },
  })
  return { ok: true, enrollment: cancelled }
}

export interface BulkAssignRow {
  studentId: string
  outcome: 'transferred' | 'enrolled' | 'unchanged' | 'error'
  error?: string
}

/** Put a list of students into one class — transferring those already
 * enrolled elsewhere, enrolling those not yet enrolled, skipping those
 * already there. Synchronous and capped; a truly large import is a
 * background job (see the limitations note in the PR). */
export async function bulkAssignToClass(
  ctx: TenantContext,
  tenantId: string,
  params: {
    studentIds: string[]
    toClassId: string
    effectiveDate?: string
    reason?: string | null
    actorId: string | null
  },
): Promise<BulkAssignRow[]> {
  const rows: BulkAssignRow[] = []
  for (const studentId of params.studentIds) {
    const current = await activeEnrollment(ctx, studentId)
    if (current?.classId === params.toClassId) {
      rows.push({ studentId, outcome: 'unchanged' })
      continue
    }
    if (current) {
      const res = await transferStudent(ctx, tenantId, {
        studentId,
        toClassId: params.toClassId,
        effectiveDate: params.effectiveDate,
        reason: params.reason,
        actorId: params.actorId,
      })
      rows.push(
        res.ok
          ? { studentId, outcome: 'transferred' }
          : { studentId, outcome: 'error', error: res.error },
      )
    } else {
      const res = await createInitialEnrollment(ctx, tenantId, {
        studentId,
        classId: params.toClassId,
        startDate: params.effectiveDate,
        actorId: params.actorId,
      })
      rows.push(
        res.ok
          ? { studentId, outcome: 'enrolled' }
          : { studentId, outcome: 'error', error: res.error },
      )
    }
  }
  return rows
}
