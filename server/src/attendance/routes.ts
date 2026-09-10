import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import { authenticate, requireActiveSubscription, requireRole } from '../auth/guard.js'

/**
 * Daily attendance — one record per student per day (`_id` =
 * `${tenantId}:${studentId}:${date}`), not per period. Most schools take a
 * single daily register; period-level attendance is a real future
 * extension, not something worth building before the daily case is proven.
 */

const markBody = z.object({
  date: z.string().date(),
  records: z
    .array(
      z.object({
        studentId: z.string().min(1),
        status: z.enum(['present', 'absent', 'late', 'excused']),
        note: z.string().max(500).nullable().default(null),
      }),
    )
    .min(1)
    .max(200),
})

export function registerAttendanceRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription] }
  const writeGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('scheduler')] }

  /**
   * The register for one class on one day — every student in the cohort,
   * paired with their record for that date if one exists yet (null if the
   * day hasn't been marked). Lets the UI render "not yet marked" instead of
   * silently omitting a student who has no attendance row yet.
   */
  app.get('/attendance', readGuard, async (request, reply) => {
    const query = z
      .object({ date: z.string().date(), studentGroup: z.string().min(1) })
      .safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { date, studentGroup } = query.data

    const tenantId = request.auth!.tenantId!
    const { roster, records } = await withTenant(tenantId, async (ctx) => {
      const roster = await ctx.students
        .find({ studentGroup, status: 'enrolled' })
        .sort({ familyName: 1, givenName: 1 })
        .toArray()
      const records = await ctx.attendance.find({ date }).toArray()
      return { roster, records }
    })

    const byStudent = new Map(records.map((r) => [r.studentId, r]))
    return reply.send({
      date,
      studentGroup,
      students: roster.map((s) => {
        const record = byStudent.get(s._id)
        return {
          studentId: s._id,
          givenName: s.givenName,
          familyName: s.familyName,
          status: record?.status ?? null,
          note: record?.note ?? null,
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
      records: records.map((r) => ({ date: r.date, status: r.status, note: r.note })),
    })
  })

  /** Bulk upsert — marking a whole class for a day is one atomic write. */
  app.put('/attendance', writeGuard, async (request, reply) => {
    const parsed = markBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const { date, records } = parsed.data

    const tenantId = request.auth!.tenantId!
    const markedBy = request.auth!.sub
    const markedAt = new Date()

    await withTenant(tenantId, async (ctx) => {
      for (const record of records) {
        const _id = `${tenantId}:${record.studentId}:${date}`
        await ctx.attendance.findOneAndUpdate(
          { _id },
          {
            $set: {
              studentId: record.studentId,
              date,
              status: record.status,
              note: record.note,
              markedBy,
              markedAt,
            },
          },
          { upsert: true },
        )
      }
    })

    return reply.send({ ok: true, count: records.length })
  })
}
