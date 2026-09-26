import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { DriverDoc, TenantContext } from '../db.js'
import { callerCanUseBranch, callerHasPermission } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { chargeStudents } from '../finance/service.js'
import { Abort, branchFilter, isFailure, scoped, sendFailure, todayIso, transact } from '../records.js'
import { addDays, EXPIRING_DAYS, recordAccess } from './common.js'

/**
 * SAMS 5.4: transport administration, on top of the routing module's buses
 * and stops (transport/routes.ts), which it leaves untouched:
 *  - drivers (optionally an HR employee), with licence expiry and a bus;
 *  - a bus's paperwork: plate, registration, insurance and inspection
 *    expiry (kept in `busDetails`, apart from what the solver reads);
 *  - one compliance list of everything expired or expiring within 60
 *    days, including dated documents attached to buses and drivers;
 *  - transport fees per branch and year, and billing them to every rider
 *    (a student with a stop and a transport mode) as an invoice line.
 */

const date = z.string().date()
const driverBody = z.object({
  branchId: z.string().min(1),
  employeeId: z.string().min(1).nullable().default(null),
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).nullable().default(null),
  licenseNumber: z.string().trim().max(60).nullable().default(null),
  licenseExpiry: date.nullable().default(null),
  busId: z.string().min(1).nullable().default(null),
})
const detailsBody = z.object({
  plateNumber: z.string().trim().max(30).nullable().default(null),
  registrationExpiry: date.nullable().default(null),
  insuranceExpiry: date.nullable().default(null),
  inspectionExpiry: date.nullable().default(null),
  attendantName: z.string().trim().max(200).nullable().default(null),
})
const feeBody = z.object({
  branchId: z.string().min(1),
  academicYearId: z.string().min(1),
  twoWay: z.number().int().min(0),
  oneWay: z.number().int().min(0),
})

const driverResponse = (d: DriverDoc) => ({
  id: d._id,
  branchId: d.branchId,
  employeeId: d.employeeId,
  name: d.name,
  phone: d.phone,
  licenseNumber: d.licenseNumber,
  licenseExpiry: d.licenseExpiry,
  busId: d.busId,
  active: d.active,
})

export function registerTransportAdminRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------ buses

  app.get('/ops/transport/buses', scoped('transport.read'), async (request, reply) => {
    const { branchId } = request.query as { branchId?: string }
    const branches = await branchFilter(request, branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const inBranch = branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}
    const data = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const buses = await ctx.buses.find({ ...inBranch, active: true }).sort({ name: 1 }).toArray()
      const [details, drivers] = await Promise.all([
        ctx.busDetails.find({ _id: { $in: buses.map((b) => b._id) } }).toArray(),
        ctx.drivers.find({ busId: { $in: buses.map((b) => b._id) }, active: true }).toArray(),
      ])
      return { buses, details: new Map(details.map((d) => [d._id, d])), drivers }
    })
    return reply.send({
      buses: data.buses.map((b) => {
        const d = data.details.get(b._id)
        return {
          id: b._id,
          branchId: b.branchId,
          name: b.name,
          seats: b.seats,
          plateNumber: d?.plateNumber ?? null,
          registrationExpiry: d?.registrationExpiry ?? null,
          insuranceExpiry: d?.insuranceExpiry ?? null,
          inspectionExpiry: d?.inspectionExpiry ?? null,
          attendantName: d?.attendantName ?? null,
          drivers: data.drivers.filter((x) => x.busId === b._id).map(driverResponse),
        }
      }),
    })
  })

  app.put('/ops/transport/buses/:id/details', scoped('transport.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = detailsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const access = await recordAccess(request, (ctx) => ctx.buses.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const tenantId = request.auth!.tenantId!
    await withTenant(tenantId, async (ctx) => {
      const before = await ctx.busDetails.findOne({ _id: id })
      await ctx.busDetails.findOneAndUpdate(
        { _id: id },
        { $set: { ...parsed.data, branchId: access.doc.branchId, updatedAt: new Date() }, $setOnInsert: { tenantId } },
        { upsert: true },
      )
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'bus.details', entity: 'bus', entityId: id, branchId: access.doc.branchId, before, after: parsed.data })
    })
    return reply.send({ id, ...parsed.data })
  })

  // ---------------------------------------------------------- drivers

  app.get('/ops/transport/drivers', scoped('transport.read'), async (request, reply) => {
    const { branchId } = request.query as { branchId?: string }
    const branches = await branchFilter(request, branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.drivers.find(branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}).sort({ name: 1 }).toArray(),
    )
    return reply.send({ drivers: rows.map(driverResponse) })
  })

  const checkDriver = async (tenantId: string, d: { branchId: string; employeeId?: string | null; busId?: string | null }) =>
    withTenant(tenantId, async (ctx) => {
      if (d.busId) {
        const bus = await ctx.buses.findOne({ _id: d.busId })
        if (!bus || !bus.active || bus.branchId !== d.branchId) return 'UNKNOWN_BUS'
      }
      if (d.employeeId && !(await ctx.employees.findOne({ _id: d.employeeId }))) return 'UNKNOWN_EMPLOYEE'
      return null
    })

  app.post('/ops/transport/drivers', scoped('transport.manage'), async (request, reply) => {
    const parsed = driverBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const bad = await checkDriver(tenantId, parsed.data)
    if (bad) return reply.code(bad === 'UNKNOWN_EMPLOYEE' ? 404 : 409).send({ error: bad })
    const now = new Date()
    const doc: DriverDoc = { _id: randomUUID(), tenantId, ...parsed.data, active: true, createdAt: now, updatedAt: now }
    await withTenant(tenantId, async (ctx) => {
      await ctx.drivers.insertOne(doc)
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'driver.create', entity: 'driver', entityId: doc._id, branchId: doc.branchId, after: doc })
    })
    return reply.code(201).send(driverResponse(doc))
  })

  app.patch('/ops/transport/drivers/:id', scoped('transport.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = driverBody.omit({ branchId: true }).partial().extend({ active: z.boolean().optional() }).safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const access = await recordAccess(request, (ctx) => ctx.drivers.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const tenantId = request.auth!.tenantId!
    const bad = await checkDriver(tenantId, { ...parsed.data, branchId: access.doc.branchId })
    if (bad) return reply.code(bad === 'UNKNOWN_EMPLOYEE' ? 404 : 409).send({ error: bad })
    const after = await withTenant(tenantId, async (ctx) => {
      const after = await ctx.drivers.findOneAndUpdate({ _id: id }, { $set: { ...parsed.data, updatedAt: new Date() } }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'driver.update', entity: 'driver', entityId: id, branchId: access.doc.branchId, before: access.doc, after })
      return after!
    })
    return reply.send(driverResponse(after))
  })

  // ------------------------------------------------------- compliance

  app.get('/ops/transport/compliance', scoped('transport.read'), async (request, reply) => {
    const { branchId } = request.query as { branchId?: string }
    const branches = await branchFilter(request, branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const inBranch = branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}
    const today = todayIso()
    const soon = addDays(today, EXPIRING_DAYS)
    const d = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const buses = await ctx.buses.find({ ...inBranch, active: true }).toArray()
      const drivers = await ctx.drivers.find({ ...inBranch, active: true }).toArray()
      const details = await ctx.busDetails.find({ _id: { $in: buses.map((b) => b._id) } }).toArray()
      const docs = await ctx.documents
        .find({
          $or: [
            { ownerType: 'bus', ownerId: { $in: buses.map((b) => b._id) } },
            { ownerType: 'driver', ownerId: { $in: drivers.map((x) => x._id) } },
          ],
          isCurrent: true,
          archivedAt: null,
          expiresAt: { $ne: null, $lte: soon },
        })
        .toArray()
      return { buses, drivers, details, docs }
    })
    const busName = new Map(d.buses.map((b) => [b._id, b.name]))
    const driverName = new Map(d.drivers.map((x) => [x._id, x.name]))
    const items: { kind: string; ownerType: 'bus' | 'driver'; ownerId: string; name: string; expiresAt: string; expired: boolean }[] = []
    const add = (kind: string, ownerType: 'bus' | 'driver', ownerId: string, name: string, expiresAt: string | null) => {
      if (expiresAt && expiresAt <= soon) items.push({ kind, ownerType, ownerId, name, expiresAt, expired: expiresAt < today })
    }
    for (const det of d.details) {
      const name = busName.get(det._id) ?? ''
      add('registration', 'bus', det._id, name, det.registrationExpiry)
      add('insurance', 'bus', det._id, name, det.insuranceExpiry)
      add('inspection', 'bus', det._id, name, det.inspectionExpiry)
    }
    for (const x of d.drivers) add('license', 'driver', x._id, x.name, x.licenseExpiry)
    for (const doc of d.docs) {
      const ownerType = doc.ownerType as 'bus' | 'driver'
      add(`document:${doc.categoryCode}`, ownerType, doc.ownerId, (ownerType === 'bus' ? busName : driverName).get(doc.ownerId) ?? '', doc.expiresAt)
    }
    // Buses with no paperwork on file at all are a gap too.
    const missing = d.buses.filter((b) => !d.details.some((x) => x._id === b._id)).map((b) => ({ busId: b._id, name: b.name }))
    items.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
    return reply.send({ asOf: today, items, busesWithoutDetails: missing })
  })

  // -------------------------------------------------------------- fees

  app.get('/ops/transport/fees', scoped('transport.read'), async (request, reply) => {
    const { branchId, academicYearId } = request.query as { branchId?: string; academicYearId?: string }
    if (!branchId || !academicYearId) return reply.code(400).send({ error: 'INVALID_QUERY' })
    if (!(await callerCanUseBranch(request, branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const data = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const fee = await ctx.transportFees.findOne({ branchId, academicYearId })
      const riders = await riderCharges(ctx, branchId, academicYearId, fee?.twoWay ?? 0, fee?.oneWay ?? 0)
      return { fee, riders }
    })
    return reply.send({
      fee: data.fee ? { id: data.fee._id, twoWay: data.fee.twoWay, oneWay: data.fee.oneWay } : null,
      riders: { twoWay: data.riders.filter((r) => r.mode === 'TWO_WAY').length, oneWay: data.riders.filter((r) => r.mode !== 'TWO_WAY').length },
    })
  })

  app.put('/ops/transport/fees', scoped('transport.manage'), async (request, reply) => {
    const parsed = feeBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const { branchId, academicYearId, twoWay, oneWay } = parsed.data
    if (!(await callerCanUseBranch(request, branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const result = await transact(tenantId, async (ctx) => {
      if (!(await ctx.academicYears.findOne({ _id: academicYearId }))) throw new Abort('NOT_FOUND')
      const before = await ctx.transportFees.findOne({ branchId, academicYearId })
      const after = await ctx.transportFees.findOneAndUpdate(
        { branchId, academicYearId },
        { $set: { twoWay, oneWay, updatedAt: new Date() }, $setOnInsert: { _id: randomUUID(), tenantId } },
        { upsert: true, returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'transportFee.set', entity: 'branch', entityId: branchId, branchId, before, after })
      return after!
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send({ id: result._id, twoWay: result.twoWay, oneWay: result.oneWay })
  })

  // Adds the fee to each rider's invoice for the year; running it again
  // only charges riders not yet charged.
  app.post('/ops/transport/fees/bill', scoped('transport.manage'), async (request, reply) => {
    const parsed = z.object({ branchId: z.string().min(1), academicYearId: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const { branchId, academicYearId } = parsed.data
    if (!(await callerHasPermission(request, 'finance.invoice.lineItems'))) return reply.code(403).send({ error: 'FORBIDDEN', required: 'finance.invoice.lineItems' })
    if (!(await callerCanUseBranch(request, branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      const fee = await ctx.transportFees.findOne({ branchId, academicYearId })
      if (!fee) throw new Abort('NO_FEE')
      const riders = await riderCharges(ctx, branchId, academicYearId, fee.twoWay, fee.oneWay)
      const res = await chargeStudents(ctx, {
        academicYearId,
        charges: riders.map((r) => ({ studentId: r.studentId, amount: r.amount })),
        label: 'Transport',
        labelAr: 'النقل',
        sourceFeeItemId: `transport:${fee._id}`,
        actorId: request.auth!.sub,
      })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'transportFee.bill',
        entity: 'branch',
        entityId: branchId,
        branchId,
        meta: { academicYearId, charged: res.charged.length, alreadyCharged: res.alreadyCharged.length, noInvoice: res.noInvoice.length },
      })
      return res
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send({ charged: result.charged.length, alreadyCharged: result.alreadyCharged.length, noInvoice: result.noInvoice })
  })
}

/** Students enrolled in the branch and year who ride, with what they owe. */
async function riderCharges(
  ctx: TenantContext,
  branchId: string,
  academicYearId: string,
  twoWay: number,
  oneWay: number,
) {
  const enrolled = await ctx.enrollments.find({ branchId, academicYearId, status: 'active' }).toArray()
  const students = await ctx.students
    .find({ _id: { $in: enrolled.map((e) => e.studentId) }, transportMode: { $ne: 'NONE' }, stopId: { $nin: [''] } })
    .toArray()
  return students.map((s) => ({ studentId: s._id, mode: s.transportMode, amount: s.transportMode === 'TWO_WAY' ? twoWay : oneWay }))
}
