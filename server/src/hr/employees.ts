import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant, withoutTenant } from '../db.js'
import type { ContractDoc, EmployeeDoc, TenantContext } from '../db.js'
import { callerCanUseBranch, callerHasPermission } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { readReason, setAuditReason } from '../requestContext.js'
import { Abort, branchFilter, isFailure, scoped, sendFailure, todayIso, transact } from '../records.js'
import {
  addDays,
  checkCode,
  contractResponse,
  EXPIRING_DAYS,
  employeeAccess,
  employeeResponse,
  fullName,
  recordEvent,
} from './common.js'
import { nextNumber } from '../numbering.js'

/**
 * SAMS 4.1–4.2: employee records, contracts and employment history.
 *
 * An employee is not a login. `userId` optionally links one (for
 * self-service leave); a login is linked to at most one employee. Every
 * change of branch, department, position, contract or employment status is
 * kept as an employment event, so history is never overwritten.
 *
 * Contracts never overlap for one employee. A renewal is a new contract
 * starting the day after the old one ends; the old one is closed as
 * `renewed`. Salaries are shown and set only with `hr.salary.read`.
 */

const date = z.string().date()
const text = (max: number) => z.string().trim().max(max).nullable().optional()

const employeeFields = {
  givenName: z.string().trim().min(1).max(100),
  familyName: z.string().trim().min(1).max(100),
  fullNameAr: text(200),
  gender: z.enum(['male', 'female']).nullable().optional(),
  dob: date.nullable().optional(),
  nationality: text(80),
  nationalId: text(40),
  phone: text(40),
  email: z.string().trim().email().max(200).nullable().optional(),
  address: text(300),
  departmentCode: z.string().max(64).nullable().optional(),
  positionCode: z.string().max(64).nullable().optional(),
  emergencyContactName: text(200),
  emergencyContactPhone: text(40),
  notes: text(2000),
}

const contractBody = z.object({
  typeCode: z.string().min(1).max(64),
  startDate: date,
  endDate: date.nullable().default(null),
  salary: z.number().int().min(0).nullable().default(null),
  hoursPerWeek: z.number().min(1).max(80).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
})

const createBody = z.object({
  ...employeeFields,
  branchId: z.string().min(1),
  hireDate: date,
  contract: contractBody.optional(),
})

const updateBody = z
  .object({
    ...Object.fromEntries(Object.entries(employeeFields).map(([k, v]) => [k, v.optional()])),
    branchId: z.string().min(1).optional(),
    /** When a branch/department/position change takes effect (default today). */
    effectiveDate: date.optional(),
  })
  .strict()

const listQuery = z.object({
  branchId: z.string().optional(),
  status: z.enum(['active', 'terminated']).optional(),
  departmentCode: z.string().optional(),
  q: z.string().trim().max(100).optional(),
})

const renewBody = z.object({
  endDate: date.nullable().default(null),
  typeCode: z.string().min(1).max(64).optional(),
  salary: z.number().int().min(0).nullable().optional(),
  hoursPerWeek: z.number().min(1).max(80).nullable().optional(),
})

const overlaps = (a: { startDate: string; endDate: string | null }, b: { startDate: string; endDate: string | null }) =>
  a.startDate <= (b.endDate ?? '9999-12-31') && b.startDate <= (a.endDate ?? '9999-12-31')

export function registerEmployeeRoutes(app: FastifyInstance): void {
  // ----------------------------------------------------------- employees

  app.get('/hr/employees', scoped('hr.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<EmployeeDoc> = {}
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    if (parsed.data.status) filter.status = parsed.data.status
    if (parsed.data.departmentCode) filter.departmentCode = parsed.data.departmentCode
    if (parsed.data.q) {
      const re = new RegExp(parsed.data.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ givenName: re }, { familyName: re }, { employeeNumber: re }, { fullNameAr: re }, { phone: re }]
    }
    const today = todayIso()
    const { rows, contracts } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const rows = await ctx.employees.find(filter).sort({ familyName: 1, givenName: 1 }).limit(2000).toArray()
      const contracts = await ctx.contracts
        .find({ employeeId: { $in: rows.map((r) => r._id) }, closedReason: null })
        .toArray()
      return { rows, contracts }
    })
    const salary = await callerHasPermission(request, 'hr.salary.read')
    return reply.send({
      employees: rows.map((e) => {
        const current = contracts
          .filter((c) => c.employeeId === e._id && c.startDate <= today)
          .sort((a, b) => b.startDate.localeCompare(a.startDate))[0]
        return { ...employeeResponse(e), contract: current ? contractResponse(current, today, salary) : null }
      }),
    })
  })

  app.get('/hr/employees/:id', scoped('hr.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const access = await employeeAccess(request, request.auth!.tenantId!, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const linked = access.doc.userId
      ? await withoutTenant((db) => db.users.findOne({ _id: access.doc.userId! }, { projection: { email: 1, displayName: 1 } }))
      : null
    return reply.send({
      ...employeeResponse(access.doc),
      linkedUser: linked ? { id: linked._id, email: linked.email, displayName: linked.displayName } : null,
    })
  })

  app.post('/hr/employees', scoped('hr.employee.update'), async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const body = parsed.data
    if (!(await callerCanUseBranch(request, body.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    if (!(await checkCode(tenantId, 'department', body.departmentCode))) return reply.code(400).send({ error: 'INVALID_CODE', field: 'departmentCode' })
    if (!(await checkCode(tenantId, 'position', body.positionCode))) return reply.code(400).send({ error: 'INVALID_CODE', field: 'positionCode' })
    if (body.contract) {
      if (!(await checkCode(tenantId, 'contractType', body.contract.typeCode))) return reply.code(400).send({ error: 'INVALID_CODE', field: 'typeCode' })
      if (body.contract.endDate && body.contract.endDate < body.contract.startDate) return reply.code(400).send({ error: 'DATES_OUT_OF_ORDER' })
      if (body.contract.salary !== null && !(await callerHasPermission(request, 'hr.salary.read'))) {
        return reply.code(403).send({ error: 'SALARY_REQUIRES_SCOPE' })
      }
    }
    const actorId = request.auth!.sub
    const result = await transact(tenantId, async (ctx) => {
      if (!(await ctx.branches.findOne({ _id: body.branchId }))) throw new Abort('NOT_FOUND')
      const now = new Date()
      const doc: EmployeeDoc = {
        _id: randomUUID(),
        tenantId,
        employeeNumber: await nextNumber(ctx, tenantId, 'employeeNumber'),
        branchId: body.branchId,
        givenName: body.givenName,
        familyName: body.familyName,
        fullNameAr: body.fullNameAr ?? null,
        gender: body.gender ?? null,
        dob: body.dob ?? null,
        nationality: body.nationality ?? null,
        nationalId: body.nationalId ?? null,
        phone: body.phone ?? null,
        email: body.email ?? null,
        address: body.address ?? null,
        departmentCode: body.departmentCode ?? null,
        positionCode: body.positionCode ?? null,
        hireDate: body.hireDate,
        status: 'active',
        terminationDate: null,
        terminationReason: null,
        userId: null,
        emergencyContactName: body.emergencyContactName ?? null,
        emergencyContactPhone: body.emergencyContactPhone ?? null,
        notes: body.notes ?? null,
        createdAt: now,
        updatedAt: now,
        createdBy: actorId,
      }
      await ctx.employees.insertOne(doc)
      await recordEvent(ctx, tenantId, { employeeId: doc._id, branchId: doc.branchId, type: 'hire', date: doc.hireDate, to: doc.positionCode, actorId })
      await recordAudit(ctx.auditLog, { actorId, action: 'employee.create', entity: 'employee', entityId: doc._id, branchId: doc.branchId, after: doc })
      if (body.contract) await insertContract(ctx, tenantId, doc, body.contract, actorId, null)
      return doc
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(employeeResponse(result))
  })

  app.patch('/hr/employees/:id', scoped('hr.employee.update'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const { effectiveDate, ...patch } = parsed.data as z.infer<typeof updateBody> & Record<string, unknown>
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })
    const tenantId = request.auth!.tenantId!
    const access = await employeeAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    if (typeof patch.branchId === 'string' && !(await callerCanUseBranch(request, patch.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    for (const [field, kind] of [
      ['departmentCode', 'department'],
      ['positionCode', 'position'],
    ] as const) {
      if (patch[field] !== undefined && !(await checkCode(tenantId, kind, patch[field] as string | null))) {
        return reply.code(400).send({ error: 'INVALID_CODE', field })
      }
    }
    const actorId = request.auth!.sub
    const when = effectiveDate ?? todayIso()
    const result = await transact(tenantId, async (ctx) => {
      const before = await ctx.employees.findOne({ _id: id })
      if (!before) throw new Abort('UNKNOWN_EMPLOYEE')
      if (typeof patch.branchId === 'string' && !(await ctx.branches.findOne({ _id: patch.branchId }))) throw new Abort('NOT_FOUND')
      const after = await ctx.employees.findOneAndUpdate(
        { _id: id },
        { $set: { ...patch, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      for (const [field, type] of [
        ['branchId', 'branch_change'],
        ['departmentCode', 'department_change'],
        ['positionCode', 'position_change'],
      ] as const) {
        if (patch[field] !== undefined && patch[field] !== before[field]) {
          await recordEvent(ctx, tenantId, {
            employeeId: id,
            branchId: after!.branchId,
            type,
            date: when,
            from: before[field],
            to: after![field],
            actorId,
          })
        }
      }
      await recordAudit(ctx.auditLog, { actorId, action: 'employee.update', entity: 'employee', entityId: id, branchId: after!.branchId, before, after })
      return after!
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(employeeResponse(result))
  })

  app.post('/hr/employees/:id/terminate', scoped('hr.employee.update'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const reason = readReason(request.body)
    if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' })
    const parsed = z.object({ date }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    setAuditReason(reason)
    const tenantId = request.auth!.tenantId!
    const access = await employeeAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const actorId = request.auth!.sub
    const when = parsed.data.date
    const result = await transact(tenantId, async (ctx) => {
      const after = await ctx.employees.findOneAndUpdate(
        { _id: id, status: 'active' },
        { $set: { status: 'terminated', terminationDate: when, terminationReason: reason, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      if (!after) throw new Abort('NOT_ACTIVE')
      if (when < after.hireDate) throw new Abort('DATES_OUT_OF_ORDER')
      // Close open contracts on the last day; ones not yet started are closed too.
      for (const c of await ctx.contracts.find({ employeeId: id, closedReason: null }).toArray()) {
        await ctx.contracts.findOneAndUpdate(
          { _id: c._id },
          {
            $set: {
              closedReason: 'terminated',
              closedAt: new Date(),
              endDate: c.endDate && c.endDate < when ? c.endDate : c.startDate > when ? c.startDate : when,
            },
          },
        )
      }
      // Pending and future approved leave no longer applies.
      await ctx.leaveRequests.updateMany(
        { employeeId: id, status: { $in: ['pending', 'approved'] }, startDate: { $gt: when } },
        { $set: { status: 'cancelled', updatedAt: new Date() } },
      )
      await recordEvent(ctx, tenantId, { employeeId: id, branchId: after.branchId, type: 'terminate', date: when, note: reason, actorId })
      await recordAudit(ctx.auditLog, {
        actorId,
        action: 'employee.terminate',
        entity: 'employee',
        entityId: id,
        branchId: after.branchId,
        before: { status: 'active' },
        after: { status: 'terminated', terminationDate: when },
      })
      return after
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(employeeResponse(result))
  })

  app.post('/hr/employees/:id/rehire', scoped('hr.employee.update'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ date }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await employeeAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const actorId = request.auth!.sub
    const result = await transact(tenantId, async (ctx) => {
      const before = await ctx.employees.findOne({ _id: id, status: 'terminated' })
      if (!before) throw new Abort('NOT_TERMINATED')
      if (before.terminationDate && parsed.data.date <= before.terminationDate) throw new Abort('DATES_OUT_OF_ORDER')
      const after = await ctx.employees.findOneAndUpdate(
        { _id: id },
        { $set: { status: 'active', terminationDate: null, terminationReason: null, hireDate: parsed.data.date, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordEvent(ctx, tenantId, { employeeId: id, branchId: before.branchId, type: 'rehire', date: parsed.data.date, actorId })
      await recordAudit(ctx.auditLog, { actorId, action: 'employee.rehire', entity: 'employee', entityId: id, branchId: before.branchId, before, after })
      return after!
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(employeeResponse(result))
  })

  // A login (a member of this school) linked to the record, or null to unlink.
  app.put('/hr/employees/:id/user', scoped('hr.employee.update'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ userId: z.string().min(1).nullable() }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await employeeAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const { userId } = parsed.data
    if (userId) {
      const member = await withoutTenant((db) => db.memberships.findOne({ _id: `${tenantId}:${userId}` }))
      if (!member || member.roleKey === 'parent') return reply.code(404).send({ error: 'UNKNOWN_MEMBER' })
    }
    const result = await transact(
      tenantId,
      async (ctx) => {
        const after = await ctx.employees.findOneAndUpdate({ _id: id }, { $set: { userId, updatedAt: new Date() } }, { returnDocument: 'after' })
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'employee.linkUser',
          entity: 'employee',
          entityId: id,
          branchId: after!.branchId,
          before: { userId: access.doc.userId },
          after: { userId },
        })
        return after!
      },
      'USER_ALREADY_LINKED',
    )
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(employeeResponse(result))
  })

  app.get('/hr/employees/:id/history', scoped('hr.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const access = await employeeAccess(request, request.auth!.tenantId!, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.employmentEvents.find({ employeeId: id }).sort({ date: -1, createdAt: -1 }).toArray(),
    )
    return reply.send({
      events: rows.map((e) => ({ id: e._id, type: e.type, date: e.date, from: e.from, to: e.to, note: e.note, branchId: e.branchId, createdAt: e.createdAt.toISOString() })),
    })
  })

  // ----------------------------------------------------------- contracts

  app.get('/hr/employees/:id/contracts', scoped('hr.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const access = await employeeAccess(request, request.auth!.tenantId!, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const rows = await withTenant(request.auth!.tenantId!, (ctx) => ctx.contracts.find({ employeeId: id }).sort({ startDate: -1 }).toArray())
    const salary = await callerHasPermission(request, 'hr.salary.read')
    const today = todayIso()
    return reply.send({ contracts: rows.map((c) => contractResponse(c, today, salary)) })
  })

  app.post('/hr/employees/:id/contracts', scoped('hr.employee.update'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = contractBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await employeeAccess(request, tenantId, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    if (!(await checkCode(tenantId, 'contractType', parsed.data.typeCode))) return reply.code(400).send({ error: 'INVALID_CODE', field: 'typeCode' })
    if (parsed.data.endDate && parsed.data.endDate < parsed.data.startDate) return reply.code(400).send({ error: 'DATES_OUT_OF_ORDER' })
    const showSalary = await callerHasPermission(request, 'hr.salary.read')
    if (parsed.data.salary !== null && !showSalary) return reply.code(403).send({ error: 'SALARY_REQUIRES_SCOPE' })
    const result = await transact(tenantId, async (ctx) => {
      const employee = await ctx.employees.findOne({ _id: id })
      if (!employee || employee.status !== 'active') throw new Abort('NOT_ACTIVE')
      return insertContract(ctx, tenantId, employee, parsed.data, request.auth!.sub, null)
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(contractResponse(result, todayIso(), showSalary))
  })

  app.post('/hr/contracts/:id/renew', scoped('hr.employee.update'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = renewBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const old = await withTenant(tenantId, (ctx) => ctx.contracts.findOne({ _id: id }))
    if (!old) return reply.code(404).send({ error: 'NOT_FOUND' })
    const access = await employeeAccess(request, tenantId, old.employeeId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    if (parsed.data.typeCode && !(await checkCode(tenantId, 'contractType', parsed.data.typeCode))) {
      return reply.code(400).send({ error: 'INVALID_CODE', field: 'typeCode' })
    }
    const showSalary = await callerHasPermission(request, 'hr.salary.read')
    if (parsed.data.salary !== undefined && parsed.data.salary !== null && !showSalary) {
      return reply.code(403).send({ error: 'SALARY_REQUIRES_SCOPE' })
    }
    const actorId = request.auth!.sub
    const result = await transact(tenantId, async (ctx) => {
      const current = await ctx.contracts.findOne({ _id: id, closedReason: null })
      if (!current) throw new Abort('NOT_OPEN')
      if (!current.endDate) throw new Abort('OPEN_ENDED')
      const employee = await ctx.employees.findOne({ _id: current.employeeId })
      if (!employee || employee.status !== 'active') throw new Abort('NOT_ACTIVE')
      const startDate = addDays(current.endDate, 1)
      if (parsed.data.endDate && parsed.data.endDate < startDate) throw new Abort('DATES_OUT_OF_ORDER')
      await ctx.contracts.findOneAndUpdate({ _id: id }, { $set: { closedReason: 'renewed', closedAt: new Date() } })
      const next = await insertContract(
        ctx,
        tenantId,
        employee,
        {
          typeCode: parsed.data.typeCode ?? current.typeCode,
          startDate,
          endDate: parsed.data.endDate,
          // Carried over unless changed; a caller who can't see it can't change it.
          salary: parsed.data.salary !== undefined ? parsed.data.salary : current.salary,
          hoursPerWeek: parsed.data.hoursPerWeek !== undefined ? parsed.data.hoursPerWeek : current.hoursPerWeek,
          notes: null,
        },
        actorId,
        current._id,
      )
      return next
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(contractResponse(result, todayIso(), showSalary))
  })

  app.post('/hr/contracts/:id/end', scoped('hr.employee.update'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ date }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const old = await withTenant(tenantId, (ctx) => ctx.contracts.findOne({ _id: id }))
    if (!old) return reply.code(404).send({ error: 'NOT_FOUND' })
    const access = await employeeAccess(request, tenantId, old.employeeId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const actorId = request.auth!.sub
    const result = await transact(tenantId, async (ctx) => {
      const current = await ctx.contracts.findOne({ _id: id, closedReason: null })
      if (!current) throw new Abort('NOT_OPEN')
      if (parsed.data.date < current.startDate) throw new Abort('DATES_OUT_OF_ORDER')
      const after = await ctx.contracts.findOneAndUpdate(
        { _id: id },
        { $set: { closedReason: 'ended', closedAt: new Date(), endDate: current.endDate && current.endDate < parsed.data.date ? current.endDate : parsed.data.date } },
        { returnDocument: 'after' },
      )
      await recordEvent(ctx, tenantId, { employeeId: current.employeeId, branchId: current.branchId, type: 'contract_end', date: after!.endDate!, from: current.typeCode, actorId })
      await recordAudit(ctx.auditLog, { actorId, action: 'contract.end', entity: 'contract', entityId: id, branchId: current.branchId, before: current, after })
      return after!
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(contractResponse(result, todayIso(), await callerHasPermission(request, 'hr.salary.read')))
  })

  // Contracts ending soon (or already ended with no successor), for the
  // dashboard and the HR page.
  app.get('/hr/contracts/expiring', scoped('hr.read'), async (request, reply) => {
    const { branchId } = request.query as { branchId?: string }
    const branches = await branchFilter(request, branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const today = todayIso()
    const rows = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const open = await ctx.contracts
        .find({
          closedReason: null,
          endDate: { $ne: null, $lte: addDays(today, EXPIRING_DAYS) },
          ...(branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}),
        })
        .sort({ endDate: 1 })
        .toArray()
      const employees = await ctx.employees.find({ _id: { $in: open.map((c) => c.employeeId) }, status: 'active' }).toArray()
      const byId = new Map(employees.map((e) => [e._id, e]))
      return open.filter((c) => byId.has(c.employeeId)).map((c) => ({ contract: c, employee: byId.get(c.employeeId)! }))
    })
    const salary = await callerHasPermission(request, 'hr.salary.read')
    return reply.send({
      contracts: rows.map((r) => ({ ...contractResponse(r.contract, today, salary), employeeName: fullName(r.employee), employeeNumber: r.employee.employeeNumber })),
    })
  })
}

/** Inserts a contract after checking it overlaps none of the employee's. */
async function insertContract(
  ctx: TenantContext,
  tenantId: string,
  employee: EmployeeDoc,
  body: z.infer<typeof contractBody>,
  actorId: string,
  renewedFromId: string | null,
): Promise<ContractDoc> {
  const existing = await ctx.contracts.find({ employeeId: employee._id }).toArray()
  if (existing.some((c) => c._id !== renewedFromId && overlaps(c, body))) throw new Abort('CONTRACT_OVERLAPS')
  const doc: ContractDoc = {
    _id: randomUUID(),
    tenantId,
    employeeId: employee._id,
    branchId: employee.branchId,
    typeCode: body.typeCode,
    startDate: body.startDate,
    endDate: body.endDate,
    salary: body.salary,
    hoursPerWeek: body.hoursPerWeek,
    notes: body.notes,
    closedReason: null,
    closedAt: null,
    renewedFromId,
    createdAt: new Date(),
    createdBy: actorId,
  }
  await ctx.contracts.insertOne(doc)
  await recordEvent(ctx, tenantId, {
    employeeId: employee._id,
    branchId: employee.branchId,
    type: renewedFromId ? 'contract_renew' : 'contract_start',
    date: doc.startDate,
    to: doc.typeCode,
    note: doc.endDate ? `until ${doc.endDate}` : null,
    actorId,
  })
  // The salary is kept out of the audit trail's readable copy.
  await recordAudit(ctx.auditLog, {
    actorId,
    action: renewedFromId ? 'contract.renew' : 'contract.create',
    entity: 'contract',
    entityId: doc._id,
    branchId: doc.branchId,
    after: { ...doc, salary: doc.salary === null ? null : 'set' },
  })
  return doc
}
