import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { BusDoc, StopDoc, TenantContext } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerCanUseBranch,
  requireActiveSubscription,
  requirePermission,
} from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { effectiveTransportSettings } from './settings.js'

/**
 * Buses, stops, and per-branch routing settings for the bus-routes module —
 * see db.ts's transport section for why this replaces the old
 * `/datasets/:key` blob sync. The client-side VRP solver (unchanged) reads
 * these through a `FleetProblem`-shaped adapter assembled from this API's
 * responses; nothing here computes or stores a solved route.
 */

const busBody = z.object({
  branchId: z.string().min(1),
  name: z.string().min(1).max(100),
  seats: z.number().int().min(1).max(120),
})
const updateBusBody = z.object({
  name: z.string().min(1).max(100).optional(),
  seats: z.number().int().min(1).max(120).optional(),
})

const stopBody = z.object({
  branchId: z.string().min(1),
  name: z.string().min(1).max(150),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  pinnedBusId: z.string().min(1).nullable().default(null),
})
const updateStopBody = z.object({
  name: z.string().min(1).max(150).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  pinnedBusId: z.string().min(1).nullable().optional(),
})

const listQuery = z.object({
  branchId: z.string().optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
})

const settingsBody = z.object({
  depotName: z.string().max(200).default(''),
  depotLat: z.number().min(-90).max(90).default(0),
  depotLng: z.number().min(-180).max(180).default(0),
  roadFactor: z.number().min(1).max(3),
  averageSpeedKph: z.number().min(1).max(150),
  dwellMinutes: z.number().min(0).max(30),
  maxRideMinutes: z.number().min(1).max(240),
  earliestDeparture: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'HH:MM[:SS]'),
  bellTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'HH:MM[:SS]'),
  arrivalBufferMinutes: z.number().int().min(0).max(120),
  osrmUrl: z.string().max(500).default(''),
  outlierThresholdMeters: z.number().min(0).max(10000),
  doorToDoorEnabled: z.boolean(),
})

const ERROR_STATUS: Record<string, number> = {
  UNKNOWN_BRANCH: 404,
  UNKNOWN_BUS: 404,
  BUS_BRANCH_MISMATCH: 409,
}

function busResponse(doc: BusDoc) {
  return {
    id: doc._id,
    branchId: doc.branchId,
    name: doc.name,
    seats: doc.seats,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

function stopResponse(doc: StopDoc) {
  return {
    id: doc._id,
    branchId: doc.branchId,
    name: doc.name,
    lat: doc.lat,
    lng: doc.lng,
    pinnedBusId: doc.pinnedBusId,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

export function registerTransportRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('transport.read')] }
  const writeGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('transport.write')] }
  const manageGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('transport.manage')] }

  // ------------------------------------------------------------------ buses

  app.get('/transport/buses', readGuard, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const allowed = await callerBranchIds(request)
    if (parsed.data.branchId && allowed !== null && !allowed.includes(parsed.data.branchId)) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const filter: Filter<BusDoc> = {}
    if (parsed.data.branchId) filter.branchId = parsed.data.branchId
    else if (allowed !== null) filter.branchId = { $in: allowed }
    if (parsed.data.includeInactive !== 'true') filter.active = true

    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.buses.find(filter).sort({ name: 1 }).toArray(),
    )
    return reply.send({ buses: rows.map(busResponse) })
  })

  app.post('/transport/buses', writeGuard, async (request, reply) => {
    const parsed = busBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const tenantId = request.auth!.tenantId!
    const now = new Date()
    const doc: BusDoc = {
      _id: randomUUID(),
      tenantId,
      branchId: parsed.data.branchId,
      name: parsed.data.name,
      seats: parsed.data.seats,
      active: true,
      createdAt: now,
      updatedAt: now,
      createdBy: request.auth!.sub,
    }
    // `callerCanUseBranch` only checks the CALLER's own branch restriction
    // (null/unrestricted for an owner or admin) — it never confirms
    // `branchId` actually resolves to a real branch in the caller's own
    // tenant. `ctx.branches` is tenant-scoped, so this find only succeeds
    // for a branch that's really theirs — same pattern as
    // classes/routes.ts's create handler.
    const branchOk = await withTenant(tenantId, async (ctx) => {
      const branch = await ctx.branches.findOne({ _id: doc.branchId })
      if (!branch) return false
      await ctx.buses.insertOne(doc)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'bus.create',
        entity: 'bus',
        entityId: doc._id,
        branchId: doc.branchId,
        before: null,
        after: doc,
      })
      return true
    })
    if (!branchOk) return reply.code(404).send({ error: 'UNKNOWN_BRANCH' })
    return reply.code(201).send(busResponse(doc))
  })

  // A branch check that runs AFTER the write commits only gates the HTTP
  // response, not the mutation — `withTenant` commits its transaction as
  // soon as the callback resolves. Every bus/stop mutation below resolves
  // the target's branchId in its own read, before the write transaction
  // starts, same shape as finance/routes.ts's `requireFeeStructureBranchAccess`.
  async function requireBusBranchAccess(
    request: Parameters<typeof callerCanUseBranch>[0],
    id: string,
    tenantId: string,
  ) {
    const doc = await withTenant(tenantId, (ctx) => ctx.buses.findOne({ _id: id }))
    if (!doc) return { ok: false as const, status: 404, error: 'NOT_FOUND' }
    if (!(await callerCanUseBranch(request, doc.branchId))) {
      return { ok: false as const, status: 403, error: 'BRANCH_FORBIDDEN' }
    }
    return { ok: true as const, doc }
  }

  app.patch('/transport/buses/:id', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateBusBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })

    const tenantId = request.auth!.tenantId!
    const access = await requireBusBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.buses.findOne({ _id: id })
      if (!before) return null
      const updated = await ctx.buses.findOneAndUpdate(
        { _id: id },
        { $set: { ...parsed.data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'bus.update',
        entity: 'bus',
        entityId: id,
        branchId: before.branchId,
        before,
        after: updated,
      })
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(busResponse(result))
  })

  app.post('/transport/buses/:id/deactivate', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const access = await requireBusBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.buses.findOne({ _id: id })
      if (!before) return null
      const updated = await ctx.buses.findOneAndUpdate(
        { _id: id },
        { $set: { active: false, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      // A stop pinned to the bus being removed would otherwise point at a
      // bus that no longer exists — fall back to auto-assign, same
      // reasoning as the client-side behavior this replaces
      // (RoutesPage.tsx's removeBus).
      await ctx.stops.updateMany({ pinnedBusId: id }, { $set: { pinnedBusId: null, updatedAt: new Date() } })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'bus.deactivate',
        entity: 'bus',
        entityId: id,
        branchId: before.branchId,
        before,
        after: updated,
      })
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(busResponse(result))
  })

  // ------------------------------------------------------------------ stops

  /** Resolves and validates a `pinnedBusId` inside the same write
   * transaction as the stop write it belongs to — must be a real, active
   * bus in the SAME branch as the stop, never trusted from the request
   * body alone (see db.ts's `StopDoc.pinnedBusId` comment for why this one
   * cross-reference is validated where most in this codebase aren't). */
  async function resolvePinnedBus(
    ctx: TenantContext,
    branchId: string,
    pinnedBusId: string | null,
  ): Promise<{ ok: true } | { ok: false; error: 'UNKNOWN_BUS' | 'BUS_BRANCH_MISMATCH' }> {
    if (!pinnedBusId) return { ok: true }
    const bus = await ctx.buses.findOne({ _id: pinnedBusId })
    if (!bus || !bus.active) return { ok: false, error: 'UNKNOWN_BUS' }
    if (bus.branchId !== branchId) return { ok: false, error: 'BUS_BRANCH_MISMATCH' }
    return { ok: true }
  }

  app.get('/transport/stops', readGuard, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const allowed = await callerBranchIds(request)
    if (parsed.data.branchId && allowed !== null && !allowed.includes(parsed.data.branchId)) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const filter: Filter<StopDoc> = {}
    if (parsed.data.branchId) filter.branchId = parsed.data.branchId
    else if (allowed !== null) filter.branchId = { $in: allowed }
    if (parsed.data.includeInactive !== 'true') filter.active = true

    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.stops.find(filter).sort({ name: 1 }).toArray(),
    )
    return reply.send({ stops: rows.map(stopResponse) })
  })

  app.post('/transport/stops', writeGuard, async (request, reply) => {
    const parsed = stopBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const tenantId = request.auth!.tenantId!
    const now = new Date()
    type CreateStopResult =
      | { error: 'UNKNOWN_BRANCH' | 'UNKNOWN_BUS' | 'BUS_BRANCH_MISMATCH' }
      | { doc: StopDoc }
    const result = await withTenant(tenantId, async (ctx): Promise<CreateStopResult> => {
      // Same reasoning as the bus create route above: confirm `branchId`
      // resolves to a real branch in the caller's own tenant, not just that
      // the caller isn't restricted away from it.
      const branch = await ctx.branches.findOne({ _id: parsed.data.branchId })
      if (!branch) return { error: 'UNKNOWN_BRANCH' }
      const pin = await resolvePinnedBus(ctx, parsed.data.branchId, parsed.data.pinnedBusId)
      if (!pin.ok) return { error: pin.error }
      const doc: StopDoc = {
        _id: randomUUID(),
        tenantId,
        branchId: parsed.data.branchId,
        name: parsed.data.name,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        pinnedBusId: parsed.data.pinnedBusId,
        active: true,
        createdAt: now,
        updatedAt: now,
        createdBy: request.auth!.sub,
      }
      await ctx.stops.insertOne(doc)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'stop.create',
        entity: 'stop',
        entityId: doc._id,
        branchId: doc.branchId,
        before: null,
        after: doc,
      })
      return { doc }
    })
    if ('error' in result) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.code(201).send(stopResponse(result.doc))
  })

  async function requireStopBranchAccess(
    request: Parameters<typeof callerCanUseBranch>[0],
    id: string,
    tenantId: string,
  ) {
    const doc = await withTenant(tenantId, (ctx) => ctx.stops.findOne({ _id: id }))
    if (!doc) return { ok: false as const, status: 404, error: 'NOT_FOUND' }
    if (!(await callerCanUseBranch(request, doc.branchId))) {
      return { ok: false as const, status: 403, error: 'BRANCH_FORBIDDEN' }
    }
    return { ok: true as const, doc }
  }

  app.patch('/transport/stops/:id', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateStopBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })

    const tenantId = request.auth!.tenantId!
    const access = await requireStopBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    type UpdateStopResult =
      | { error: 'NOT_FOUND' | 'UNKNOWN_BUS' | 'BUS_BRANCH_MISMATCH' }
      | { doc: StopDoc }
    const result = await withTenant(tenantId, async (ctx): Promise<UpdateStopResult> => {
      const before = await ctx.stops.findOne({ _id: id })
      if (!before) return { error: 'NOT_FOUND' }
      if (parsed.data.pinnedBusId !== undefined) {
        const pin = await resolvePinnedBus(ctx, before.branchId, parsed.data.pinnedBusId)
        if (!pin.ok) return { error: pin.error }
      }
      const updated = await ctx.stops.findOneAndUpdate(
        { _id: id },
        { $set: { ...parsed.data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'stop.update',
        entity: 'stop',
        entityId: id,
        branchId: before.branchId,
        before,
        after: updated,
      })
      return { doc: updated! }
    })
    if ('error' in result) return reply.code(ERROR_STATUS[result.error] ?? 404).send({ error: result.error })
    return reply.send(stopResponse(result.doc))
  })

  app.post('/transport/stops/:id/deactivate', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const access = await requireStopBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.stops.findOne({ _id: id })
      if (!before) return null
      const updated = await ctx.stops.findOneAndUpdate(
        { _id: id },
        { $set: { active: false, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      // A student still pointed at this stop would otherwise silently break
      // that student's routing computation — clear back to unassigned
      // rather than leave a stale reference, same reasoning as unpinning a
      // deactivated bus above.
      await ctx.students.updateMany(
        { stopId: id },
        { $set: { stopId: '', updatedAt: new Date() } },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'stop.deactivate',
        entity: 'stop',
        entityId: id,
        branchId: before.branchId,
        before,
        after: updated,
      })
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(stopResponse(result))
  })

  // -------------------------------------------------------------- settings

  app.get('/branches/:branchId/transport-settings', readGuard, async (request, reply) => {
    const { branchId } = request.params as { branchId: string }
    if (!(await callerCanUseBranch(request, branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    const tenantId = request.auth!.tenantId!
    const { branch, doc } = await withTenant(tenantId, async (ctx) => {
      const branch = await ctx.branches.findOne({ _id: branchId })
      const doc = await ctx.transportSettings.findOne({ _id: `${tenantId}:${branchId}` })
      return { branch, doc }
    })
    if (!branch) return reply.code(404).send({ error: 'UNKNOWN_BRANCH' })
    return reply.send(effectiveTransportSettings(doc))
  })

  app.put('/branches/:branchId/transport-settings', manageGuard, async (request, reply) => {
    const { branchId } = request.params as { branchId: string }
    const parsed = settingsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, async (ctx) => {
      const branch = await ctx.branches.findOne({ _id: branchId })
      if (!branch) return null
      const before = await ctx.transportSettings.findOne({ _id: `${tenantId}:${branchId}` })
      const after = await ctx.transportSettings.findOneAndUpdate(
        { _id: `${tenantId}:${branchId}` },
        { $set: { branchId, ...parsed.data, updatedAt: new Date() } },
        { upsert: true, returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'transportSettings.update',
        entity: 'transportSettings',
        entityId: `${tenantId}:${branchId}`,
        branchId,
        before,
        after,
      })
      return true
    })
    if (!result) return reply.code(404).send({ error: 'UNKNOWN_BRANCH' })
    return reply.send({ ok: true })
  })
}
