import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { BuildingDoc, MaintenanceRequestDoc, MaintenanceStatus, RoomDoc, TenantContext } from '../db.js'
import { callerCanUseBranch, callerHasPermission } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { Abort, branchFilter, isFailure, nextNumber, scoped, sendFailure, todayIso, transact } from '../records.js'
import { assetEvent, checkCode, recordAccess } from './common.js'

/**
 * SAMS 5.3: buildings and rooms per branch, and maintenance requests.
 * Anyone with `ops.maintenance.report` reports a problem; facilities staff
 * (`ops.facilities.manage`) assign, work and resolve it:
 *   open → in_progress → resolved → closed   (or cancelled before resolved)
 * A request about an asset puts it in maintenance when work starts and
 * back when it is resolved, with the cost on the asset's history.
 */

const buildingBody = z.object({
  branchId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(20).nullable().default(null),
  floors: z.number().int().min(1).max(200).nullable().default(null),
})
const roomBody = z.object({
  buildingId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(20).nullable().default(null),
  typeCode: z.string().min(1).max(64),
  capacity: z.number().int().min(0).max(10000).nullable().default(null),
  floor: z.number().int().min(-5).max(200).nullable().default(null),
})
const requestBody = z.object({
  branchId: z.string().min(1),
  roomId: z.string().min(1).nullable().default(null),
  assetId: z.string().min(1).nullable().default(null),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).nullable().default(null),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
})
const updateBody = z
  .object({
    status: z.enum(['in_progress', 'resolved', 'closed', 'cancelled']),
    assignedToEmployeeId: z.string().min(1).nullable(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    resolution: z.string().trim().max(2000),
    cost: z.number().int().min(0),
  })
  .partial()
const listQuery = z.object({
  branchId: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'resolved', 'closed', 'cancelled', 'active']).optional(),
  assetId: z.string().optional(),
})

/** Allowed next statuses. */
const NEXT: Record<MaintenanceStatus, MaintenanceStatus[]> = {
  open: ['in_progress', 'resolved', 'cancelled'],
  in_progress: ['resolved', 'cancelled'],
  resolved: ['closed', 'in_progress'],
  closed: [],
  cancelled: [],
}

const buildingResponse = (b: BuildingDoc) => ({ id: b._id, branchId: b.branchId, name: b.name, code: b.code, floors: b.floors, active: b.active })
const roomResponse = (r: RoomDoc) => ({
  id: r._id,
  branchId: r.branchId,
  buildingId: r.buildingId,
  name: r.name,
  code: r.code,
  typeCode: r.typeCode,
  capacity: r.capacity,
  floor: r.floor,
  active: r.active,
})

export function maintenanceResponse(m: MaintenanceRequestDoc, names?: Map<string, string>) {
  return {
    id: m._id,
    requestNumber: m.requestNumber,
    branchId: m.branchId,
    buildingId: m.buildingId,
    roomId: m.roomId,
    roomName: m.roomId ? (names?.get(m.roomId) ?? null) : null,
    assetId: m.assetId,
    assetName: m.assetId ? (names?.get(m.assetId) ?? null) : null,
    title: m.title,
    description: m.description,
    priority: m.priority,
    status: m.status,
    assignedToEmployeeId: m.assignedToEmployeeId,
    assignedToName: m.assignedToEmployeeId ? (names?.get(m.assignedToEmployeeId) ?? null) : null,
    reportedBy: m.reportedBy,
    resolution: m.resolution,
    cost: m.cost,
    resolvedAt: m.resolvedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  }
}

async function namesFor(ctx: TenantContext, rows: MaintenanceRequestDoc[]) {
  const [rooms, assets, employees] = await Promise.all([
    ctx.rooms.find({ _id: { $in: rows.map((r) => r.roomId).filter((v): v is string => !!v) } }).toArray(),
    ctx.assets.find({ _id: { $in: rows.map((r) => r.assetId).filter((v): v is string => !!v) } }).toArray(),
    ctx.employees.find({ _id: { $in: rows.map((r) => r.assignedToEmployeeId).filter((v): v is string => !!v) } }).toArray(),
  ])
  return new Map<string, string>([
    ...rooms.map((r) => [r._id, r.name] as [string, string]),
    ...assets.map((a) => [a._id, `${a.assetTag} · ${a.name}`] as [string, string]),
    ...employees.map((e) => [e._id, `${e.givenName} ${e.familyName}`] as [string, string]),
  ])
}

export function registerFacilityRoutes(app: FastifyInstance): void {
  // ---------------------------------------------------- buildings/rooms

  app.get('/ops/facilities', scoped('ops.read'), async (request, reply) => {
    const { branchId } = request.query as { branchId?: string }
    const branches = await branchFilter(request, branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const inBranch = branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}
    const { buildings, rooms } = await withTenant(request.auth!.tenantId!, async (ctx) => ({
      buildings: await ctx.buildings.find(inBranch).sort({ name: 1 }).toArray(),
      rooms: await ctx.rooms.find(inBranch).sort({ name: 1 }).toArray(),
    }))
    return reply.send({ buildings: buildings.map(buildingResponse), rooms: rooms.map(roomResponse) })
  })

  app.post('/ops/buildings', scoped('ops.facilities.manage'), async (request, reply) => {
    const parsed = buildingBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const result = await transact(tenantId, async (ctx) => {
      if (!(await ctx.branches.findOne({ _id: parsed.data.branchId }))) throw new Abort('NOT_FOUND')
      const now = new Date()
      const doc: BuildingDoc = { _id: randomUUID(), tenantId, ...parsed.data, active: true, createdAt: now, updatedAt: now }
      await ctx.buildings.insertOne(doc)
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'building.create', entity: 'building', entityId: doc._id, branchId: doc.branchId, after: doc })
      return doc
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(buildingResponse(result))
  })

  app.patch('/ops/buildings/:id', scoped('ops.facilities.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = buildingBody.omit({ branchId: true }).partial().extend({ active: z.boolean().optional() }).safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const access = await recordAccess(request, (ctx) => ctx.buildings.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const after = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const after = await ctx.buildings.findOneAndUpdate({ _id: id }, { $set: { ...parsed.data, updatedAt: new Date() } }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'building.update', entity: 'building', entityId: id, branchId: access.doc.branchId, before: access.doc, after })
      return after!
    })
    return reply.send(buildingResponse(after))
  })

  app.post('/ops/rooms', scoped('ops.facilities.manage'), async (request, reply) => {
    const parsed = roomBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const building = await recordAccess(request, (ctx) => ctx.buildings.findOne({ _id: parsed.data.buildingId }))
    if (!building.ok) return reply.code(building.status).send({ error: building.error === 'NOT_FOUND' ? 'UNKNOWN_BUILDING' : building.error })
    if (!(await checkCode(tenantId, 'roomType', parsed.data.typeCode))) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    const now = new Date()
    const doc: RoomDoc = { _id: randomUUID(), tenantId, branchId: building.doc.branchId, ...parsed.data, active: true, createdAt: now, updatedAt: now }
    await withTenant(tenantId, async (ctx) => {
      await ctx.rooms.insertOne(doc)
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'room.create', entity: 'room', entityId: doc._id, branchId: doc.branchId, after: doc })
    })
    return reply.code(201).send(roomResponse(doc))
  })

  app.patch('/ops/rooms/:id', scoped('ops.facilities.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = roomBody.omit({ buildingId: true }).partial().extend({ active: z.boolean().optional() }).safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await recordAccess(request, (ctx) => ctx.rooms.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    if (parsed.data.typeCode && !(await checkCode(tenantId, 'roomType', parsed.data.typeCode))) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    const after = await withTenant(tenantId, async (ctx) => {
      const after = await ctx.rooms.findOneAndUpdate({ _id: id }, { $set: { ...parsed.data, updatedAt: new Date() } }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'room.update', entity: 'room', entityId: id, branchId: access.doc.branchId, before: access.doc, after })
      return after!
    })
    return reply.send(roomResponse(after))
  })

  // --------------------------------------------------------- maintenance

  app.get('/ops/maintenance', scoped('ops.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<MaintenanceRequestDoc> = {}
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    if (parsed.data.status === 'active') filter.status = { $in: ['open', 'in_progress'] }
    else if (parsed.data.status) filter.status = parsed.data.status
    if (parsed.data.assetId) filter.assetId = parsed.data.assetId
    const { rows, names } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const rows = await ctx.maintenanceRequests.find(filter).sort({ createdAt: -1 }).limit(1000).toArray()
      return { rows, names: await namesFor(ctx, rows) }
    })
    return reply.send({ requests: rows.map((r) => maintenanceResponse(r, names)) })
  })

  // Reporting a problem is open to office staff; the rest is facilities'.
  app.post('/ops/maintenance', scoped('ops.maintenance.report'), async (request, reply) => {
    const parsed = requestBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const body = parsed.data
    if (!(await callerCanUseBranch(request, body.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const result = await transact(tenantId, async (ctx) => {
      let buildingId: string | null = null
      if (body.roomId) {
        const room = await ctx.rooms.findOne({ _id: body.roomId })
        if (!room || room.branchId !== body.branchId) throw new Abort('UNKNOWN_ROOM')
        buildingId = room.buildingId
      }
      if (body.assetId) {
        const asset = await ctx.assets.findOne({ _id: body.assetId })
        if (!asset || asset.branchId !== body.branchId || asset.status === 'disposed') throw new Abort('UNKNOWN_ASSET')
      }
      const now = new Date()
      const doc: MaintenanceRequestDoc = {
        _id: randomUUID(),
        tenantId,
        requestNumber: await nextNumber(ctx, tenantId, 'maintenanceNumber', 'MNT'),
        ...body,
        buildingId,
        status: 'open',
        assignedToEmployeeId: null,
        reportedBy: request.auth!.sub,
        resolution: null,
        cost: null,
        resolvedAt: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      await ctx.maintenanceRequests.insertOne(doc)
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'maintenance.report', entity: 'maintenance', entityId: doc._id, branchId: doc.branchId, after: doc })
      return doc
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(maintenanceResponse(result))
  })

  app.patch('/ops/maintenance/:id', scoped('ops.maintenance.report'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateBody.safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await recordAccess(request, (ctx) => ctx.maintenanceRequests.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    // The reporter may only cancel their own open request.
    const manager = await callerHasPermission(request, 'ops.facilities.manage')
    const ownCancel =
      access.doc.reportedBy === request.auth!.sub && access.doc.status === 'open' && parsed.data.status === 'cancelled' && Object.keys(parsed.data).length === 1
    if (!manager && !ownCancel) return reply.code(403).send({ error: 'FORBIDDEN' })
    const actorId = request.auth!.sub
    const result = await transact(tenantId, async (ctx) => {
      const before = await ctx.maintenanceRequests.findOne({ _id: id })
      if (!before) throw new Abort('NOT_FOUND')
      const patch: Partial<MaintenanceRequestDoc> = { updatedAt: new Date() }
      const to = parsed.data.status
      if (to && to !== before.status) {
        if (!NEXT[before.status].includes(to)) throw new Abort('WRONG_STATUS', { from: before.status, to })
        if (to === 'resolved' && !(parsed.data.resolution ?? before.resolution)) throw new Abort('RESOLUTION_REQUIRED')
        patch.status = to
        if (to === 'resolved') patch.resolvedAt = new Date()
        if (to === 'closed') patch.closedAt = new Date()
      }
      if (parsed.data.assignedToEmployeeId !== undefined) {
        if (parsed.data.assignedToEmployeeId) {
          const e = await ctx.employees.findOne({ _id: parsed.data.assignedToEmployeeId })
          if (!e || e.status !== 'active') throw new Abort('UNKNOWN_EMPLOYEE')
        }
        patch.assignedToEmployeeId = parsed.data.assignedToEmployeeId
      }
      if (parsed.data.priority) patch.priority = parsed.data.priority
      if (parsed.data.resolution !== undefined) patch.resolution = parsed.data.resolution
      if (parsed.data.cost !== undefined) patch.cost = parsed.data.cost
      const after = (await ctx.maintenanceRequests.findOneAndUpdate({ _id: id }, { $set: patch }, { returnDocument: 'after' }))!

      // The asset follows the work.
      if (after.assetId && patch.status) {
        const asset = await ctx.assets.findOne({ _id: after.assetId })
        if (asset && asset.status !== 'disposed') {
          if (patch.status === 'in_progress' && asset.status !== 'maintenance') {
            await assetEvent(ctx, tenantId, { assetId: asset._id, branchId: asset.branchId, type: 'maintenance_start', date: todayIso(), note: after.requestNumber, actorId })
            await ctx.assets.findOneAndUpdate({ _id: asset._id }, { $set: { status: 'maintenance', updatedAt: new Date() } })
          }
          if ((patch.status === 'resolved' || patch.status === 'cancelled') && asset.status === 'maintenance') {
            await assetEvent(ctx, tenantId, {
              assetId: asset._id,
              branchId: asset.branchId,
              type: 'maintenance_end',
              date: todayIso(),
              note: `${after.requestNumber}${after.resolution ? `: ${after.resolution}` : ''}`,
              cost: after.cost,
              actorId,
            })
            await ctx.assets.findOneAndUpdate({ _id: asset._id }, { $set: { status: asset.assignedTo ? 'assigned' : 'in_stock', updatedAt: new Date() } })
          }
        }
      }
      await recordAudit(ctx.auditLog, { actorId, action: 'maintenance.update', entity: 'maintenance', entityId: id, branchId: after.branchId, before, after })
      return after
    })
    if (isFailure(result)) return sendFailure(reply, result)
    const names = await withTenant(tenantId, (ctx) => namesFor(ctx, [result]))
    return reply.send(maintenanceResponse(result, names))
  })
}
