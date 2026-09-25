import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { DiscountTypeDoc, InvoiceDoc, TenantContext } from '../db.js'
import { callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { readReason, setAuditReason } from '../requestContext.js'
import { registerApprovalType } from '../approvals/registry.js'
import { invoicePaidTotal, price, setAdjustments } from './service.js'
import { describeValue, isFailure, scoped, sendFailure, transact, FinanceAbort } from './common.js'

/**
 * SAMS 3.2, part one: named discount types (sibling, staff child, early
 * payment…) kept as a price list and applied to an invoice as an
 * adjustment. Someone with `finance.discount.approve` applies one
 * directly; anyone who may edit invoice lines can ask for one through the
 * approval engine (type `finance.invoiceDiscount`).
 *
 * Same money rule as a line discount: an applied discount must not take
 * the invoice below what has already been paid.
 */

const discountTypeBody = z.object({
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).nullable().default(null),
  type: z.enum(['amount', 'percent']),
  value: z.number().int().min(1),
})
const updateDiscountTypeBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  nameAr: z.string().trim().max(120).nullable().optional(),
  value: z.number().int().min(1).optional(),
  active: z.boolean().optional(),
})

export function discountTypeResponse(doc: DiscountTypeDoc) {
  return {
    id: doc._id,
    name: doc.name,
    nameAr: doc.nameAr,
    type: doc.type,
    value: doc.value,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

/** Applies a discount type to an invoice, inside the caller's transaction. */
async function applyDiscountType(
  ctx: TenantContext,
  invoiceId: string,
  discountTypeId: string,
  actorId: string,
): Promise<InvoiceDoc> {
  const { invoice, type } = await checkApply(ctx, invoiceId, discountTypeId)
  const adjustments = [
    ...(invoice.adjustments ?? []),
    {
      id: randomUUID(),
      source: 'discount' as const,
      refId: type._id,
      label: type.name,
      type: type.type,
      value: type.value,
      amount: 0,
      appliedAt: new Date(),
      appliedBy: actorId,
    },
  ]
  if (price(invoice.lineItems, adjustments).total < (await invoicePaidTotal(ctx, invoiceId))) {
    throw new FinanceAbort('DISCOUNT_BELOW_PAID')
  }
  return setAdjustments(ctx, invoice, adjustments, { actorId, action: 'invoice.discount.apply' })
}

async function checkApply(ctx: TenantContext, invoiceId: string, discountTypeId: string) {
  const invoice = await ctx.invoices.findOne({ _id: invoiceId })
  if (!invoice) throw new FinanceAbort('UNKNOWN_INVOICE')
  if (invoice.status === 'void') throw new FinanceAbort('INVOICE_VOID')
  const type = await ctx.discountTypes.findOne({ _id: discountTypeId, active: true })
  if (!type) throw new FinanceAbort('UNKNOWN_DISCOUNT_TYPE')
  if ((invoice.adjustments ?? []).some((a) => a.refId === type._id)) throw new FinanceAbort('ALREADY_APPLIED')
  return { invoice, type }
}

const outcome = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
    return { ok: true as const }
  } catch (error) {
    if (error instanceof FinanceAbort) return { ok: false as const, error: error.code }
    throw error
  }
}

registerApprovalType<{ discountTypeId: string }>({
  type: 'finance.invoiceDiscount',
  entity: 'invoice',
  requestScope: 'finance.invoice.lineItems',
  decideScope: 'finance.discount.approve',
  payloadSchema: z.object({ discountTypeId: z.string().min(1) }),
  async resolve(ctx, invoiceId, payload) {
    try {
      const { invoice, type } = await checkApply(ctx, invoiceId, payload.discountTypeId)
      return {
        ok: true,
        branchId: invoice.branchId,
        dedupeKey: `invoice:${invoiceId}:discount:${type._id}`,
        summary: `${invoice.invoiceNumber} · ${type.name} · −${describeValue(type.type, type.value)}`,
      }
    } catch (error) {
      if (error instanceof FinanceAbort) return { ok: false, error: error.code }
      throw error
    }
  },
  onApproved: (ctx, request, actorId) =>
    outcome(() => applyDiscountType(ctx, request.entityId, (request.payload as { discountTypeId: string }).discountTypeId, actorId)),
})

export function registerDiscountRoutes(app: FastifyInstance, invoiceResponse: (doc: InvoiceDoc) => unknown): void {
  app.get('/finance/discount-types', scoped('finance.read'), async (request, reply) => {
    const { includeInactive } = request.query as { includeInactive?: string }
    const filter: Filter<DiscountTypeDoc> = includeInactive === 'true' ? {} : { active: true }
    const rows = await withTenant(request.auth!.tenantId!, (ctx) => ctx.discountTypes.find(filter).sort({ name: 1 }).toArray())
    return reply.send({ discountTypes: rows.map(discountTypeResponse) })
  })

  app.post('/finance/discount-types', scoped('finance.feeStructure.manage'), async (request, reply) => {
    const parsed = discountTypeBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (parsed.data.type === 'percent' && parsed.data.value > 100) return reply.code(400).send({ error: 'VALUE_OUT_OF_RANGE' })
    const now = new Date()
    const doc: DiscountTypeDoc = {
      _id: randomUUID(),
      tenantId: request.auth!.tenantId!,
      ...parsed.data,
      active: true,
      createdAt: now,
      updatedAt: now,
      createdBy: request.auth!.sub,
    }
    await withTenant(doc.tenantId, async (ctx) => {
      await ctx.discountTypes.insertOne(doc)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'discountType.create',
        entity: 'discountType',
        entityId: doc._id,
        after: doc,
      })
    })
    return reply.code(201).send(discountTypeResponse(doc))
  })

  app.patch('/finance/discount-types/:id', scoped('finance.feeStructure.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateDiscountTypeBody.safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const updated = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const before = await ctx.discountTypes.findOne({ _id: id })
      if (!before) return null
      if (before.type === 'percent' && (parsed.data.value ?? 0) > 100) return 'range' as const
      // Invoices keep the type and value they were given; this changes only
      // what is applied from now on.
      const after = await ctx.discountTypes.findOneAndUpdate(
        { _id: id },
        { $set: { ...parsed.data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'discountType.update',
        entity: 'discountType',
        entityId: id,
        before,
        after,
      })
      return after
    })
    if (updated === 'range') return reply.code(400).send({ error: 'VALUE_OUT_OF_RANGE' })
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(discountTypeResponse(updated))
  })

  app.post('/finance/invoices/:id/adjustments', scoped('finance.discount.approve'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ discountTypeId: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const invoice = await withTenant(tenantId, (ctx) => ctx.invoices.findOne({ _id: id }))
    if (!invoice) return reply.code(404).send({ error: 'UNKNOWN_INVOICE' })
    if (!(await callerCanUseBranch(request, invoice.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const result = await transact(tenantId, (ctx) => applyDiscountType(ctx, id, parsed.data.discountTypeId, request.auth!.sub))
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(invoiceResponse(result))
  })

  app.delete('/finance/invoices/:id/adjustments/:adjustmentId', scoped('finance.discount.approve'), async (request, reply) => {
    const { id, adjustmentId } = request.params as { id: string; adjustmentId: string }
    const reason = readReason(request.body)
    if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' })
    setAuditReason(reason)
    const tenantId = request.auth!.tenantId!
    const invoice = await withTenant(tenantId, (ctx) => ctx.invoices.findOne({ _id: id }))
    if (!invoice) return reply.code(404).send({ error: 'UNKNOWN_INVOICE' })
    if (!(await callerCanUseBranch(request, invoice.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const result = await transact(tenantId, async (ctx) => {
      const current = await ctx.invoices.findOne({ _id: id })
      if (!current || current.status === 'void') throw new FinanceAbort('INVOICE_VOID')
      const target = (current.adjustments ?? []).find((a) => a.id === adjustmentId)
      if (!target) throw new FinanceAbort('NOT_FOUND')
      // A scholarship leaves an invoice only by being revoked.
      if (target.source === 'scholarship') throw new FinanceAbort('USE_SCHOLARSHIP_REVOKE')
      return setAdjustments(
        ctx,
        current,
        (current.adjustments ?? []).filter((a) => a.id !== adjustmentId),
        { actorId: request.auth!.sub, action: 'invoice.discount.remove' },
      )
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(invoiceResponse(result))
  })
}
