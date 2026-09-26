import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { EventDoc, EventRegistrationDoc, EventStatus, TenantContext } from '../db.js'
import { callerCanUseBranch, callerHasPermission } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { chargeStudents } from '../finance/service.js'
import { Abort, branchFilter, isFailure, scoped, sendFailure, todayIso, transact } from '../records.js'
import { checkCode, recordAccess } from './common.js'

/**
 * SAMS 5.6: events and activities (trips, clubs, sports days…).
 *
 *   draft → open (registration) → closed → completed      (or cancelled)
 *
 * Registration is per student of the event's branch whose class grade is
 * among the event's grades (none listed = every grade), before the
 * deadline. Past capacity a registration is waitlisted; when a place frees
 * up the oldest waitlisted student moves up. Attendance is marked per
 * registration. Costs are listed on the event; the fee can be billed to
 * every registered student's invoice for the year.
 */

const date = z.string().date()
const eventBody = z.object({
  branchId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  titleAr: z.string().trim().max(200).nullable().default(null),
  typeCode: z.string().min(1).max(64),
  description: z.string().trim().max(4000).nullable().default(null),
  location: z.string().trim().max(200).nullable().default(null),
  startDate: date,
  endDate: date,
  capacity: z.number().int().min(1).max(100000).nullable().default(null),
  registrationDeadline: date.nullable().default(null),
  fee: z.number().int().min(0).nullable().default(null),
  gradeLevels: z.array(z.string().min(1).max(60)).max(30).default([]),
})
const patchBody = eventBody.omit({ branchId: true }).partial()
const listQuery = z.object({
  branchId: z.string().optional(),
  status: z.enum(['draft', 'open', 'closed', 'cancelled', 'completed']).optional(),
  upcoming: z.enum(['true']).optional(),
})

/** Allowed status moves. */
const NEXT: Record<EventStatus, EventStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['closed', 'cancelled'],
  closed: ['open', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

function eventResponse(e: EventDoc, counts?: { registered: number; waitlisted: number; attended: number }) {
  const costTotal = e.costs.reduce((s, c) => s + c.amount, 0)
  const registered = counts?.registered ?? 0
  return {
    id: e._id,
    branchId: e.branchId,
    title: e.title,
    titleAr: e.titleAr,
    typeCode: e.typeCode,
    description: e.description,
    location: e.location,
    startDate: e.startDate,
    endDate: e.endDate,
    capacity: e.capacity,
    registrationDeadline: e.registrationDeadline,
    fee: e.fee,
    gradeLevels: e.gradeLevels,
    status: e.status,
    costs: e.costs,
    registered,
    waitlisted: counts?.waitlisted ?? 0,
    attended: counts?.attended ?? 0,
    placesLeft: e.capacity === null ? null : Math.max(0, e.capacity - registered),
    budget: { income: (e.fee ?? 0) * registered, costs: costTotal, net: (e.fee ?? 0) * registered - costTotal },
    createdAt: e.createdAt.toISOString(),
  }
}

async function countsFor(ctx: TenantContext, eventIds: string[]) {
  const regs = await ctx.eventRegistrations.find({ eventId: { $in: eventIds }, status: { $ne: 'cancelled' } }).toArray()
  const m = new Map<string, { registered: number; waitlisted: number; attended: number }>()
  for (const id of eventIds) m.set(id, { registered: 0, waitlisted: 0, attended: 0 })
  for (const r of regs) {
    const c = m.get(r.eventId)!
    if (r.status === 'registered') c.registered++
    else c.waitlisted++
    if (r.attended) c.attended++
  }
  return m
}

/** Moves the oldest waitlisted students up while places are free. */
async function promote(ctx: TenantContext, event: EventDoc): Promise<number> {
  if (event.capacity === null) return 0
  let registered = await ctx.eventRegistrations.countDocuments({ eventId: event._id, status: 'registered' })
  let moved = 0
  while (registered < event.capacity) {
    const [next] = await ctx.eventRegistrations.find({ eventId: event._id, status: 'waitlisted' }).sort({ registeredAt: 1 }).limit(1).toArray()
    if (!next) break
    await ctx.eventRegistrations.findOneAndUpdate({ _id: next._id }, { $set: { status: 'registered', updatedAt: new Date() } })
    registered++
    moved++
  }
  return moved
}

export function registerEventRoutes(app: FastifyInstance): void {
  app.get('/ops/events', scoped('ops.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<EventDoc> = {}
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    if (parsed.data.status) filter.status = parsed.data.status
    if (parsed.data.upcoming) filter.endDate = { $gte: todayIso() }
    const { rows, counts } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const rows = await ctx.events.find(filter).sort({ startDate: parsed.data.upcoming ? 1 : -1 }).limit(500).toArray()
      return { rows, counts: await countsFor(ctx, rows.map((r) => r._id)) }
    })
    return reply.send({ events: rows.map((e) => eventResponse(e, counts.get(e._id))) })
  })

  app.get('/ops/events/:id', scoped('ops.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const access = await recordAccess(request, (ctx) => ctx.events.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const data = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const regs = await ctx.eventRegistrations.find({ eventId: id, status: { $ne: 'cancelled' } }).sort({ registeredAt: 1 }).toArray()
      const students = await ctx.students.find({ _id: { $in: regs.map((r) => r.studentId) } }).toArray()
      return { regs, students: new Map(students.map((s) => [s._id, s])), counts: await countsFor(ctx, [id]) }
    })
    return reply.send({
      ...eventResponse(access.doc, data.counts.get(id)),
      registrations: data.regs.map((r) => {
        const s = data.students.get(r.studentId)
        return {
          id: r._id,
          studentId: r.studentId,
          studentName: s ? `${s.givenName} ${s.familyName}`.trim() : null,
          studentNumber: s?.studentNumber ?? null,
          status: r.status,
          attended: r.attended,
          registeredAt: r.registeredAt.toISOString(),
        }
      }),
    })
  })

  app.post('/ops/events', scoped('ops.events.manage'), async (request, reply) => {
    const parsed = eventBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const body = parsed.data
    if (body.endDate < body.startDate) return reply.code(400).send({ error: 'DATES_OUT_OF_ORDER' })
    if (!(await callerCanUseBranch(request, body.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    if (!(await checkCode(tenantId, 'eventType', body.typeCode))) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    const now = new Date()
    const doc: EventDoc = { _id: randomUUID(), tenantId, ...body, status: 'draft', costs: [], createdAt: now, updatedAt: now, createdBy: request.auth!.sub }
    await withTenant(tenantId, async (ctx) => {
      await ctx.events.insertOne(doc)
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'event.create', entity: 'event', entityId: doc._id, branchId: doc.branchId, after: doc })
    })
    return reply.code(201).send(eventResponse(doc))
  })

  app.patch('/ops/events/:id', scoped('ops.events.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = patchBody.safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await recordAccess(request, (ctx) => ctx.events.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    if (parsed.data.typeCode && !(await checkCode(tenantId, 'eventType', parsed.data.typeCode))) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    const result = await transact(tenantId, async (ctx) => {
      const before = await ctx.events.findOne({ _id: id })
      if (!before) throw new Abort('NOT_FOUND')
      if (before.status === 'completed' || before.status === 'cancelled') throw new Abort('WRONG_STATUS')
      const next = { ...before, ...parsed.data }
      if (next.endDate < next.startDate) throw new Abort('DATES_OUT_OF_ORDER')
      const after = (await ctx.events.findOneAndUpdate({ _id: id }, { $set: { ...parsed.data, updatedAt: new Date() } }, { returnDocument: 'after' }))!
      // A larger capacity lets waitlisted students in.
      await promote(ctx, after)
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'event.update', entity: 'event', entityId: id, branchId: before.branchId, before, after })
      return { after, counts: await countsFor(ctx, [id]) }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(eventResponse(result.after, result.counts.get(id)))
  })

  app.post('/ops/events/:id/status', scoped('ops.events.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ status: z.enum(['open', 'closed', 'completed', 'cancelled']) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const access = await recordAccess(request, (ctx) => ctx.events.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      const before = await ctx.events.findOne({ _id: id })
      if (!before) throw new Abort('NOT_FOUND')
      if (!NEXT[before.status].includes(parsed.data.status)) throw new Abort('WRONG_STATUS', { from: before.status })
      const after = (await ctx.events.findOneAndUpdate({ _id: id }, { $set: { status: parsed.data.status, updatedAt: new Date() } }, { returnDocument: 'after' }))!
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: `event.${parsed.data.status}`,
        entity: 'event',
        entityId: id,
        branchId: before.branchId,
        before: { status: before.status },
        after: { status: after.status },
      })
      return { after, counts: await countsFor(ctx, [id]) }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(eventResponse(result.after, result.counts.get(id)))
  })

  app.put('/ops/events/:id/costs', scoped('ops.events.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z
      .object({ costs: z.array(z.object({ label: z.string().trim().min(1).max(120), amount: z.number().int().min(0) })).max(50) })
      .safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const access = await recordAccess(request, (ctx) => ctx.events.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const costs = parsed.data.costs.map((c) => ({ id: randomUUID(), ...c }))
    const result = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const after = (await ctx.events.findOneAndUpdate({ _id: id }, { $set: { costs, updatedAt: new Date() } }, { returnDocument: 'after' }))!
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'event.costs', entity: 'event', entityId: id, branchId: after.branchId, before: { costs: access.doc.costs }, after: { costs } })
      return { after, counts: await countsFor(ctx, [id]) }
    })
    return reply.send(eventResponse(result.after, result.counts.get(id)))
  })

  // ------------------------------------------------------- registration

  app.post('/ops/events/:id/registrations', scoped('ops.events.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ studentId: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const access = await recordAccess(request, (ctx) => ctx.events.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const tenantId = request.auth!.tenantId!
    const result = await transact(
      tenantId,
      async (ctx) => {
        const event = await ctx.events.findOne({ _id: id })
        if (!event) throw new Abort('NOT_FOUND')
        if (event.status !== 'open') throw new Abort('REGISTRATION_CLOSED')
        if (event.registrationDeadline && todayIso() > event.registrationDeadline) throw new Abort('REGISTRATION_CLOSED')
        const student = await ctx.students.findOne({ _id: parsed.data.studentId })
        if (!student || student.branchId !== event.branchId) throw new Abort('UNKNOWN_STUDENT')
        if (event.gradeLevels.length > 0) {
          const klass = student.classId ? await ctx.classes.findOne({ _id: student.classId }) : null
          if (!klass || !event.gradeLevels.includes(klass.gradeLevel)) throw new Abort('NOT_ELIGIBLE')
        }
        const registered = await ctx.eventRegistrations.countDocuments({ eventId: id, status: 'registered' })
        const full = event.capacity !== null && registered >= event.capacity
        const now = new Date()
        const doc: EventRegistrationDoc = {
          _id: randomUUID(),
          tenantId,
          eventId: id,
          branchId: event.branchId,
          studentId: student._id,
          status: full ? 'waitlisted' : 'registered',
          attended: null,
          registeredAt: now,
          updatedAt: now,
        }
        await ctx.eventRegistrations.insertOne(doc)
        await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'event.register', entity: 'event', entityId: id, branchId: event.branchId, meta: { studentId: student._id, status: doc.status } })
        return doc
      },
      'ALREADY_REGISTERED',
    )
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send({ id: result._id, studentId: result.studentId, status: result.status })
  })

  app.post('/ops/events/:id/registrations/:regId/cancel', scoped('ops.events.manage'), async (request, reply) => {
    const { id, regId } = request.params as { id: string; regId: string }
    const access = await recordAccess(request, (ctx) => ctx.events.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      const reg = await ctx.eventRegistrations.findOneAndUpdate(
        { _id: regId, eventId: id, status: { $in: ['registered', 'waitlisted'] } },
        { $set: { status: 'cancelled', updatedAt: new Date() } },
        { returnDocument: 'before' },
      )
      if (!reg) throw new Abort('NOT_FOUND')
      const promoted = reg.status === 'registered' ? await promote(ctx, access.doc) : 0
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'event.unregister', entity: 'event', entityId: id, branchId: access.doc.branchId, meta: { studentId: reg.studentId, promoted } })
      return { promoted }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(result)
  })

  app.put('/ops/events/:id/attendance', scoped('ops.events.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ records: z.array(z.object({ registrationId: z.string().min(1), attended: z.boolean() })).min(1).max(5000) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const access = await recordAccess(request, (ctx) => ctx.events.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      if (access.doc.startDate > todayIso()) throw new Abort('NOT_STARTED')
      let saved = 0
      for (const r of parsed.data.records) {
        const res = await ctx.eventRegistrations.findOneAndUpdate(
          { _id: r.registrationId, eventId: id, status: 'registered' },
          { $set: { attended: r.attended, updatedAt: new Date() } },
        )
        if (res) saved++
      }
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'event.attendance', entity: 'event', entityId: id, branchId: access.doc.branchId, meta: { saved } })
      return { saved }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(result)
  })

  // Bills the fee to every registered student's invoice for the year.
  app.post('/ops/events/:id/bill', scoped('ops.events.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ academicYearId: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerHasPermission(request, 'finance.invoice.lineItems'))) return reply.code(403).send({ error: 'FORBIDDEN', required: 'finance.invoice.lineItems' })
    const access = await recordAccess(request, (ctx) => ctx.events.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const event = access.doc
    if (!event.fee) return reply.code(409).send({ error: 'NO_FEE' })
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      if (event.status === 'cancelled' || event.status === 'draft') throw new Abort('WRONG_STATUS')
      const regs = await ctx.eventRegistrations.find({ eventId: id, status: 'registered' }).toArray()
      const res = await chargeStudents(ctx, {
        academicYearId: parsed.data.academicYearId,
        charges: regs.map((r) => ({ studentId: r.studentId, amount: event.fee! })),
        label: event.title,
        labelAr: event.titleAr,
        sourceFeeItemId: `event:${id}`,
        actorId: request.auth!.sub,
      })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'event.bill', entity: 'event', entityId: id, branchId: event.branchId, meta: { charged: res.charged.length } })
      return res
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send({ charged: result.charged.length, alreadyCharged: result.alreadyCharged.length, noInvoice: result.noInvoice })
  })
}
