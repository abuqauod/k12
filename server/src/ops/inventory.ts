import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { InventoryItemDoc, StockMovementDoc, StockMovementType, TenantContext, VendorDoc } from '../db.js'
import { callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { Abort, branchFilter, isFailure, scoped, sendFailure, transact } from '../records.js'
import { checkCode, escapeRegex, recordAccess } from './common.js'

/**
 * SAMS 5.2: consumable stock per branch. An item's quantity only changes
 * through a movement (receive, issue, adjust, transfer), written in the
 * same transaction, so the quantity always equals the sum of its
 * movements and never goes below zero. A transfer is two movements: out of
 * this branch's line, into the other branch's line for the same SKU
 * (created if the branch hasn't stocked it yet).
 *
 * Suppliers are the finance vendors (3.5); operations staff read and add
 * them here without needing finance access.
 */

const itemBody = z.object({
  branchId: z.string().min(1),
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(20).default('pcs'),
  categoryCode: z.string().min(1).max(64),
  reorderLevel: z.number().int().min(0).default(0),
})
const itemPatch = z
  .object({
    name: z.string().trim().min(1).max(200),
    unit: z.string().trim().min(1).max(20),
    categoryCode: z.string().min(1).max(64),
    reorderLevel: z.number().int().min(0),
    active: z.boolean(),
  })
  .partial()
const movementBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('receive'),
    quantity: z.number().int().min(1),
    supplierId: z.string().min(1).nullable().default(null),
    unitCost: z.number().int().min(0).nullable().default(null),
    reference: z.string().trim().max(100).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
  }),
  z.object({
    type: z.literal('issue'),
    quantity: z.number().int().min(1),
    issuedTo: z.string().trim().min(1).max(200),
    note: z.string().trim().max(500).nullable().default(null),
  }),
  z.object({
    type: z.literal('adjust'),
    /** Signed: a count found more or fewer than recorded. */
    quantity: z.number().int().refine((q) => q !== 0),
    note: z.string().trim().min(3).max(500),
  }),
  z.object({
    type: z.literal('transfer'),
    quantity: z.number().int().min(1),
    toBranchId: z.string().min(1),
    note: z.string().trim().max(500).nullable().default(null),
  }),
])
const listQuery = z.object({
  branchId: z.string().optional(),
  categoryCode: z.string().optional(),
  lowStock: z.enum(['true']).optional(),
  q: z.string().trim().max(100).optional(),
  includeInactive: z.enum(['true']).optional(),
})
const supplierBody = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(200).nullable().default(null),
  phone: z.string().trim().max(40).nullable().default(null),
  email: z.string().trim().email().max(200).nullable().default(null),
})

export const itemResponse = (i: InventoryItemDoc) => ({
  id: i._id,
  branchId: i.branchId,
  sku: i.sku,
  name: i.name,
  unit: i.unit,
  categoryCode: i.categoryCode,
  reorderLevel: i.reorderLevel,
  quantity: i.quantity,
  lowStock: i.active && i.quantity <= i.reorderLevel,
  active: i.active,
})

const movementResponse = (m: StockMovementDoc, suppliers?: Map<string, string>) => ({
  id: m._id,
  type: m.type,
  quantity: m.quantity,
  balance: m.balance,
  supplierId: m.supplierId,
  supplierName: m.supplierId ? (suppliers?.get(m.supplierId) ?? null) : null,
  unitCost: m.unitCost,
  reference: m.reference,
  issuedTo: m.issuedTo,
  note: m.note,
  createdAt: m.createdAt.toISOString(),
})

/** Applies a signed change to an item and records it. Never below zero. */
async function move(
  ctx: TenantContext,
  tenantId: string,
  item: InventoryItemDoc,
  type: StockMovementType,
  delta: number,
  extra: Partial<Pick<StockMovementDoc, 'supplierId' | 'unitCost' | 'reference' | 'issuedTo' | 'note' | 'relatedMovementId'>>,
  actorId: string,
): Promise<StockMovementDoc> {
  const updated = await ctx.inventoryItems.findOneAndUpdate(
    { _id: item._id, ...(delta < 0 ? { quantity: { $gte: -delta } } : {}) },
    { $inc: { quantity: delta }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' },
  )
  if (!updated) throw new Abort('INSUFFICIENT_STOCK', { available: item.quantity })
  const doc: StockMovementDoc = {
    _id: randomUUID(),
    tenantId,
    itemId: item._id,
    branchId: item.branchId,
    type,
    quantity: delta,
    balance: updated.quantity,
    supplierId: extra.supplierId ?? null,
    unitCost: extra.unitCost ?? null,
    reference: extra.reference ?? null,
    issuedTo: extra.issuedTo ?? null,
    note: extra.note ?? null,
    relatedMovementId: extra.relatedMovementId ?? null,
    actorId,
    createdAt: new Date(),
  }
  await ctx.stockMovements.insertOne(doc)
  return doc
}

export function registerInventoryRoutes(app: FastifyInstance): void {
  app.get('/ops/inventory/items', scoped('ops.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<InventoryItemDoc> = {}
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    if (parsed.data.categoryCode) filter.categoryCode = parsed.data.categoryCode
    if (!parsed.data.includeInactive) filter.active = true
    if (parsed.data.q) {
      const re = new RegExp(escapeRegex(parsed.data.q), 'i')
      filter.$or = [{ name: re }, { sku: re }]
    }
    let rows = await withTenant(request.auth!.tenantId!, (ctx) => ctx.inventoryItems.find(filter).sort({ name: 1 }).limit(2000).toArray())
    if (parsed.data.lowStock) rows = rows.filter((i) => i.quantity <= i.reorderLevel)
    return reply.send({ items: rows.map(itemResponse) })
  })

  app.post('/ops/inventory/items', scoped('ops.inventory.manage'), async (request, reply) => {
    const parsed = itemBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    if (!(await checkCode(tenantId, 'inventoryCategory', parsed.data.categoryCode))) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    const result = await transact(
      tenantId,
      async (ctx) => {
        if (!(await ctx.branches.findOne({ _id: parsed.data.branchId }))) throw new Abort('NOT_FOUND')
        const now = new Date()
        const doc: InventoryItemDoc = { _id: randomUUID(), tenantId, ...parsed.data, quantity: 0, active: true, createdAt: now, updatedAt: now }
        await ctx.inventoryItems.insertOne(doc)
        await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'inventory.item.create', entity: 'inventoryItem', entityId: doc._id, branchId: doc.branchId, after: doc })
        return doc
      },
      'SKU_TAKEN',
    )
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(itemResponse(result))
  })

  app.patch('/ops/inventory/items/:id', scoped('ops.inventory.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = itemPatch.safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await recordAccess(request, (ctx) => ctx.inventoryItems.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    if (parsed.data.categoryCode && !(await checkCode(tenantId, 'inventoryCategory', parsed.data.categoryCode))) {
      return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    }
    const after = await withTenant(tenantId, async (ctx) => {
      const after = await ctx.inventoryItems.findOneAndUpdate({ _id: id }, { $set: { ...parsed.data, updatedAt: new Date() } }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'inventory.item.update', entity: 'inventoryItem', entityId: id, branchId: access.doc.branchId, before: access.doc, after })
      return after!
    })
    return reply.send(itemResponse(after))
  })

  app.get('/ops/inventory/items/:id/movements', scoped('ops.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const access = await recordAccess(request, (ctx) => ctx.inventoryItems.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const { rows, suppliers } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const rows = await ctx.stockMovements.find({ itemId: id }).sort({ createdAt: -1 }).limit(500).toArray()
      const vendors = await ctx.vendors.find({ _id: { $in: rows.map((r) => r.supplierId).filter((v): v is string => !!v) } }).toArray()
      return { rows, suppliers: new Map(vendors.map((v) => [v._id, v.name])) }
    })
    return reply.send({ item: itemResponse(access.doc), movements: rows.map((m) => movementResponse(m, suppliers)) })
  })

  app.post('/ops/inventory/items/:id/movements', scoped('ops.inventory.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = movementBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await recordAccess(request, (ctx) => ctx.inventoryItems.findOne({ _id: id }))
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const body = parsed.data
    if (body.type === 'transfer' && !(await callerCanUseBranch(request, body.toBranchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    const actorId = request.auth!.sub
    const result = await transact(tenantId, async (ctx) => {
      const item = await ctx.inventoryItems.findOne({ _id: id })
      if (!item || !item.active) throw new Abort('INACTIVE')
      let movement: StockMovementDoc
      if (body.type === 'receive') {
        if (body.supplierId && !(await ctx.vendors.findOne({ _id: body.supplierId }))) throw new Abort('UNKNOWN_VENDOR')
        movement = await move(ctx, tenantId, item, 'receive', body.quantity, body, actorId)
      } else if (body.type === 'issue') {
        movement = await move(ctx, tenantId, item, 'issue', -body.quantity, body, actorId)
      } else if (body.type === 'adjust') {
        movement = await move(ctx, tenantId, item, 'adjust', body.quantity, body, actorId)
      } else {
        if (body.toBranchId === item.branchId) throw new Abort('SAME_BRANCH')
        if (!(await ctx.branches.findOne({ _id: body.toBranchId }))) throw new Abort('NOT_FOUND')
        let target = await ctx.inventoryItems.findOne({ branchId: body.toBranchId, sku: item.sku })
        if (!target) {
          const now = new Date()
          target = { ...item, _id: randomUUID(), branchId: body.toBranchId, quantity: 0, active: true, createdAt: now, updatedAt: now }
          await ctx.inventoryItems.insertOne(target)
        }
        movement = await move(ctx, tenantId, item, 'transfer_out', -body.quantity, { note: body.note }, actorId)
        const incoming = await move(ctx, tenantId, target, 'transfer_in', body.quantity, { note: body.note, relatedMovementId: movement._id }, actorId)
        await ctx.stockMovements.findOneAndUpdate({ _id: movement._id }, { $set: { relatedMovementId: incoming._id } })
      }
      await recordAudit(ctx.auditLog, {
        actorId,
        action: `inventory.${body.type}`,
        entity: 'inventoryItem',
        entityId: item._id,
        branchId: item.branchId,
        meta: { quantity: movement.quantity, balance: movement.balance },
      })
      return { movement, item: (await ctx.inventoryItems.findOne({ _id: id }))! }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send({ movement: movementResponse(result.movement), item: itemResponse(result.item) })
  })

  // -------------------------------------------------------- suppliers

  app.get('/ops/suppliers', scoped('ops.read'), async (request, reply) => {
    const rows = await withTenant(request.auth!.tenantId!, (ctx) => ctx.vendors.find({ active: true }).sort({ name: 1 }).toArray())
    return reply.send({ suppliers: rows.map((v) => ({ id: v._id, name: v.name, contactName: v.contactName, phone: v.phone, email: v.email })) })
  })

  app.post('/ops/suppliers', scoped('ops.inventory.manage'), async (request, reply) => {
    const parsed = supplierBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const now = new Date()
    const doc: VendorDoc = { _id: randomUUID(), tenantId, ...parsed.data, taxNumber: null, notes: null, active: true, createdAt: now, updatedAt: now, createdBy: request.auth!.sub }
    await withTenant(tenantId, async (ctx) => {
      await ctx.vendors.insertOne(doc)
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'vendor.create', entity: 'vendor', entityId: doc._id, after: doc })
    })
    return reply.code(201).send({ id: doc._id, name: doc.name, contactName: doc.contactName, phone: doc.phone, email: doc.email })
  })
}
