import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { AssetDoc, TenantContext } from '../db.js'
import { callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { readReason, setAuditReason } from '../requestContext.js'
import { Abort, branchFilter, isFailure, scoped, sendFailure, todayIso, transact } from '../records.js'
import { assetEvent, checkCode, escapeRegex, recordAccess } from './common.js'
import { nextNumber } from '../numbering.js'

/**
 * SAMS 5.1: assets and their lifecycle — purchase → assignment (to an
 * employee or a room) → maintenance → transfer → disposal. Each step is
 * an asset event, so the history is never overwritten. A disposed asset
 * is kept, read-only.
 */

const date = z.string().date()
const assetBody = z.object({
  name: z.string().trim().min(1).max(200),
  categoryCode: z.string().min(1).max(64),
  branchId: z.string().min(1),
  roomId: z.string().min(1).nullable().default(null),
  serialNumber: z.string().trim().max(100).nullable().default(null),
  vendorId: z.string().min(1).nullable().default(null),
  purchaseDate: date.nullable().default(null),
  purchaseCost: z.number().int().min(0).nullable().default(null),
  warrantyUntil: date.nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
})
const patchBody = assetBody.omit({ branchId: true }).partial().strict()
const listQuery = z.object({
  branchId: z.string().optional(),
  status: z.enum(['in_stock', 'assigned', 'maintenance', 'disposed']).optional(),
  categoryCode: z.string().optional(),
  assignedTo: z.string().optional(),
  q: z.string().trim().max(100).optional(),
})

export function assetResponse(a: AssetDoc, names?: Map<string, string>) {
  return {
    id: a._id,
    assetTag: a.assetTag,
    name: a.name,
    categoryCode: a.categoryCode,
    branchId: a.branchId,
    roomId: a.roomId,
    roomName: a.roomId ? (names?.get(a.roomId) ?? null) : null,
    serialNumber: a.serialNumber,
    vendorId: a.vendorId,
    purchaseDate: a.purchaseDate,
    purchaseCost: a.purchaseCost,
    warrantyUntil: a.warrantyUntil,
    status: a.status,
    assignedTo: a.assignedTo,
    assignedToName: a.assignedTo ? (names?.get(a.assignedTo.id) ?? null) : null,
    notes: a.notes,
    disposedAt: a.disposedAt,
    disposalReason: a.disposalReason,
    createdAt: a.createdAt.toISOString(),
  }
}

/** Display names for rooms and employees the assets point at. */
async function namesFor(ctx: TenantContext, assets: AssetDoc[]): Promise<Map<string, string>> {
  const roomIds = new Set<string>()
  const employeeIds = new Set<string>()
  for (const a of assets) {
    if (a.roomId) roomIds.add(a.roomId)
    if (a.assignedTo?.type === 'room') roomIds.add(a.assignedTo.id)
    if (a.assignedTo?.type === 'employee') employeeIds.add(a.assignedTo.id)
  }
  const [rooms, employees] = await Promise.all([
    ctx.rooms.find({ _id: { $in: [...roomIds] } }).toArray(),
    ctx.employees.find({ _id: { $in: [...employeeIds] } }).toArray(),
  ])
  return new Map([
    ...rooms.map((r) => [r._id, r.name] as [string, string]),
    ...employees.map((e) => [e._id, `${e.givenName} ${e.familyName}`] as [string, string]),
  ])
}

/** A room must be in the asset's branch. */
async function checkRoom(ctx: TenantContext, roomId: string | null | undefined, branchId: string) {
  if (!roomId) return
  const room = await ctx.rooms.findOne({ _id: roomId })
  if (!room || room.branchId !== branchId) throw new Abort('UNKNOWN_ROOM')
}

export function registerAssetRoutes(app: FastifyInstance): void {
  app.get('/ops/assets', scoped('ops.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<AssetDoc> = {}
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    if (parsed.data.status) filter.status = parsed.data.status
    else filter.status = { $ne: 'disposed' }
    if (parsed.data.categoryCode) filter.categoryCode = parsed.data.categoryCode
    if (parsed.data.assignedTo) filter['assignedTo.id'] = parsed.data.assignedTo
    if (parsed.data.q) {
      const re = new RegExp(escapeRegex(parsed.data.q), 'i')
      filter.$or = [{ name: re }, { assetTag: re }, { serialNumber: re }]
    }
    const { rows, names } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const rows = await ctx.assets.find(filter).sort({ assetTag: 1 }).limit(2000).toArray()
      return { rows, names: await namesFor(ctx, rows) }
    })
    return reply.send({ assets: rows.map((a) => assetResponse(a, names)) })
  })

  app.get('/ops/assets/:id', scoped('ops.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const access = await recordAccess(request, (ctx) => ctx.assets.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const { names, events } = await withTenant(request.auth!.tenantId!, async (ctx) => ({
      names: await namesFor(ctx, [access.doc]),
      events: await ctx.assetEvents.find({ assetId: id }).sort({ date: -1, createdAt: -1 }).toArray(),
    }))
    return reply.send({
      ...assetResponse(access.doc, names),
      history: events.map((e) => ({ id: e._id, type: e.type, date: e.date, from: e.from, to: e.to, note: e.note, cost: e.cost })),
    })
  })

  app.post('/ops/assets', scoped('ops.assets.manage'), async (request, reply) => {
    const parsed = assetBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const body = parsed.data
    if (!(await callerCanUseBranch(request, body.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    if (!(await checkCode(tenantId, 'assetCategory', body.categoryCode))) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    const actorId = request.auth!.sub
    const result = await transact(tenantId, async (ctx) => {
      if (!(await ctx.branches.findOne({ _id: body.branchId }))) throw new Abort('NOT_FOUND')
      await checkRoom(ctx, body.roomId, body.branchId)
      if (body.vendorId && !(await ctx.vendors.findOne({ _id: body.vendorId }))) throw new Abort('UNKNOWN_VENDOR')
      const now = new Date()
      const doc: AssetDoc = {
        _id: randomUUID(),
        tenantId,
        assetTag: await nextNumber(ctx, tenantId, 'assetTag'),
        ...body,
        status: 'in_stock',
        assignedTo: null,
        disposedAt: null,
        disposalReason: null,
        createdAt: now,
        updatedAt: now,
        createdBy: actorId,
      }
      await ctx.assets.insertOne(doc)
      await assetEvent(ctx, tenantId, {
        assetId: doc._id,
        branchId: doc.branchId,
        type: 'purchase',
        date: doc.purchaseDate ?? todayIso(),
        cost: doc.purchaseCost,
        actorId,
      })
      await recordAudit(ctx.auditLog, { actorId, action: 'asset.create', entity: 'asset', entityId: doc._id, branchId: doc.branchId, after: doc })
      return doc
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(assetResponse(result))
  })

  app.patch('/ops/assets/:id', scoped('ops.assets.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = patchBody.safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await recordAccess(request, (ctx) => ctx.assets.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    if (parsed.data.categoryCode && !(await checkCode(tenantId, 'assetCategory', parsed.data.categoryCode))) {
      return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    }
    const result = await transact(tenantId, async (ctx) => {
      if (access.doc.status === 'disposed') throw new Abort('DISPOSED')
      await checkRoom(ctx, parsed.data.roomId, access.doc.branchId)
      const after = await ctx.assets.findOneAndUpdate({ _id: id }, { $set: { ...parsed.data, updatedAt: new Date() } }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'asset.update', entity: 'asset', entityId: id, branchId: access.doc.branchId, before: access.doc, after })
      return after!
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(assetResponse(result))
  })

  // --------------------------------------------------------- lifecycle

  const step = (
    path: string,
    body: z.ZodTypeAny,
    run: (ctx: TenantContext, tenantId: string, asset: AssetDoc, data: never, actorId: string) => Promise<AssetDoc>,
  ) =>
    app.post(`/ops/assets/:id/${path}`, scoped('ops.assets.manage'), async (request, reply) => {
      const { id } = request.params as { id: string }
      const parsed = body.safeParse(request.body ?? {})
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
      const access = await recordAccess(request, (ctx) => ctx.assets.findOne({ _id: id }))
      if (!access.ok) return reply.code(access.status).send({ error: access.error })
      const tenantId = request.auth!.tenantId!
      if (path === 'transfer' && !(await callerCanUseBranch(request, (parsed.data as { branchId: string }).branchId))) {
        return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
      }
      if (path === 'dispose') {
        const reason = readReason(request.body)
        if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' })
        setAuditReason(reason)
      }
      const result = await transact(tenantId, async (ctx) => {
        const asset = await ctx.assets.findOne({ _id: id })
        if (!asset) throw new Abort('NOT_FOUND')
        if (asset.status === 'disposed') throw new Abort('DISPOSED')
        const after = await run(ctx, tenantId, asset, parsed.data as never, request.auth!.sub)
        await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: `asset.${path}`, entity: 'asset', entityId: id, branchId: after.branchId, before: asset, after })
        return after
      })
      if (isFailure(result)) return sendFailure(reply, result)
      return reply.send(assetResponse(result))
    })

  const set = async (ctx: TenantContext, id: string, patch: Partial<AssetDoc>) =>
    (await ctx.assets.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' }))!

  step(
    'assign',
    z.object({ type: z.enum(['employee', 'room']), id: z.string().min(1), date: date.optional() }),
    async (ctx, tenantId, asset, data: { type: 'employee' | 'room'; id: string; date?: string }, actorId) => {
      if (asset.status !== 'in_stock') throw new Abort('NOT_IN_STOCK')
      if (data.type === 'employee') {
        const e = await ctx.employees.findOne({ _id: data.id })
        if (!e || e.status !== 'active') throw new Abort('UNKNOWN_EMPLOYEE')
      } else await checkRoom(ctx, data.id, asset.branchId)
      await assetEvent(ctx, tenantId, { assetId: asset._id, branchId: asset.branchId, type: 'assign', date: data.date ?? todayIso(), to: `${data.type}:${data.id}`, actorId })
      return set(ctx, asset._id, { status: 'assigned', assignedTo: { type: data.type, id: data.id } })
    },
  )

  step('return', z.object({ date: date.optional(), note: z.string().trim().max(500).optional() }), async (ctx, tenantId, asset, data: { date?: string; note?: string }, actorId) => {
    if (asset.status !== 'assigned') throw new Abort('NOT_ASSIGNED')
    await assetEvent(ctx, tenantId, {
      assetId: asset._id,
      branchId: asset.branchId,
      type: 'return',
      date: data.date ?? todayIso(),
      from: asset.assignedTo ? `${asset.assignedTo.type}:${asset.assignedTo.id}` : null,
      note: data.note,
      actorId,
    })
    return set(ctx, asset._id, { status: 'in_stock', assignedTo: null })
  })

  step(
    'maintenance',
    z.object({ action: z.enum(['start', 'end']), note: z.string().trim().max(500).optional(), cost: z.number().int().min(0).optional(), date: date.optional() }),
    async (ctx, tenantId, asset, data: { action: 'start' | 'end'; note?: string; cost?: number; date?: string }, actorId) => {
      if (data.action === 'start') {
        if (asset.status === 'maintenance') throw new Abort('ALREADY_IN_MAINTENANCE')
        await assetEvent(ctx, tenantId, { assetId: asset._id, branchId: asset.branchId, type: 'maintenance_start', date: data.date ?? todayIso(), note: data.note, actorId })
        return set(ctx, asset._id, { status: 'maintenance' })
      }
      if (asset.status !== 'maintenance') throw new Abort('NOT_IN_MAINTENANCE')
      await assetEvent(ctx, tenantId, { assetId: asset._id, branchId: asset.branchId, type: 'maintenance_end', date: data.date ?? todayIso(), note: data.note, cost: data.cost ?? null, actorId })
      // Back to whoever had it, or the store.
      return set(ctx, asset._id, { status: asset.assignedTo ? 'assigned' : 'in_stock' })
    },
  )

  step(
    'transfer',
    z.object({ branchId: z.string().min(1), roomId: z.string().min(1).nullable().default(null), date: date.optional() }),
    async (ctx, tenantId, asset, data: { branchId: string; roomId: string | null; date?: string }, actorId) => {
      if (asset.status === 'assigned') throw new Abort('RETURN_FIRST')
      if (data.branchId === asset.branchId && data.roomId === asset.roomId) throw new Abort('NO_CHANGE')
      if (!(await ctx.branches.findOne({ _id: data.branchId }))) throw new Abort('NOT_FOUND')
      await checkRoom(ctx, data.roomId, data.branchId)
      await assetEvent(ctx, tenantId, {
        assetId: asset._id,
        branchId: data.branchId,
        type: 'transfer',
        date: data.date ?? todayIso(),
        from: `${asset.branchId}${asset.roomId ? `/${asset.roomId}` : ''}`,
        to: `${data.branchId}${data.roomId ? `/${data.roomId}` : ''}`,
        actorId,
      })
      return set(ctx, asset._id, { branchId: data.branchId, roomId: data.roomId })
    },
  )

  // The reason is checked (and audited) by `step` before this runs.
  step('dispose', z.object({ reason: z.string().optional(), date: date.optional() }), async (ctx, tenantId, asset, data: { reason: string; date?: string }, actorId) => {
    const when = data.date ?? todayIso()
    const reason = data.reason.trim()
    await assetEvent(ctx, tenantId, { assetId: asset._id, branchId: asset.branchId, type: 'dispose', date: when, note: reason, actorId })
    return set(ctx, asset._id, { status: 'disposed', assignedTo: null, disposedAt: when, disposalReason: reason })
  })
}
