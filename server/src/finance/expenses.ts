import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { ExpenseDoc, VendorDoc } from '../db.js'
import { callerBranchIds, callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { registerApprovalType } from '../approvals/registry.js'
import { cancelPendingFor, insertRequest } from '../approvals/service.js'
import { activeCodes, ensureDefaults } from '../settings/lookups.js'
import { nextSequence } from './service.js'
import { branchFilter, FinanceAbort, isFailure, money, scoped, sendFailure, transact } from './common.js'

/**
 * SAMS 3.5: what the school spends. An expense is recorded against a
 * branch, an `expenseCategory` (a settings list, 1.11) and optionally a
 * vendor, with its receipt or vendor invoice attached (documents, owner
 * type `expense`). It is approved by someone else through the approval
 * engine (`finance.expense.approve`) and then marked paid
 * (`finance.payout`). Only paid expenses count as money out in reports.
 */

const vendorBody = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(200).nullable().default(null),
  phone: z.string().trim().max(40).nullable().default(null),
  email: z.string().trim().email().max(200).nullable().default(null),
  taxNumber: z.string().trim().max(60).nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
})
const vendorPatch = vendorBody.partial().extend({ active: z.boolean().optional() })

const expenseBody = z.object({
  branchId: z.string().min(1),
  categoryCode: z.string().min(1).max(64),
  vendorId: z.string().min(1).nullable().default(null),
  description: z.string().trim().min(1).max(1000),
  amount: z.number().int().min(1),
  expenseDate: z.string().date(),
  reference: z.string().trim().max(200).nullable().default(null),
})

const payBody = z.object({
  paidAt: z.string().date(),
  method: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  reference: z.string().trim().max(200).nullable().default(null),
})

const listQuery = z.object({
  branchId: z.string().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'paid']).optional(),
  categoryCode: z.string().optional(),
  vendorId: z.string().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
})

export function vendorResponse(doc: VendorDoc) {
  return {
    id: doc._id,
    name: doc.name,
    contactName: doc.contactName,
    phone: doc.phone,
    email: doc.email,
    taxNumber: doc.taxNumber,
    notes: doc.notes,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
  }
}

export function expenseResponse(doc: ExpenseDoc, vendorName?: string | null) {
  return {
    id: doc._id,
    expenseNumber: doc.expenseNumber,
    branchId: doc.branchId,
    categoryCode: doc.categoryCode,
    vendorId: doc.vendorId,
    vendorName: vendorName ?? null,
    description: doc.description,
    amount: doc.amount,
    expenseDate: doc.expenseDate,
    reference: doc.reference,
    status: doc.status,
    requestedBy: doc.requestedBy,
    decidedBy: doc.decidedBy,
    decidedAt: doc.decidedAt?.toISOString() ?? null,
    paidAt: doc.paidAt,
    method: doc.method,
    paymentReference: doc.paymentReference,
    createdAt: doc.createdAt.toISOString(),
  }
}

registerApprovalType<Record<string, never>>({
  type: 'finance.expense',
  entity: 'expense',
  requestScope: 'finance.expense.create',
  decideScope: 'finance.expense.approve',
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async resolve(ctx, id) {
    const doc = await ctx.expenses.findOne({ _id: id })
    if (!doc) return { ok: false, error: 'NOT_FOUND' }
    if (doc.status !== 'pending') return { ok: false, error: 'NOT_PENDING' }
    return {
      ok: true,
      branchId: doc.branchId,
      dedupeKey: `expense:${id}`,
      summary: `${doc.expenseNumber} · ${doc.description.slice(0, 60)} · ${money(doc.amount)}`,
    }
  },
  async onApproved(ctx, request, actorId) {
    const now = new Date()
    const doc = await ctx.expenses.findOneAndUpdate(
      { _id: request.entityId, status: 'pending' },
      { $set: { status: 'approved', decidedBy: actorId, decidedAt: now, updatedAt: now } },
    )
    if (!doc) return { ok: false, error: 'NOT_PENDING' }
    await recordAudit(ctx.auditLog, {
      actorId,
      action: 'expense.approve',
      entity: 'expense',
      entityId: request.entityId,
      branchId: doc.branchId,
      before: { status: 'pending' },
      after: { status: 'approved' },
    })
    return { ok: true }
  },
  async onClosed(ctx, request, outcome, actorId) {
    const now = new Date()
    await ctx.expenses.findOneAndUpdate(
      { _id: request.entityId, status: 'pending' },
      { $set: { status: outcome, decidedBy: actorId, decidedAt: now, updatedAt: now } },
    )
  },
})

export function registerExpenseRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------ vendors

  app.get('/finance/vendors', scoped('finance.read'), async (request, reply) => {
    const { includeInactive } = request.query as { includeInactive?: string }
    const filter: Filter<VendorDoc> = includeInactive === 'true' ? {} : { active: true }
    const rows = await withTenant(request.auth!.tenantId!, (ctx) => ctx.vendors.find(filter).sort({ name: 1 }).toArray())
    return reply.send({ vendors: rows.map(vendorResponse) })
  })

  app.post('/finance/vendors', scoped('finance.expense.create'), async (request, reply) => {
    const parsed = vendorBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const now = new Date()
    const doc: VendorDoc = {
      _id: randomUUID(),
      tenantId: request.auth!.tenantId!,
      ...parsed.data,
      active: true,
      createdAt: now,
      updatedAt: now,
      createdBy: request.auth!.sub,
    }
    await withTenant(doc.tenantId, async (ctx) => {
      await ctx.vendors.insertOne(doc)
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'vendor.create', entity: 'vendor', entityId: doc._id, after: doc })
    })
    return reply.code(201).send(vendorResponse(doc))
  })

  app.patch('/finance/vendors/:id', scoped('finance.expense.create'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = vendorPatch.safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const updated = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const before = await ctx.vendors.findOne({ _id: id })
      if (!before) return null
      const after = await ctx.vendors.findOneAndUpdate(
        { _id: id },
        { $set: { ...parsed.data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, { actorId: request.auth!.sub, action: 'vendor.update', entity: 'vendor', entityId: id, before, after })
      return after
    })
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(vendorResponse(updated))
  })

  // ------------------------------------------------------------ expenses

  app.get('/finance/expenses', scoped('finance.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<ExpenseDoc> = {}
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    if (parsed.data.status) filter.status = parsed.data.status
    if (parsed.data.categoryCode) filter.categoryCode = parsed.data.categoryCode
    if (parsed.data.vendorId) filter.vendorId = parsed.data.vendorId
    if (parsed.data.from || parsed.data.to) {
      filter.expenseDate = {
        ...(parsed.data.from ? { $gte: parsed.data.from } : {}),
        ...(parsed.data.to ? { $lte: parsed.data.to } : {}),
      }
    }
    const { rows, vendors } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const rows = await ctx.expenses.find(filter).sort({ expenseDate: -1, createdAt: -1 }).limit(1000).toArray()
      const ids = [...new Set(rows.map((r) => r.vendorId).filter((v): v is string => !!v))]
      const vendors = ids.length > 0 ? await ctx.vendors.find({ _id: { $in: ids } }).toArray() : []
      return { rows, vendors: new Map(vendors.map((v) => [v._id, v.name])) }
    })
    return reply.send({ expenses: rows.map((r) => expenseResponse(r, r.vendorId ? vendors.get(r.vendorId) : null)) })
  })

  app.get('/finance/expenses/:id', scoped('finance.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const found = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const doc = await ctx.expenses.findOne({ _id: id })
      const vendor = doc?.vendorId ? await ctx.vendors.findOne({ _id: doc.vendorId }) : null
      return doc ? { doc, vendorName: vendor?.name ?? null } : null
    })
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, found.doc.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    return reply.send(expenseResponse(found.doc, found.vendorName))
  })

  app.post('/finance/expenses', scoped('finance.expense.create'), async (request, reply) => {
    const parsed = expenseBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    await ensureDefaults(tenantId, 'expenseCategory')
    const allowedBranchIds = await callerBranchIds(request)

    const result = await transact(tenantId, async (ctx) => {
      if (!(await ctx.branches.findOne({ _id: parsed.data.branchId }))) throw new FinanceAbort('NOT_FOUND')
      if (!(await activeCodes(ctx, 'expenseCategory')).has(parsed.data.categoryCode)) throw new FinanceAbort('INVALID_CATEGORY')
      if (parsed.data.vendorId && !(await ctx.vendors.findOne({ _id: parsed.data.vendorId, active: true }))) {
        throw new FinanceAbort('UNKNOWN_VENDOR')
      }
      const seq = await nextSequence(ctx, tenantId, 'expenseNumber')
      const now = new Date()
      const doc: ExpenseDoc = {
        _id: randomUUID(),
        tenantId,
        expenseNumber: `EXP-${String(seq).padStart(6, '0')}`,
        ...parsed.data,
        status: 'pending',
        requestedBy: request.auth!.sub,
        decidedBy: null,
        decidedAt: null,
        paidAt: null,
        paidBy: null,
        method: null,
        paymentReference: null,
        createdAt: now,
        updatedAt: now,
      }
      await ctx.expenses.insertOne(doc)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'expense.create',
        entity: 'expense',
        entityId: doc._id,
        branchId: doc.branchId,
        after: doc,
      })
      const approval = await insertRequest(ctx, {
        type: 'finance.expense',
        entityId: doc._id,
        payload: {},
        comment: null,
        actorId: request.auth!.sub,
        allowedBranchIds,
      })
      if (!approval.ok) throw new FinanceAbort(approval.error)
      return { doc, approvalId: approval.request._id }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send({ ...expenseResponse(result.doc), approvalId: result.approvalId })
  })

  app.post('/finance/expenses/:id/pay', scoped('finance.payout'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = payBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const existing = await withTenant(tenantId, (ctx) => ctx.expenses.findOne({ _id: id }))
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, existing.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    await ensureDefaults(tenantId, 'paymentMethod')
    const methods = await withTenant(tenantId, (ctx) => activeCodes(ctx, 'paymentMethod'))
    if (!methods.has(parsed.data.method)) return reply.code(400).send({ error: 'INVALID_PAYMENT_METHOD' })

    const result = await transact(tenantId, async (ctx) => {
      const doc = await ctx.expenses.findOneAndUpdate(
        { _id: id, status: 'approved' },
        {
          $set: {
            status: 'paid',
            paidAt: parsed.data.paidAt,
            paidBy: request.auth!.sub,
            method: parsed.data.method,
            paymentReference: parsed.data.reference,
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' },
      )
      if (!doc) throw new FinanceAbort('NOT_APPROVED')
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'expense.pay',
        entity: 'expense',
        entityId: id,
        branchId: doc.branchId,
        before: { status: 'approved' },
        after: { status: 'paid', paidAt: doc.paidAt, method: doc.method },
      })
      return doc
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(expenseResponse(result))
  })

  app.post('/finance/expenses/:id/cancel', scoped('finance.expense.create'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const existing = await withTenant(tenantId, (ctx) => ctx.expenses.findOne({ _id: id }))
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, existing.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    if (existing.requestedBy !== request.auth!.sub) return reply.code(403).send({ error: 'NOT_REQUESTER' })
    const result = await transact(tenantId, async (ctx) => {
      const doc = await ctx.expenses.findOneAndUpdate(
        { _id: id, status: { $in: ['pending', 'approved'] } },
        { $set: { status: 'cancelled', updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      if (!doc) throw new FinanceAbort('NOT_CANCELLABLE')
      await cancelPendingFor(ctx, 'finance.expense', id, request.auth!.sub, 'Withdrawn by the requester')
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'expense.cancel',
        entity: 'expense',
        entityId: id,
        branchId: doc.branchId,
        before: { status: existing.status },
        after: { status: 'cancelled' },
      })
      return doc
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(expenseResponse(result))
  })
}
