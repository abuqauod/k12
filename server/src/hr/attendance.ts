import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { StaffAttendanceStatus } from '../db.js'
import { callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { isSessionDay } from '../calendar.js'
import { Abort, isFailure, scoped, sendFailure, transact } from '../records.js'
import { employeeAccess, fullName } from './common.js'

/**
 * SAMS 4.5: staff attendance — one mark per employee per day. The daily
 * sheet lists everyone employed at the branch that day; approved leave
 * shows as `leave` until someone records otherwise.
 */

const STATUSES = ['present', 'absent', 'late', 'excused', 'leave'] as const
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable()
  .default(null)

const sheetQuery = z.object({ branchId: z.string().min(1), date: z.string().date() })
const saveBody = z.object({
  branchId: z.string().min(1),
  date: z.string().date(),
  records: z
    .array(
      z.object({
        employeeId: z.string().min(1),
        status: z.enum(STATUSES),
        checkIn: time,
        checkOut: time,
        note: z.string().trim().max(300).nullable().default(null),
      }),
    )
    .min(1)
    .max(1000),
})

export function registerStaffAttendanceRoutes(app: FastifyInstance): void {
  app.get('/hr/attendance', scoped('hr.read'), async (request, reply) => {
    const parsed = sheetQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { branchId, date } = parsed.data
    if (!(await callerCanUseBranch(request, branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const data = await withTenant(tenantId, async (ctx) => {
      const employees = await ctx.employees
        .find({
          branchId,
          hireDate: { $lte: date },
          $or: [{ status: 'active' }, { terminationDate: { $gte: date } }],
        })
        .sort({ familyName: 1, givenName: 1 })
        .toArray()
      const ids = employees.map((e) => e._id)
      const [records, leave, calendar] = await Promise.all([
        ctx.staffAttendance.find({ employeeId: { $in: ids }, date }).toArray(),
        ctx.leaveRequests.find({ employeeId: { $in: ids }, status: 'approved', startDate: { $lte: date }, endDate: { $gte: date } }).toArray(),
        ctx.schoolCalendars.findOne({ _id: `${tenantId}:${branchId}` }),
      ])
      return { employees, records, leave, sessionDay: isSessionDay(calendar, date) }
    })
    const byEmployee = new Map(data.records.map((r) => [r.employeeId, r]))
    const onLeave = new Map(data.leave.map((l) => [l.employeeId, l]))
    return reply.send({
      date,
      sessionDay: data.sessionDay,
      rows: data.employees.map((e) => {
        const rec = byEmployee.get(e._id)
        const leave = onLeave.get(e._id)
        return {
          employeeId: e._id,
          employeeNumber: e.employeeNumber,
          name: fullName(e),
          positionCode: e.positionCode,
          status: (rec?.status ?? (leave ? 'leave' : null)) as StaffAttendanceStatus | null,
          recorded: !!rec,
          leaveTypeCode: leave?.typeCode ?? null,
          checkIn: rec?.checkIn ?? null,
          checkOut: rec?.checkOut ?? null,
          note: rec?.note ?? null,
        }
      }),
    })
  })

  app.put('/hr/attendance', scoped('hr.attendance.write'), async (request, reply) => {
    const parsed = saveBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const { branchId, date, records } = parsed.data
    if (!(await callerCanUseBranch(request, branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const actorId = request.auth!.sub
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      const employees = await ctx.employees.find({ _id: { $in: records.map((r) => r.employeeId) } }).toArray()
      const inBranch = new Set(employees.filter((e) => e.branchId === branchId).map((e) => e._id))
      const counts: Record<string, number> = {}
      for (const r of records) {
        if (!inBranch.has(r.employeeId)) throw new Abort('NOT_IN_BRANCH', { employeeId: r.employeeId })
        await ctx.staffAttendance.findOneAndUpdate(
          { employeeId: r.employeeId, date },
          {
            $set: { branchId, status: r.status, checkIn: r.checkIn, checkOut: r.checkOut, note: r.note, recordedBy: actorId, updatedAt: new Date() },
            $setOnInsert: { _id: randomUUID(), tenantId: request.auth!.tenantId! },
          },
          { upsert: true },
        )
        counts[r.status] = (counts[r.status] ?? 0) + 1
      }
      await recordAudit(ctx.auditLog, {
        actorId,
        action: 'staffAttendance.record',
        entity: 'branch',
        entityId: branchId,
        branchId,
        meta: { date, ...counts },
      })
      return { saved: records.length }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(result)
  })

  app.get('/hr/employees/:id/attendance', scoped('hr.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ from: z.string().date(), to: z.string().date() }).safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const access = await employeeAccess(request, request.auth!.tenantId!, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.staffAttendance.find({ employeeId: id, date: { $gte: parsed.data.from, $lte: parsed.data.to } }).sort({ date: -1 }).toArray(),
    )
    const counts: Record<string, number> = {}
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
    return reply.send({
      counts,
      records: rows.map((r) => ({ date: r.date, status: r.status, checkIn: r.checkIn, checkOut: r.checkOut, note: r.note })),
    })
  })
}
