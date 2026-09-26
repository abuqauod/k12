import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import { branchFilter, scoped, todayIso } from '../records.js'
import { addDays, contractStatus, coveringContract, EXPIRING_DAYS, fullName } from './common.js'

/**
 * SAMS 4.6: one HR summary for a branch (or every branch the caller may
 * see) and a date range:
 *  - headcount today by department, position, branch and gender;
 *  - hires and terminations in the range;
 *  - contracts ending within 60 days, and active staff with no contract
 *    covering today;
 *  - staff documents expired or expiring within 60 days;
 *  - leave days by type (approved requests starting in the range) and
 *    what waits for a decision;
 *  - attendance marks in the range, and who was absent most.
 */

const query = z
  .object({ branchId: z.string().optional(), from: z.string().date(), to: z.string().date() })
  .refine((q) => q.from <= q.to)

const countBy = <T>(rows: T[], key: (row: T) => string | null) => {
  const m = new Map<string, number>()
  for (const r of rows) {
    const k = key(r) ?? 'none'
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].map(([k, n]) => ({ key: k, count: n })).sort((a, b) => b.count - a.count)
}

export function registerHrReportRoutes(app: FastifyInstance): void {
  app.get('/hr/reports/summary', scoped('reports.hr'), async (request, reply) => {
    const parsed = query.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { from, to } = parsed.data
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const inBranch = branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}
    const today = todayIso()
    const soon = addDays(today, EXPIRING_DAYS)

    const d = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const employees = await ctx.employees.find({ ...inBranch }).toArray()
      const ids = employees.map((e) => e._id)
      const [contracts, events, docs, leave, pendingLeave, attendance] = await Promise.all([
        ctx.contracts.find({ employeeId: { $in: ids } }).toArray(),
        ctx.employmentEvents.find({ ...inBranch, date: { $gte: from, $lte: to }, type: { $in: ['hire', 'rehire', 'terminate'] } }).toArray(),
        ctx.documents
          .find({ ownerType: 'employee', ownerId: { $in: ids }, isCurrent: true, archivedAt: null, expiresAt: { $ne: null, $lte: soon } })
          .toArray(),
        ctx.leaveRequests.find({ ...inBranch, status: 'approved', startDate: { $gte: from, $lte: to } }).toArray(),
        ctx.leaveRequests.countDocuments({ ...inBranch, status: 'pending' }),
        ctx.staffAttendance.find({ ...inBranch, date: { $gte: from, $lte: to } }).toArray(),
      ])
      return { employees, contracts, events, docs, leave, pendingLeave, attendance }
    })

    const byId = new Map(d.employees.map((e) => [e._id, e]))
    const active = d.employees.filter((e) => e.status === 'active')
    const open = d.contracts.filter((c) => !c.closedReason)
    const expiring = open
      .filter((c) => c.endDate && c.endDate <= soon && byId.get(c.employeeId)?.status === 'active')
      .map((c) => ({
        employeeId: c.employeeId,
        name: fullName(byId.get(c.employeeId)!),
        contractId: c._id,
        typeCode: c.typeCode,
        endDate: c.endDate!,
        status: contractStatus(c, today),
      }))
      .sort((a, b) => a.endDate.localeCompare(b.endDate))
    const withoutContract = active
      .filter((e) => !coveringContract(d.contracts.filter((c) => c.employeeId === e._id && c.closedReason !== 'terminated'), today))
      .map((e) => ({ employeeId: e._id, name: fullName(e) }))

    const leaveByType = new Map<string, { days: number; requests: number }>()
    for (const r of d.leave) {
      const cur = leaveByType.get(r.typeCode) ?? { days: 0, requests: 0 }
      cur.days += r.days
      cur.requests++
      leaveByType.set(r.typeCode, cur)
    }
    const absences = new Map<string, number>()
    for (const a of d.attendance) if (a.status === 'absent') absences.set(a.employeeId, (absences.get(a.employeeId) ?? 0) + 1)

    return reply.send({
      from,
      to,
      asOf: today,
      headcount: {
        active: active.length,
        terminated: d.employees.length - active.length,
        byDepartment: countBy(active, (e) => e.departmentCode),
        byPosition: countBy(active, (e) => e.positionCode),
        byBranch: countBy(active, (e) => e.branchId),
        byGender: countBy(active, (e) => e.gender),
      },
      movement: {
        hires: d.events.filter((e) => e.type === 'hire' || e.type === 'rehire').length,
        terminations: d.events.filter((e) => e.type === 'terminate').length,
      },
      contracts: { expiring, withoutContract },
      documents: d.docs
        .map((doc) => ({
          documentId: doc._id,
          employeeId: doc.ownerId,
          name: byId.has(doc.ownerId) ? fullName(byId.get(doc.ownerId)!) : '',
          categoryCode: doc.categoryCode,
          fileName: doc.fileName,
          expiresAt: doc.expiresAt!,
          expired: doc.expiresAt! < today,
        }))
        .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
      leave: {
        pendingRequests: d.pendingLeave,
        byType: [...leaveByType.entries()].map(([typeCode, v]) => ({ typeCode, ...v })),
      },
      attendance: {
        byStatus: countBy(d.attendance, (a) => a.status),
        mostAbsent: [...absences.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([employeeId, days]) => ({ employeeId, name: byId.has(employeeId) ? fullName(byId.get(employeeId)!) : '', days })),
      },
    })
  })
}
