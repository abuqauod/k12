import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { EmployeeDoc, LeaveRequestDoc, LeaveTypeDoc, TenantContext } from '../db.js'
import { authenticate, callerBranchIds, callerCanUseBranch, callerHasPermission, requireActiveSubscription } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { registerApprovalType } from '../approvals/registry.js'
import { cancelPendingFor, insertRequest } from '../approvals/service.js'
import { isSessionDay } from '../calendar.js'
import { Abort, branchFilter, isFailure, scoped, sendFailure, transact } from '../records.js'
import { addDays, employeeAccess, employeeResponse, fullName } from './common.js'

/**
 * SAMS 4.4: leave. Leave types carry a yearly entitlement in working days
 * (null = not limited). A balance is worked out, never stored: entitlement
 * + adjustments − approved − pending, for one calendar year.
 *
 * A request counts working days on the employee's branch calendar (its
 * working week and holidays), stays inside one calendar year, may not
 * overlap another pending or approved request, and may not exceed the
 * balance. It is decided through the approval engine (`hr.leave`) by a
 * holder of `hr.leave.approve` — never the employee themselves.
 *
 * HR raises requests for anyone in their branches. A member whose login is
 * linked to an employee record raises their own (self-service).
 */

const DEFAULT_TYPES: Omit<LeaveTypeDoc, '_id' | 'tenantId' | 'createdAt' | 'updatedAt'>[] = [
  { code: 'annual', name: 'Annual leave', nameAr: 'إجازة سنوية', daysPerYear: 14, paid: true, active: true },
  { code: 'sick', name: 'Sick leave', nameAr: 'إجازة مرضية', daysPerYear: 14, paid: true, active: true },
  { code: 'emergency', name: 'Emergency leave', nameAr: 'إجازة طارئة', daysPerYear: 3, paid: true, active: true },
  { code: 'unpaid', name: 'Unpaid leave', nameAr: 'إجازة بدون راتب', daysPerYear: null, paid: false, active: true },
]

const date = z.string().date()
const typeBody = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  name: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().max(100).nullable().default(null),
  daysPerYear: z.number().min(0).max(366).nullable(),
  paid: z.boolean().default(true),
})
const typePatch = typeBody.omit({ code: true }).partial().extend({ active: z.boolean().optional() })

const requestBody = z.object({
  employeeId: z.string().min(1),
  typeCode: z.string().min(1).max(40),
  startDate: date,
  endDate: date,
  reason: z.string().trim().max(1000).nullable().default(null),
})

const listQuery = z.object({
  branchId: z.string().optional(),
  employeeId: z.string().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  from: date.optional(),
  to: date.optional(),
})

const adjustmentBody = z.object({
  typeCode: z.string().min(1).max(40),
  year: z.number().int().min(2000).max(2100),
  days: z.number().min(-366).max(366).refine((d) => d !== 0),
  reason: z.string().trim().min(3).max(500),
})

async function ensureLeaveTypes(ctx: TenantContext, tenantId: string): Promise<LeaveTypeDoc[]> {
  const existing = await ctx.leaveTypes.find({}).sort({ name: 1 }).toArray()
  if (existing.length > 0) return existing
  const now = new Date()
  for (const t of DEFAULT_TYPES) {
    await ctx.leaveTypes.findOneAndUpdate(
      { code: t.code },
      { $setOnInsert: { _id: randomUUID(), tenantId, ...t, createdAt: now, updatedAt: now } },
      { upsert: true },
    )
  }
  return ctx.leaveTypes.find({}).sort({ name: 1 }).toArray()
}

const typeResponse = (t: LeaveTypeDoc) => ({
  code: t.code,
  name: t.name,
  nameAr: t.nameAr,
  daysPerYear: t.daysPerYear,
  paid: t.paid,
  active: t.active,
})

export function leaveResponse(r: LeaveRequestDoc, employee?: EmployeeDoc) {
  return {
    id: r._id,
    employeeId: r.employeeId,
    employeeName: employee ? fullName(employee) : null,
    branchId: r.branchId,
    typeCode: r.typeCode,
    startDate: r.startDate,
    endDate: r.endDate,
    days: r.days,
    reason: r.reason,
    status: r.status,
    requestedBy: r.requestedBy,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }
}

/** Working days from `start` to `end` inclusive on a branch's calendar. */
export async function workingDays(ctx: TenantContext, tenantId: string, branchId: string, start: string, end: string): Promise<number> {
  const calendar = await ctx.schoolCalendars.findOne({ _id: `${tenantId}:${branchId}` })
  let n = 0
  for (let d = start; d <= end; d = addDays(d, 1)) if (isSessionDay(calendar, d)) n++
  return n
}

export interface Balance {
  typeCode: string
  name: string
  nameAr: string | null
  paid: boolean
  entitlement: number | null
  adjustments: number
  taken: number
  pending: number
  /** Null when the type is not limited. */
  available: number | null
}

/** Balances for one employee and calendar year, `except` left out of the
 * pending and taken counts (the request being re-checked). */
export async function balances(
  ctx: TenantContext,
  tenantId: string,
  employeeId: string,
  year: number,
  except?: string,
): Promise<Balance[]> {
  const [types, requests, adjustments] = await Promise.all([
    ensureLeaveTypes(ctx, tenantId),
    ctx.leaveRequests
      .find({ employeeId, status: { $in: ['pending', 'approved'] }, startDate: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } })
      .toArray(),
    ctx.leaveAdjustments.find({ employeeId, year }).toArray(),
  ])
  return types
    .filter((t) => t.active || requests.some((r) => r.typeCode === t.code))
    .map((t) => {
      const mine = requests.filter((r) => r.typeCode === t.code && r._id !== except)
      const taken = mine.filter((r) => r.status === 'approved').reduce((s, r) => s + r.days, 0)
      const pending = mine.filter((r) => r.status === 'pending').reduce((s, r) => s + r.days, 0)
      const adj = adjustments.filter((a) => a.typeCode === t.code).reduce((s, a) => s + a.days, 0)
      return {
        typeCode: t.code,
        name: t.name,
        nameAr: t.nameAr,
        paid: t.paid,
        entitlement: t.daysPerYear,
        adjustments: adj,
        taken,
        pending,
        available: t.daysPerYear === null ? null : t.daysPerYear + adj - taken - pending,
      }
    })
}

/** Everything a new or re-checked request must satisfy. Throws `Abort`. */
async function checkRequest(
  ctx: TenantContext,
  tenantId: string,
  r: { _id?: string; employeeId: string; typeCode: string; startDate: string; endDate: string },
): Promise<{ employee: EmployeeDoc; days: number }> {
  const employee = await ctx.employees.findOne({ _id: r.employeeId })
  if (!employee) throw new Abort('UNKNOWN_EMPLOYEE')
  if (employee.status !== 'active') throw new Abort('NOT_ACTIVE')
  if (r.endDate < r.startDate) throw new Abort('DATES_OUT_OF_ORDER')
  if (r.startDate.slice(0, 4) !== r.endDate.slice(0, 4)) throw new Abort('SPANS_YEARS')
  const type = (await ensureLeaveTypes(ctx, tenantId)).find((t) => t.code === r.typeCode)
  if (!type || !type.active) throw new Abort('INVALID_CODE')
  const days = await workingDays(ctx, tenantId, employee.branchId, r.startDate, r.endDate)
  if (days === 0) throw new Abort('NO_WORKING_DAYS')
  const clash = await ctx.leaveRequests.findOne({
    employeeId: r.employeeId,
    status: { $in: ['pending', 'approved'] },
    startDate: { $lte: r.endDate },
    endDate: { $gte: r.startDate },
    ...(r._id ? { _id: { $ne: r._id } } : {}),
  })
  if (clash) throw new Abort('OVERLAPS')
  const balance = (await balances(ctx, tenantId, r.employeeId, Number(r.startDate.slice(0, 4)), r._id)).find(
    (b) => b.typeCode === r.typeCode,
  )
  if (balance && balance.available !== null && days > balance.available) {
    throw new Abort('INSUFFICIENT_BALANCE', { available: balance.available, days })
  }
  return { employee, days }
}

registerApprovalType<Record<string, never>>({
  type: 'hr.leave',
  entity: 'leave',
  requestScope: 'hr.employee.update',
  decideScope: 'hr.leave.approve',
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async resolve(ctx, id) {
    const r = await ctx.leaveRequests.findOne({ _id: id })
    if (!r) return { ok: false, error: 'NOT_FOUND' }
    if (r.status !== 'pending') return { ok: false, error: 'NOT_PENDING' }
    const employee = await ctx.employees.findOne({ _id: r.employeeId })
    return {
      ok: true,
      branchId: r.branchId,
      dedupeKey: `leave:${id}`,
      summary: `${employee ? fullName(employee) : ''} · ${r.typeCode} · ${r.startDate} → ${r.endDate} · ${r.days}d`,
    }
  },
  async onApproved(ctx, request, actorId) {
    const r = await ctx.leaveRequests.findOne({ _id: request.entityId })
    if (!r || r.status !== 'pending') return { ok: false, error: 'NOT_PENDING' }
    try {
      const { employee } = await checkRequest(ctx, r.tenantId, r)
      // HR may raise a request for someone; that person still can't approve it.
      if (employee.userId === actorId) return { ok: false, error: 'SELF_DECISION' }
    } catch (error) {
      if (error instanceof Abort) return { ok: false, error: error.code }
      throw error
    }
    const now = new Date()
    await ctx.leaveRequests.findOneAndUpdate(
      { _id: r._id, status: 'pending' },
      { $set: { status: 'approved', decidedBy: actorId, decidedAt: now, updatedAt: now } },
    )
    await recordAudit(ctx.auditLog, {
      actorId,
      action: 'leave.approve',
      entity: 'leave',
      entityId: r._id,
      branchId: r.branchId,
      before: { status: 'pending' },
      after: { status: 'approved' },
    })
    return { ok: true }
  },
  async onClosed(ctx, request, outcome, actorId) {
    const now = new Date()
    await ctx.leaveRequests.findOneAndUpdate(
      { _id: request.entityId, status: 'pending' },
      { $set: { status: outcome, decidedBy: actorId, decidedAt: now, updatedAt: now } },
    )
  },
})

/** The employee record linked to the caller's login, if any. */
async function ownEmployee(request: FastifyRequest): Promise<EmployeeDoc | null> {
  return withTenant(request.auth!.tenantId!, (ctx) => ctx.employees.findOne({ userId: request.auth!.sub }))
}

export function registerLeaveRoutes(app: FastifyInstance): void {
  const signedIn = { preHandler: [authenticate, requireActiveSubscription] }

  // ------------------------------------------------------------ types

  // Readable by any member: self-service needs the names.
  app.get('/hr/leave-types', signedIn, async (request, reply) => {
    const tenantId = request.auth!.tenantId!
    const rows = await withTenant(tenantId, (ctx) => ensureLeaveTypes(ctx, tenantId))
    return reply.send({ leaveTypes: rows.map(typeResponse) })
  })

  app.post('/hr/leave-types', scoped('hr.employee.update'), async (request, reply) => {
    const parsed = typeBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const result = await transact(
      tenantId,
      async (ctx) => {
        await ensureLeaveTypes(ctx, tenantId)
        const now = new Date()
        const doc: LeaveTypeDoc = { _id: randomUUID(), tenantId, ...parsed.data, active: true, createdAt: now, updatedAt: now }
        await ctx.leaveTypes.insertOne(doc)
        await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'leaveType.create', entity: 'leaveType', entityId: doc._id, after: doc })
        return doc
      },
      'CODE_TAKEN',
    )
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(typeResponse(result))
  })

  app.patch('/hr/leave-types/:code', scoped('hr.employee.update'), async (request, reply) => {
    const { code } = request.params as { code: string }
    const parsed = typePatch.safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      const before = await ctx.leaveTypes.findOne({ code })
      if (!before) throw new Abort('NOT_FOUND')
      const after = await ctx.leaveTypes.findOneAndUpdate({ code }, { $set: { ...parsed.data, updatedAt: new Date() } }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'leaveType.update', entity: 'leaveType', entityId: before._id, before, after })
      return after!
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(typeResponse(result))
  })

  // --------------------------------------------------------- balances

  app.get('/hr/employees/:id/leave', scoped('hr.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const year = Number((request.query as { year?: string }).year ?? new Date().getUTCFullYear())
    if (!Number.isInteger(year)) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const tenantId = request.auth!.tenantId!
    const access = await employeeAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    return reply.send(await leaveOverview(tenantId, access.doc, year))
  })

  app.post('/hr/employees/:id/leave-adjustments', scoped('hr.employee.update'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = adjustmentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await employeeAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const result = await transact(tenantId, async (ctx) => {
      if (!(await ensureLeaveTypes(ctx, tenantId)).some((t) => t.code === parsed.data.typeCode)) throw new Abort('INVALID_CODE')
      const doc = {
        _id: randomUUID(),
        tenantId,
        employeeId: id,
        branchId: access.doc.branchId,
        ...parsed.data,
        createdAt: new Date(),
        createdBy: request.auth!.sub,
      }
      await ctx.leaveAdjustments.insertOne(doc)
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'leave.adjust', entity: 'employee', entityId: id, branchId: doc.branchId, after: doc })
      return doc
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send({ id: result._id })
  })

  // Self-service: the caller's own record, balances and requests.
  app.get('/hr/me', signedIn, async (request, reply) => {
    const me = await ownEmployee(request)
    if (!me) return reply.code(404).send({ error: 'NO_EMPLOYEE_RECORD' })
    const year = Number((request.query as { year?: string }).year ?? new Date().getUTCFullYear())
    return reply.send({ employee: employeeResponse(me), ...(await leaveOverview(request.auth!.tenantId!, me, year)) })
  })

  // --------------------------------------------------------- requests

  app.get('/hr/leave-requests', scoped('hr.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<LeaveRequestDoc> = {}
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    if (parsed.data.employeeId) filter.employeeId = parsed.data.employeeId
    if (parsed.data.status) filter.status = parsed.data.status
    if (parsed.data.from) filter.endDate = { $gte: parsed.data.from }
    if (parsed.data.to) filter.startDate = { $lte: parsed.data.to }
    const { rows, employees } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const rows = await ctx.leaveRequests.find(filter).sort({ startDate: -1 }).limit(1000).toArray()
      const employees = await ctx.employees.find({ _id: { $in: [...new Set(rows.map((r) => r.employeeId))] } }).toArray()
      return { rows, employees: new Map(employees.map((e) => [e._id, e])) }
    })
    return reply.send({ requests: rows.map((r) => leaveResponse(r, employees.get(r.employeeId))) })
  })

  app.post('/hr/leave-requests', signedIn, async (request, reply) => {
    const parsed = requestBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const target = await withTenant(tenantId, (ctx) => ctx.employees.findOne({ _id: parsed.data.employeeId }))
    if (!target) return reply.code(404).send({ error: 'UNKNOWN_EMPLOYEE' })
    // HR in the employee's branch, or the employee themselves.
    const self = target.userId === request.auth!.sub
    const hr = (await callerHasPermission(request, 'hr.employee.update')) && (await callerCanUseBranch(request, target.branchId))
    if (!self && !hr) return reply.code(403).send({ error: 'FORBIDDEN' })
    const actorId = request.auth!.sub
    const allowedBranchIds = self ? null : await callerBranchIds(request)
    const result = await transact(tenantId, async (ctx) => {
      const { employee, days } = await checkRequest(ctx, tenantId, parsed.data)
      const now = new Date()
      const doc: LeaveRequestDoc = {
        _id: randomUUID(),
        tenantId,
        employeeId: employee._id,
        branchId: employee.branchId,
        typeCode: parsed.data.typeCode,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        days,
        reason: parsed.data.reason,
        status: 'pending',
        requestedBy: actorId,
        decidedBy: null,
        decidedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      await ctx.leaveRequests.insertOne(doc)
      await recordAudit(ctx.auditLog, { actorId, action: 'leave.request', entity: 'leave', entityId: doc._id, branchId: doc.branchId, after: doc })
      const approval = await insertRequest(ctx, {
        type: 'hr.leave',
        entityId: doc._id,
        payload: {},
        comment: doc.reason,
        actorId,
        allowedBranchIds,
      })
      if (!approval.ok) throw new Abort(approval.error)
      return { doc, approvalId: approval.request._id }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send({ ...leaveResponse(result.doc, target), approvalId: result.approvalId })
  })

  // Pending: the requester, the employee or HR withdraws it. Approved and
  // not yet started: HR cancels it (the days go back to the balance).
  app.post('/hr/leave-requests/:id/cancel', signedIn, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const found = await withTenant(tenantId, async (ctx) => {
      const r = await ctx.leaveRequests.findOne({ _id: id })
      return r ? { r, employee: await ctx.employees.findOne({ _id: r.employeeId }) } : null
    })
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND' })
    const { r, employee } = found
    const hr = (await callerHasPermission(request, 'hr.employee.update')) && (await callerCanUseBranch(request, r.branchId))
    const own = r.requestedBy === request.auth!.sub || employee?.userId === request.auth!.sub
    if (!hr && !(own && r.status === 'pending')) return reply.code(403).send({ error: 'FORBIDDEN' })
    const actorId = request.auth!.sub
    const today = new Date().toISOString().slice(0, 10)
    const result = await transact(tenantId, async (ctx) => {
      const current = await ctx.leaveRequests.findOne({ _id: id })
      if (!current) throw new Abort('NOT_FOUND')
      if (current.status === 'approved' && current.startDate <= today) throw new Abort('ALREADY_STARTED')
      const after = await ctx.leaveRequests.findOneAndUpdate(
        { _id: id, status: { $in: ['pending', 'approved'] } },
        { $set: { status: 'cancelled', updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      if (!after) throw new Abort('NOT_CANCELLABLE')
      await cancelPendingFor(ctx, 'hr.leave', id, actorId, 'Withdrawn')
      await recordAudit(ctx.auditLog, {
        actorId,
        action: 'leave.cancel',
        entity: 'leave',
        entityId: id,
        branchId: after.branchId,
        before: { status: current.status },
        after: { status: 'cancelled' },
      })
      return after
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(leaveResponse(result, employee ?? undefined))
  })
}

async function leaveOverview(tenantId: string, employee: EmployeeDoc, year: number) {
  return withTenant(tenantId, async (ctx) => {
    const [bal, requests, adjustments] = await Promise.all([
      balances(ctx, tenantId, employee._id, year),
      ctx.leaveRequests.find({ employeeId: employee._id }).sort({ startDate: -1 }).limit(200).toArray(),
      ctx.leaveAdjustments.find({ employeeId: employee._id, year }).sort({ createdAt: -1 }).toArray(),
    ])
    return {
      year,
      balances: bal,
      requests: requests.map((r) => leaveResponse(r, employee)),
      adjustments: adjustments.map((a) => ({ id: a._id, typeCode: a.typeCode, days: a.days, reason: a.reason, createdAt: a.createdAt.toISOString() })),
    }
  })
}
