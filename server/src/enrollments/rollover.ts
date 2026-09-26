import type { EnrollmentDoc, SchoolClassDoc, TenantContext } from '../db.js'
import { recordAudit } from '../audit.js'
import { activeEnrollment, activatePending, openEnrollment, withdrawStudent } from './service.js'

/**
 * Year-end re-enrollment (SAMS 2.6), in two steps so a school can plan in
 * June and switch over in August:
 *  1. plan — for every student active in the year being closed, one of
 *     promote / hold back (a planned place in a next-year class),
 *     graduate or withdraw (closes this year now). Previewed first; the
 *     commit re-checks every row and applies all of them or none.
 *  2. start — every planned place in the new year for the branch becomes
 *     active; the student's old enrollment is closed as `completed`.
 * Only new rows are written; an existing enrollment is closed, never edited
 * away.
 */

export type RolloverAction = 'promote' | 'hold' | 'graduate' | 'withdraw'

export interface RolloverRow {
  studentId: string
  action: RolloverAction
  /** Next year's class, for promote / hold. */
  toClassId?: string | null
  /** A withdrawalReason code, for withdraw. */
  reasonCode?: string | null
}

export interface ProposalRow {
  studentId: string
  studentNumber: string
  name: string
  fromClassId: string
  fromGradeLevel: string
  /** Already has a place (planned or active) in the new year: skipped. */
  existing: { enrollmentId: string; status: EnrollmentDoc['status']; classId: string } | null
  suggested: { action: RolloverAction; toClassId: string | null }
}

/** "Grade 3" → "Grade 4", "KG1" → "KG2"; null when there is no number. */
export function nextGrade(grade: string): string | null {
  const m = grade.match(/^(.*?)(\d+)(\D*)$/)
  return m ? `${m[1]}${Number(m[2]) + 1}${m[3]}` : null
}

async function yearClasses(ctx: TenantContext, branchId: string, academicYearId: string) {
  return ctx.classes.find({ branchId, academicYearId, active: true }).toArray()
}

/** Every student active in the old year and branch, with a suggestion:
 * the next grade's class with the same section name, else the next grade's
 * only class; with no next-grade class the row still needs a choice. */
export async function proposal(
  ctx: TenantContext,
  params: { branchId: string; fromYearId: string; toYearId: string },
): Promise<{ rows: ProposalRow[]; toClasses: SchoolClassDoc[] }> {
  const active = await ctx.enrollments
    .find({ branchId: params.branchId, academicYearId: params.fromYearId, status: 'active' })
    .toArray()
  const studentIds = active.map((e) => e.studentId)
  const [students, fromClasses, toClasses, existing] = await Promise.all([
    ctx.students.find({ _id: { $in: studentIds } }).toArray(),
    ctx.classes.find({ _id: { $in: [...new Set(active.map((e) => e.classId))] } }).toArray(),
    yearClasses(ctx, params.branchId, params.toYearId),
    ctx.enrollments
      .find({ studentId: { $in: studentIds }, academicYearId: params.toYearId, status: { $in: ['active', 'pending'] } })
      .toArray(),
  ])
  const studentById = new Map(students.map((s) => [s._id, s]))
  const classById = new Map(fromClasses.map((c) => [c._id, c]))
  const existingByStudent = new Map(existing.map((e) => [e.studentId, e]))

  const rows = active.flatMap((e): ProposalRow[] => {
    const student = studentById.get(e.studentId)
    const from = classById.get(e.classId)
    if (!student) return []
    const grade = from?.gradeLevel ?? ''
    const next = nextGrade(grade)
    const inNext = next ? toClasses.filter((c) => c.gradeLevel === next) : []
    const target = inNext.find((c) => c.name === from?.name) ?? (inNext.length === 1 ? inNext[0] : undefined)
    const ex = existingByStudent.get(e.studentId)
    return [
      {
        studentId: student._id,
        studentNumber: student.studentNumber,
        name: `${student.givenName} ${student.familyName}`.trim(),
        fromClassId: e.classId,
        fromGradeLevel: grade,
        existing: ex ? { enrollmentId: ex._id, status: ex.status, classId: ex.classId } : null,
        suggested: { action: 'promote', toClassId: target?._id ?? null },
      },
    ]
  })
  rows.sort((a, b) => a.fromGradeLevel.localeCompare(b.fromGradeLevel) || a.name.localeCompare(b.name))
  return { rows, toClasses }
}

export interface RowCheck {
  studentId: string
  ok: boolean
  error?: string
}

/** Checks every row against current data without writing. */
export async function checkRows(
  ctx: TenantContext,
  params: { branchId: string; fromYearId: string; toYearId: string; rows: RolloverRow[]; reasonCodes: Set<string> },
): Promise<RowCheck[]> {
  const toClasses = new Map((await yearClasses(ctx, params.branchId, params.toYearId)).map((c) => [c._id, c]))
  const seen = new Set<string>()
  const results: RowCheck[] = []
  for (const row of params.rows) {
    const fail = (error: string) => results.push({ studentId: row.studentId, ok: false, error })
    if (seen.has(row.studentId)) {
      fail('DUPLICATE_ROW')
      continue
    }
    seen.add(row.studentId)
    const current = await activeEnrollment(ctx, row.studentId)
    if (!current || current.academicYearId !== params.fromYearId || current.branchId !== params.branchId) {
      fail('NOT_IN_YEAR')
      continue
    }
    if (row.action === 'promote' || row.action === 'hold') {
      const target = row.toClassId ? toClasses.get(row.toClassId) : undefined
      if (!target) {
        fail('CLASS_REQUIRED')
        continue
      }
      const from = await ctx.classes.findOne({ _id: current.classId })
      if (row.action === 'hold' && from && target.gradeLevel !== from.gradeLevel) {
        fail('HOLD_SAME_GRADE')
        continue
      }
      const taken = await ctx.enrollments.findOne({
        studentId: row.studentId,
        academicYearId: params.toYearId,
        status: { $in: ['active', 'pending'] },
      })
      if (taken) {
        fail('YEAR_TAKEN')
        continue
      }
    }
    if (row.action === 'withdraw' && (!row.reasonCode || !params.reasonCodes.has(row.reasonCode))) {
      fail('REASON_REQUIRED')
      continue
    }
    results.push({ studentId: row.studentId, ok: true })
  }
  return results
}

/** Thrown to roll a commit back. */
export class RolloverAbort extends Error {
  constructor(readonly code: string, readonly studentId: string) {
    super(code)
  }
}

/** Applies checked rows. Run inside one transaction: all or nothing. */
export async function commitRows(
  ctx: TenantContext,
  tenantId: string,
  params: {
    branchId: string
    fromYearId: string
    toYearId: string
    rows: RolloverRow[]
    startDate: string
    /** When graduations / withdrawals take effect: the old year's end. */
    closeDate: string
    actorId: string
  },
): Promise<Record<RolloverAction, number>> {
  const counts: Record<RolloverAction, number> = { promote: 0, hold: 0, graduate: 0, withdraw: 0 }
  for (const row of params.rows) {
    if (row.action === 'promote' || row.action === 'hold') {
      const res = await openEnrollment(ctx, tenantId, {
        studentId: row.studentId,
        classId: row.toClassId!,
        startDate: params.startDate,
        pending: true,
        actorId: params.actorId,
      })
      if (!res.ok) throw new RolloverAbort(res.error, row.studentId)
    } else {
      const res = await withdrawStudent(ctx, {
        studentId: row.studentId,
        status: row.action === 'graduate' ? 'graduated' : 'withdrawn',
        effectiveDate: params.closeDate,
        reason: row.action === 'withdraw' ? 'Year-end re-enrollment' : null,
        reasonCode: row.action === 'withdraw' ? row.reasonCode : null,
        actorId: params.actorId,
      })
      if (!res.ok) throw new RolloverAbort(res.error, row.studentId)
    }
    counts[row.action]++
  }
  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'enrollment.rollover',
    entity: 'branch',
    entityId: params.branchId,
    branchId: params.branchId,
    meta: { fromYearId: params.fromYearId, toYearId: params.toYearId, ...counts },
  })
  return counts
}

/** Step 2: every planned place in the new year for the branch starts. The
 * old enrollment is closed as `completed` the day before. Run in one
 * transaction: a place that can't start rolls the whole switch back, so
 * no student is left with last year closed and nothing open. */
export async function startYear(
  ctx: TenantContext,
  params: { branchId: string; toYearId: string; startDate?: string; actorId: string },
): Promise<{ started: number }> {
  const pending = await ctx.enrollments
    .find({ branchId: params.branchId, academicYearId: params.toYearId, status: 'pending' })
    .toArray()
  let started = 0
  for (const row of pending) {
    const startDate = params.startDate ?? row.startDate
    const current = await activeEnrollment(ctx, row.studentId)
    if (current) {
      await ctx.enrollments.findOneAndUpdate(
        { _id: current._id, status: 'active' },
        { $set: { status: 'completed', endDate: dayBefore(startDate), updatedAt: new Date() } },
      )
      await recordAudit(ctx.auditLog, {
        actorId: params.actorId,
        action: 'enrollment.complete',
        entity: 'student',
        entityId: row.studentId,
        branchId: current.branchId,
        before: { enrollmentId: current._id, status: 'active' },
        after: { enrollmentId: current._id, status: 'completed', endDate: dayBefore(startDate) },
      })
    }
    const res = await activatePending(ctx, { enrollmentId: row._id, startDate, actorId: params.actorId })
    if (!res.ok) throw new RolloverAbort(res.error, row.studentId)
    started++
  }
  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'enrollment.startYear',
    entity: 'branch',
    entityId: params.branchId,
    branchId: params.branchId,
    meta: { toYearId: params.toYearId, started },
  })
  return { started }
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

