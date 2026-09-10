import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { AttendanceStatus } from '../db.js'
import { authenticate, requireActiveSubscription, requireRole } from '../auth/guard.js'
import { recordAudit } from '../audit.js'

/**
 * Daily attendance — one record per student per day (`_id` =
 * `${tenantId}:${studentId}:${date}`, plus a unique index so a duplicate is
 * a database error, not just a convention). "unmarked" is the absence of a
 * record, never a stored value.
 *
 * A change to an existing record (a correction) writes an
 * `attendanceCorrections` row with the before/after and an audit entry, and
 * stamps `updatedBy` / `updatedAt` — so "who changed this, from what, and
 * why" is answerable. Each record also snapshots the student's
 * branch / class / academic year / enrollment at mark time, so a later
 * transfer never rewrites the past.
 */

const STATUSES = ['present', 'absent', 'late', 'excused', 'early_departure'] as const

const markBody = z.object({
  date: z.string().date(),
  /** Attached to any corrections this call causes. */
  reason: z.string().max(500).nullable().default(null),
  records: z
    .array(
      z.object({
        studentId: z.string().min(1),
        status: z.enum(STATUSES),
        note: z.string().max(500).nullable().default(null),
      }),
    )
    .min(1)
    .max(200),
})

export function registerAttendanceRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription] }
  const writeGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('scheduler')] }

  /** The register for one class on one day — every enrolled student, each
   * paired with their record for that date (null if not yet marked). */
  app.get('/attendance', readGuard, async (request, reply) => {
    const query = z
      .object({ date: z.string().date(), classId: z.string().min(1) })
      .safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { date, classId } = query.data

    const tenantId = request.auth!.tenantId!
    const { klass, roster, records } = await withTenant(tenantId, async (ctx) => {
      const klass = await ctx.classes.findOne({ _id: classId })
      // The roster is students whose active enrollment is this class — the
      // `classId` cache on the student is exactly that, kept in step by the
      // enrollment service, so this stays a single indexed read.
      const roster = await ctx.students
        .find({ classId, status: 'enrolled' })
        .sort({ familyName: 1, givenName: 1 })
        .toArray()
      const records = await ctx.attendance.find({ classId, date }).toArray()
      return { klass, roster, records }
    })
    if (!klass) return reply.code(404).send({ error: 'UNKNOWN_CLASS' })

    const byStudent = new Map(records.map((r) => [r.studentId, r]))
    return reply.send({
      date,
      classId,
      branchId: klass.branchId,
      label: `${klass.gradeLevel} ${klass.name}`.trim(),
      students: roster.map((s) => {
        const record = byStudent.get(s._id)
        return {
          studentId: s._id,
          givenName: s.givenName,
          familyName: s.familyName,
          status: record?.status ?? null,
          note: record?.note ?? null,
          updatedAt: record?.updatedAt ? record.updatedAt.toISOString() : null,
        }
      }),
    })
  })

  /** One student's attendance over a range — defaults to the last 30 days. */
  app.get('/attendance/student/:studentId', readGuard, async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const query = z
      .object({ from: z.string().date().optional(), to: z.string().date().optional() })
      .safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: 'INVALID_QUERY' })

    const to = query.data.to ?? new Date().toISOString().slice(0, 10)
    const from =
      query.data.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

    const records = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.attendance
        .find({ studentId, date: { $gte: from, $lte: to } })
        .sort({ date: -1 })
        .toArray(),
    )
    return reply.send({
      studentId,
      records: records.map((r) => ({
        date: r.date,
        status: r.status,
        note: r.note,
        classId: r.classId,
        academicYearId: r.academicYearId,
      })),
    })
  })

  /** A student's correction trail. */
  app.get('/attendance/student/:studentId/corrections', readGuard, async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.attendanceCorrections.find({ studentId }).sort({ changedAt: -1 }).limit(200).toArray(),
    )
    return reply.send({
      corrections: rows.map((c) => ({
        id: c._id,
        date: c.date,
        from: c.from,
        to: c.to,
        reason: c.reason,
        changedBy: c.changedBy,
        changedAt: c.changedAt.toISOString(),
      })),
    })
  })

  /** Bulk upsert — one class for one day. New marks insert; changes to an
   * existing mark are recorded as corrections. */
  app.put('/attendance', writeGuard, async (request, reply) => {
    const parsed = markBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const { date, reason, records } = parsed.data

    const tenantId = request.auth!.tenantId!
    const actor = request.auth!.sub
    const now = new Date()

    const outcome = await withTenant(tenantId, async (ctx) => {
      const ids = records.map((r) => r.studentId)
      const students = await ctx.students.find({ _id: { $in: ids } }).toArray()
      const enrollments = await ctx.enrollments
        .find({ studentId: { $in: ids }, status: 'active' })
        .toArray()
      const enrollmentByStudent = new Map(enrollments.map((e) => [e.studentId, e]))

      let inserted = 0
      let corrected = 0
      let unchanged = 0
      for (const record of records) {
        const student = students.find((s) => s._id === record.studentId)
        if (!student) continue // not in this tenant
        const enrollment = enrollmentByStudent.get(record.studentId)
        const _id = `${tenantId}:${record.studentId}:${date}`
        const existing = await ctx.attendance.findOne({ _id })

        if (!existing) {
          await ctx.attendance.insertOne({
            _id,
            studentId: record.studentId,
            branchId: student.branchId,
            classId: student.classId,
            academicYearId: enrollment?.academicYearId ?? student.academicYearId,
            enrollmentId: enrollment?._id ?? '',
            date,
            status: record.status satisfies AttendanceStatus,
            note: record.note,
            markedBy: actor,
            markedAt: now,
            updatedBy: null,
            updatedAt: null,
          })
          inserted++
          continue
        }

        if (existing.status === record.status && (existing.note ?? null) === (record.note ?? null)) {
          unchanged++
          continue
        }

        await ctx.attendance.findOneAndUpdate(
          { _id },
          {
            $set: {
              status: record.status,
              note: record.note,
              updatedBy: actor,
              updatedAt: now,
            },
          },
        )
        await ctx.attendanceCorrections.insertOne({
          _id: randomUUID(),
          attendanceId: _id,
          studentId: record.studentId,
          branchId: existing.branchId,
          date,
          from: { status: existing.status, note: existing.note },
          to: { status: record.status, note: record.note },
          reason,
          changedBy: actor,
          changedAt: now,
        })
        await recordAudit(ctx.auditLog, {
          actorId: actor,
          action: 'attendance.correct',
          entity: 'attendance',
          entityId: _id,
          before: { status: existing.status, note: existing.note },
          after: { status: record.status, note: record.note },
          meta: { reason, date, studentId: record.studentId },
        })
        corrected++
      }
      return { inserted, corrected, unchanged }
    })

    return reply.send({ ok: true, ...outcome, count: outcome.inserted + outcome.corrected })
  })
}
