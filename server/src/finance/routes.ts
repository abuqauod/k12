import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { FeeStructureDoc, InvoiceDoc, PaymentDoc, ReceiptDoc } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerCanUseBranch,
  requireActiveSubscription,
  requirePermission,
  callerHasPermission,
} from '../auth/guard.js'
import type { PermissionScope } from '../auth/scopes.js'
import { recordAudit } from '../audit.js'
import {
  addLineItem,
  computeStudentBalances,
  generateInvoice,
  recordPayment,
  removeLineItem,
  updateLineItem,
  voidInvoice,
  voidPayment,
} from './service.js'

/**
 * Finance & Accounting core loop — fee structures, invoices, payments,
 * receipts. See db.ts's finance-section comment for the data model and
 * finance/service.ts for the write logic this module is a thin Fastify
 * wrapper over.
 *
 * Role mapping (approximated onto the existing 4-role gate, same idiom as
 * parents/routes.ts):
 *   read (any list/get)                     -> viewer+
 *   generate an invoice from a fee structure -> scheduler+ (applies an
 *     already admin-approved price list to one student — a routine
 *     front-office billing action, not a pricing decision)
 *   add/edit/remove an invoice line item      -> scheduler+, EXCEPT setting
 *     a non-null discount on a line requires admin+ (inline check, same
 *     shape as parents/routes.ts's financialResponsibility gate)
 *   record a payment                          -> scheduler+ (day-to-day
 *     cash-desk operation)
 *   define/edit/deactivate a fee structure     -> admin+ (a pricing
 *     decision, higher trust than applying one)
 *   void an invoice or a payment               -> admin+ (no refund flow
 *     exists, so this is the only undo and must be deliberate)
 *
 * Branch scoping: unlike parents/routes.ts (which doesn't branch-restrict),
 * every mutation and every list/get here is checked against
 * `callerBranchIds`/`callerCanUseBranch` — money is more sensitive than
 * contact info, so a scheduler assigned to specific branches only sees and
 * acts on invoices/payments for students in those branches.
 */

const lineItemBody = z.object({
  id: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(200),
  labelAr: z.string().max(200).nullable().default(null),
  amount: z.number().int().min(0),
})

const feeStructureBody = z.object({
  branchId: z.string().min(1),
  academicYearId: z.string().min(1),
  gradeLevel: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  lineItems: z.array(lineItemBody).max(50).default([]),
})
const updateFeeStructureBody = z.object({
  name: z.string().min(1).max(200).optional(),
  lineItems: z.array(lineItemBody).max(50).optional(),
})

const feeStructureListQuery = z.object({
  branchId: z.string().optional(),
  academicYearId: z.string().optional(),
  gradeLevel: z.string().optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
})

const generateInvoiceBody = z.object({
  studentId: z.string().min(1),
  feeStructureId: z.string().min(1),
  dueDate: z.string().date().nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
})

const discountBody = z
  .object({ type: z.enum(['amount', 'percent']), value: z.number().int().min(0) })
  .nullable()

const addLineItemBody = z.object({
  label: z.string().min(1).max(200),
  labelAr: z.string().max(200).nullable().default(null),
  amount: z.number().int().min(0),
  discount: discountBody.default(null),
})
const updateLineItemBody = z.object({
  label: z.string().min(1).max(200).optional(),
  labelAr: z.string().max(200).nullable().optional(),
  amount: z.number().int().min(0).optional(),
  discount: discountBody.optional(),
})

const invoiceListQuery = z.object({
  studentId: z.string().optional(),
  branchId: z.string().optional(),
  academicYearId: z.string().optional(),
  status: z.enum(['open', 'partially_paid', 'paid', 'void']).optional(),
})

const recordPaymentBody = z.object({
  amount: z.number().int().min(1),
  method: z.enum(['cash', 'bank_transfer', 'card', 'cheque', 'other']),
  reference: z.string().max(200).nullable().default(null),
  paidAt: z.string().date(),
  payerName: z.string().min(1).max(200),
  notes: z.string().max(2000).nullable().default(null),
})

const paymentListQuery = z.object({
  invoiceId: z.string().optional(),
  studentId: z.string().optional(),
})

const receiptListQuery = z.object({
  invoiceId: z.string().optional(),
  studentId: z.string().optional(),
})

function feeStructureResponse(doc: FeeStructureDoc) {
  return {
    id: doc._id,
    branchId: doc.branchId,
    academicYearId: doc.academicYearId,
    gradeLevel: doc.gradeLevel,
    name: doc.name,
    lineItems: doc.lineItems,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

function invoiceResponse(doc: InvoiceDoc) {
  return {
    id: doc._id,
    studentId: doc.studentId,
    branchId: doc.branchId,
    academicYearId: doc.academicYearId,
    feeStructureId: doc.feeStructureId,
    invoiceNumber: doc.invoiceNumber,
    issueDate: doc.issueDate,
    dueDate: doc.dueDate,
    lineItems: doc.lineItems,
    total: doc.total,
    status: doc.status,
    notes: doc.notes,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    voidedAt: doc.voidedAt ? doc.voidedAt.toISOString() : null,
  }
}

function paymentResponse(doc: PaymentDoc) {
  return {
    id: doc._id,
    invoiceId: doc.invoiceId,
    studentId: doc.studentId,
    amount: doc.amount,
    method: doc.method,
    reference: doc.reference,
    paidAt: doc.paidAt,
    payerName: doc.payerName,
    payerParentId: doc.payerParentId,
    notes: doc.notes,
    createdAt: doc.createdAt.toISOString(),
    voidedAt: doc.voidedAt ? doc.voidedAt.toISOString() : null,
  }
}

function receiptResponse(doc: ReceiptDoc) {
  return {
    id: doc._id,
    paymentId: doc.paymentId,
    invoiceId: doc.invoiceId,
    studentId: doc.studentId,
    receiptNumber: doc.receiptNumber,
    amount: doc.amount,
    method: doc.method,
    payerName: doc.payerName,
    issueDate: doc.issueDate,
    createdAt: doc.createdAt.toISOString(),
  }
}

const ERROR_STATUS: Record<string, number> = {
  UNKNOWN_STUDENT: 404,
  NOT_ENROLLED: 409,
  UNKNOWN_FEE_STRUCTURE: 404,
  FEE_STRUCTURE_BRANCH_MISMATCH: 409,
  UNKNOWN_INVOICE: 404,
  INVOICE_VOID: 409,
  UNKNOWN_LINE_ITEM: 404,
  UNKNOWN_PAYMENT: 404,
  DISCOUNT_REQUIRES_ADMIN: 403,
  BRANCH_FORBIDDEN: 403,
}

export function registerFinanceRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('finance.read')] }
  const scoped = (scope: PermissionScope) => ({
    preHandler: [authenticate, requireActiveSubscription, requirePermission(scope)],
  })

  // ------------------------------------------------------------ fee structures

  app.get('/finance/fee-structures', readGuard, async (request, reply) => {
    const parsed = feeStructureListQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const allowed = await callerBranchIds(request)
    if (parsed.data.branchId && allowed !== null && !allowed.includes(parsed.data.branchId)) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const filter: Filter<FeeStructureDoc> = {}
    if (parsed.data.branchId) filter.branchId = parsed.data.branchId
    else if (allowed !== null) filter.branchId = { $in: allowed }
    if (parsed.data.academicYearId) filter.academicYearId = parsed.data.academicYearId
    if (parsed.data.gradeLevel) filter.gradeLevel = parsed.data.gradeLevel
    if (parsed.data.includeInactive !== 'true') filter.active = true

    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.feeStructures.find(filter).sort({ gradeLevel: 1, name: 1 }).toArray(),
    )
    return reply.send({ feeStructures: rows.map(feeStructureResponse) })
  })

  app.get('/finance/fee-structures/:id', readGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const doc = await withTenant(request.auth!.tenantId!, (ctx) => ctx.feeStructures.findOne({ _id: id }))
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, doc.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    return reply.send(feeStructureResponse(doc))
  })

  app.post('/finance/fee-structures', scoped('finance.feeStructure.manage'), async (request, reply) => {
    const parsed = feeStructureBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const tenantId = request.auth!.tenantId!
    const now = new Date()
    const doc: FeeStructureDoc = {
      _id: randomUUID(),
      tenantId,
      branchId: parsed.data.branchId,
      academicYearId: parsed.data.academicYearId,
      gradeLevel: parsed.data.gradeLevel,
      name: parsed.data.name,
      lineItems: parsed.data.lineItems.map((item) => ({ ...item, id: item.id ?? randomUUID() })),
      active: true,
      createdAt: now,
      updatedAt: now,
      createdBy: request.auth!.sub,
    }
    const created = await withTenant(tenantId, async (ctx) => {
      const branch = await ctx.branches.findOne({ _id: doc.branchId })
      if (!branch) return { error: 'UNKNOWN_BRANCH' as const }
      const clash = await ctx.feeStructures.findOne({
        branchId: doc.branchId,
        academicYearId: doc.academicYearId,
        gradeLevel: doc.gradeLevel,
        active: true,
      })
      if (clash) return { error: 'FEE_STRUCTURE_EXISTS' as const }
      await ctx.feeStructures.insertOne(doc)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'feeStructure.create',
        entity: 'feeStructure',
        entityId: doc._id,
        branchId: doc.branchId,
        before: null,
        after: doc,
      })
      return { doc }
    })
    if ('error' in created) {
      return reply.code(created.error === 'UNKNOWN_BRANCH' ? 404 : 409).send({ error: created.error })
    }
    return reply.code(201).send(feeStructureResponse(created.doc))
  })

  // A branch check that runs AFTER the write commits only gates the HTTP
  // response, not the mutation — `withTenant` commits its transaction as
  // soon as the callback resolves. Every fee-structure mutation below
  // resolves the target's branchId in its own read, before the write
  // transaction starts, same shape as `requireInvoiceBranchAccess`.
  async function requireFeeStructureBranchAccess(
    request: Parameters<typeof callerCanUseBranch>[0],
    id: string,
    tenantId: string,
  ) {
    const doc = await withTenant(tenantId, (ctx) => ctx.feeStructures.findOne({ _id: id }))
    if (!doc) return { ok: false as const, status: 404, error: 'NOT_FOUND' }
    if (!(await callerCanUseBranch(request, doc.branchId))) {
      return { ok: false as const, status: 403, error: 'BRANCH_FORBIDDEN' }
    }
    return { ok: true as const, doc }
  }

  app.patch('/finance/fee-structures/:id', scoped('finance.feeStructure.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateFeeStructureBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })

    const tenantId = request.auth!.tenantId!
    const access = await requireFeeStructureBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.feeStructures.findOne({ _id: id })
      if (!before) return null
      const lineItems = parsed.data.lineItems?.map((item) => ({ ...item, id: item.id ?? randomUUID() }))
      const updated = await ctx.feeStructures.findOneAndUpdate(
        { _id: id },
        { $set: { ...(parsed.data.name ? { name: parsed.data.name } : {}), ...(lineItems ? { lineItems } : {}), updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'feeStructure.update',
        entity: 'feeStructure',
        entityId: id,
        branchId: before.branchId,
        before,
        after: updated,
      })
      return { before, updated }
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(feeStructureResponse(result.updated!))
  })

  app.post('/finance/fee-structures/:id/deactivate', scoped('finance.feeStructure.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const access = await requireFeeStructureBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.feeStructures.findOne({ _id: id })
      if (!before) return null
      const updated = await ctx.feeStructures.findOneAndUpdate(
        { _id: id },
        { $set: { active: false, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'feeStructure.deactivate',
        entity: 'feeStructure',
        entityId: id,
        branchId: before.branchId,
        before,
        after: updated,
      })
      return { before, updated }
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(feeStructureResponse(result.updated!))
  })

  // ------------------------------------------------------------------ invoices

  app.get('/finance/invoices', readGuard, async (request, reply) => {
    const parsed = invoiceListQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const allowed = await callerBranchIds(request)
    if (parsed.data.branchId && allowed !== null && !allowed.includes(parsed.data.branchId)) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const filter: Filter<InvoiceDoc> = {}
    if (parsed.data.studentId) filter.studentId = parsed.data.studentId
    if (parsed.data.branchId) filter.branchId = parsed.data.branchId
    else if (allowed !== null) filter.branchId = { $in: allowed }
    if (parsed.data.academicYearId) filter.academicYearId = parsed.data.academicYearId
    if (parsed.data.status) filter.status = parsed.data.status

    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.invoices.find(filter).sort({ issueDate: -1 }).toArray(),
    )
    return reply.send({ invoices: rows.map(invoiceResponse) })
  })

  app.get('/finance/invoices/:id', readGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const doc = await withTenant(request.auth!.tenantId!, (ctx) => ctx.invoices.findOne({ _id: id }))
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, doc.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    return reply.send(invoiceResponse(doc))
  })

  app.post('/finance/invoices', scoped('finance.invoice.create'), async (request, reply) => {
    const parsed = generateInvoiceBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const tenantId = request.auth!.tenantId!
    const targetBranchId = await withTenant(tenantId, async (ctx) => {
      const structure = await ctx.feeStructures.findOne({ _id: parsed.data.feeStructureId })
      return structure?.branchId ?? null
    })
    if (targetBranchId && !(await callerCanUseBranch(request, targetBranchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const result = await withTenant(tenantId, (ctx) =>
      generateInvoice(ctx, tenantId, { ...parsed.data, actorId: request.auth!.sub }),
    )
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.code(201).send(invoiceResponse(result.invoice))
  })

  async function requireInvoiceBranchAccess(request: Parameters<typeof callerCanUseBranch>[0], invoiceId: string, tenantId: string) {
    const invoice = await withTenant(tenantId, (ctx) => ctx.invoices.findOne({ _id: invoiceId }))
    if (!invoice) return { ok: false as const, status: 404, error: 'UNKNOWN_INVOICE' }
    if (!(await callerCanUseBranch(request, invoice.branchId))) {
      return { ok: false as const, status: 403, error: 'BRANCH_FORBIDDEN' }
    }
    return { ok: true as const, invoice }
  }

  app.post('/finance/invoices/:id/line-items', scoped('finance.invoice.lineItems'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = addLineItemBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (parsed.data.discount && !(await callerHasPermission(request, 'finance.discount.approve'))) {
      return reply.code(403).send({ error: 'DISCOUNT_REQUIRES_ADMIN' })
    }
    const tenantId = request.auth!.tenantId!
    const access = await requireInvoiceBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, (ctx) =>
      addLineItem(ctx, id, { ...parsed.data, actorId: request.auth!.sub }),
    )
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.code(201).send(invoiceResponse(result.invoice))
  })

  app.patch('/finance/invoices/:id/line-items/:lineItemId', scoped('finance.invoice.lineItems'), async (request, reply) => {
    const { id, lineItemId } = request.params as { id: string; lineItemId: string }
    const parsed = updateLineItemBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (parsed.data.discount !== undefined && parsed.data.discount !== null && !(await callerHasPermission(request, 'finance.discount.approve'))) {
      return reply.code(403).send({ error: 'DISCOUNT_REQUIRES_ADMIN' })
    }
    const tenantId = request.auth!.tenantId!
    const access = await requireInvoiceBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, (ctx) =>
      updateLineItem(ctx, id, lineItemId, { ...parsed.data, actorId: request.auth!.sub }),
    )
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.send(invoiceResponse(result.invoice))
  })

  app.delete('/finance/invoices/:id/line-items/:lineItemId', scoped('finance.invoice.lineItems'), async (request, reply) => {
    const { id, lineItemId } = request.params as { id: string; lineItemId: string }
    const tenantId = request.auth!.tenantId!
    const access = await requireInvoiceBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, (ctx) => removeLineItem(ctx, id, lineItemId, request.auth!.sub))
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.send(invoiceResponse(result.invoice))
  })

  app.post('/finance/invoices/:id/void', scoped('finance.invoice.void'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const access = await requireInvoiceBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, (ctx) => voidInvoice(ctx, id, request.auth!.sub))
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.send(invoiceResponse(result.invoice))
  })

  // ------------------------------------------------------------------ payments

  app.get('/finance/payments', readGuard, async (request, reply) => {
    const parsed = paymentListQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    if (!parsed.data.invoiceId && !parsed.data.studentId) {
      return reply.code(400).send({ error: 'MISSING_FILTER' })
    }

    const tenantId = request.auth!.tenantId!
    const filter: Filter<PaymentDoc> = {}
    if (parsed.data.invoiceId) filter.invoiceId = parsed.data.invoiceId
    if (parsed.data.studentId) filter.studentId = parsed.data.studentId

    const result = await withTenant(tenantId, async (ctx) => {
      const rows = await ctx.payments.find(filter).sort({ paidAt: -1 }).toArray()
      const invoiceIds = [...new Set(rows.map((r) => r.invoiceId))]
      const invoices = invoiceIds.length > 0 ? await ctx.invoices.find({ _id: { $in: invoiceIds } }).toArray() : []
      return { rows, branchIds: new Set(invoices.map((i) => i.branchId)) }
    })
    for (const branchId of result.branchIds) {
      if (!(await callerCanUseBranch(request, branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    return reply.send({ payments: result.rows.map(paymentResponse) })
  })

  app.post('/finance/invoices/:id/payments', scoped('finance.payment.create'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = recordPaymentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const access = await requireInvoiceBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, (ctx) =>
      recordPayment(ctx, tenantId, { invoiceId: id, ...parsed.data, actorId: request.auth!.sub }),
    )
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.code(201).send({
      payment: paymentResponse(result.payment),
      receipt: receiptResponse(result.receipt),
      invoice: invoiceResponse(result.invoice),
    })
  })

  app.post('/finance/payments/:id/void', scoped('finance.payment.void'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const payment = await withTenant(tenantId, (ctx) => ctx.payments.findOne({ _id: id }))
    if (!payment) return reply.code(404).send({ error: 'UNKNOWN_PAYMENT' })
    const access = await requireInvoiceBranchAccess(request, payment.invoiceId, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

    const result = await withTenant(tenantId, (ctx) => voidPayment(ctx, id, request.auth!.sub))
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.send({ payment: paymentResponse(result.payment), invoice: invoiceResponse(result.invoice) })
  })

  // ------------------------------------------------------------------ receipts

  app.get('/finance/receipts', readGuard, async (request, reply) => {
    const parsed = receiptListQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    if (!parsed.data.invoiceId && !parsed.data.studentId) {
      return reply.code(400).send({ error: 'MISSING_FILTER' })
    }

    const tenantId = request.auth!.tenantId!
    const filter: Filter<ReceiptDoc> = {}
    if (parsed.data.invoiceId) filter.invoiceId = parsed.data.invoiceId
    if (parsed.data.studentId) filter.studentId = parsed.data.studentId

    const result = await withTenant(tenantId, async (ctx) => {
      const rows = await ctx.receipts.find(filter).sort({ issueDate: -1 }).toArray()
      const invoiceIds = [...new Set(rows.map((r) => r.invoiceId))]
      const invoices = invoiceIds.length > 0 ? await ctx.invoices.find({ _id: { $in: invoiceIds } }).toArray() : []
      return { rows, branchIds: new Set(invoices.map((i) => i.branchId)) }
    })
    for (const branchId of result.branchIds) {
      if (!(await callerCanUseBranch(request, branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    return reply.send({ receipts: result.rows.map(receiptResponse) })
  })

  app.get('/finance/receipts/:id', readGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const doc = await withTenant(tenantId, (ctx) => ctx.receipts.findOne({ _id: id }))
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' })
    const access = await requireInvoiceBranchAccess(request, doc.invoiceId, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    return reply.send(receiptResponse(doc))
  })

  // -------------------------------------------------------------------------

  app.get('/finance/students/:studentId/balance', readGuard, async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const tenantId = request.auth!.tenantId!
    const student = await withTenant(tenantId, (ctx) => ctx.students.findOne({ _id: studentId }))
    if (!student) return reply.code(404).send({ error: 'UNKNOWN_STUDENT' })
    if (!(await callerCanUseBranch(request, student.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    const balance = await withTenant(tenantId, (ctx) => computeStudentBalances(ctx, [studentId]))
    return reply.send(
      balance.get(studentId) ?? { invoicedTotal: 0, paidTotal: 0, outstandingBalance: 0 },
    )
  })
}
