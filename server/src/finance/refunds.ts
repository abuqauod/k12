import { apiBaseOf, refundOnline } from '../payments/service.js'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { RefundDoc, TenantContext } from '../db.js'
import { callerBranchIds, callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { registerApprovalType } from '../approvals/registry.js'
import { cancelPendingFor, insertRequest } from '../approvals/service.js'
import { activeCodes, ensureDefaults } from '../settings/lookups.js'
import { COUNTED, refreshStatus } from './service.js'
import { branchFilter, FinanceAbort, isFailure, money, scoped, sendFailure, transact } from './common.js'
import { nextNumber } from '../numbering.js'

/**
 * SAMS 3.3: refunds — money handed back against an invoice, in three
 * steps: requested (`finance.refund.request`), approved by someone else
 * through the approval engine (`finance.refund.approve`), then paid out
 * (`finance.payout`). Only a paid refund changes what the invoice has
 * been paid (finance/service.ts `invoicePaidTotals`).
 *
 * The refundable amount is what the invoice has actually received
 * (confirmed, non-void payments) less every refund already paid or still
 * in progress. It is checked when the refund is requested, approved and
 * paid, since payments can be voided in between. A void invoice can still
 * be refunded: that is the usual case for a student who left.
 */

const IN_PROGRESS: RefundDoc['status'][] = ['pending', 'approved']

const requestBody = z.object({
  amount: z.number().int().min(1),
  reason: z.string().trim().min(1).max(1000),
})

const payBody = z.object({
  paidAt: z.string().date(),
  method: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  reference: z.string().trim().max(200).nullable().default(null),
})

const listQuery = z.object({
  invoiceId: z.string().optional(),
  studentId: z.string().optional(),
  branchId: z.string().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'paid']).optional(),
})

export function refundResponse(doc: RefundDoc, invoiceNumber?: string | null) {
  return {
    id: doc._id,
    refundNumber: doc.refundNumber,
    invoiceId: doc.invoiceId,
    invoiceNumber: invoiceNumber ?? null,
    studentId: doc.studentId,
    branchId: doc.branchId,
    amount: doc.amount,
    reason: doc.reason,
    status: doc.status,
    requestedBy: doc.requestedBy,
    decidedBy: doc.decidedBy,
    decidedAt: doc.decidedAt?.toISOString() ?? null,
    paidAt: doc.paidAt,
    method: doc.method,
    reference: doc.reference,
    createdAt: doc.createdAt.toISOString(),
  }
}

/** What can still be refunded on an invoice, leaving `except` out of the
 * in-progress refunds (the refund being re-checked). */
export async function refundable(ctx: TenantContext, invoiceId: string, except?: string): Promise<number> {
  const [payments, refunds] = await Promise.all([
    ctx.payments.find({ invoiceId, ...COUNTED }).toArray(),
    ctx.refunds.find({ invoiceId, status: { $in: [...IN_PROGRESS, 'paid'] } }).toArray(),
  ])
  const received = payments.reduce((sum, p) => sum + p.amount, 0)
  const committed = refunds.filter((r) => r._id !== except).reduce((sum, r) => sum + r.amount, 0)
  return Math.max(0, received - committed)
}

async function checkCap(ctx: TenantContext, refund: RefundDoc) {
  const cap = await refundable(ctx, refund.invoiceId, refund._id)
  if (refund.amount > cap) throw new FinanceAbort('REFUND_EXCEEDS_REFUNDABLE', { refundable: cap })
}

registerApprovalType<Record<string, never>>({
  type: 'finance.refund',
  entity: 'refund',
  requestScope: 'finance.refund.request',
  decideScope: 'finance.refund.approve',
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async resolve(ctx, id) {
    const refund = await ctx.refunds.findOne({ _id: id })
    if (!refund) return { ok: false, error: 'NOT_FOUND' }
    if (refund.status !== 'pending') return { ok: false, error: 'NOT_PENDING' }
    const invoice = await ctx.invoices.findOne({ _id: refund.invoiceId })
    return {
      ok: true,
      branchId: refund.branchId,
      dedupeKey: `refund:${id}`,
      summary: `${refund.refundNumber} · ${invoice?.invoiceNumber ?? ''} · ${money(refund.amount)}`,
    }
  },
  async onApproved(ctx, request, actorId) {
    const refund = await ctx.refunds.findOne({ _id: request.entityId })
    if (!refund || refund.status !== 'pending') return { ok: false, error: 'NOT_PENDING' }
    const cap = await refundable(ctx, refund.invoiceId, refund._id)
    if (refund.amount > cap) return { ok: false, error: 'REFUND_EXCEEDS_REFUNDABLE' }
    const now = new Date()
    await ctx.refunds.findOneAndUpdate(
      { _id: refund._id, status: 'pending' },
      { $set: { status: 'approved', decidedBy: actorId, decidedAt: now, updatedAt: now } },
    )
    await recordAudit(ctx.auditLog, {
      actorId,
      action: 'refund.approve',
      entity: 'refund',
      entityId: refund._id,
      branchId: refund.branchId,
      before: { status: 'pending' },
      after: { status: 'approved' },
    })
    return { ok: true }
  },
  async onClosed(ctx, request, outcome, actorId) {
    const now = new Date()
    await ctx.refunds.findOneAndUpdate(
      { _id: request.entityId, status: 'pending' },
      { $set: { status: outcome, decidedBy: actorId, decidedAt: now, updatedAt: now } },
    )
  },
})

export function registerRefundRoutes(app: FastifyInstance): void {
  app.get('/finance/refunds', scoped('finance.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<RefundDoc> = {}
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    if (parsed.data.invoiceId) filter.invoiceId = parsed.data.invoiceId
    if (parsed.data.studentId) filter.studentId = parsed.data.studentId
    if (parsed.data.status) filter.status = parsed.data.status
    const { rows, numbers, cap } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const rows = await ctx.refunds.find(filter).sort({ createdAt: -1 }).limit(500).toArray()
      const invoices = await ctx.invoices.find({ _id: { $in: [...new Set(rows.map((r) => r.invoiceId))] } }).toArray()
      return {
        rows,
        numbers: new Map(invoices.map((i) => [i._id, i.invoiceNumber])),
        // For one invoice, also what could still be refunded.
        cap: parsed.data.invoiceId ? await refundable(ctx, parsed.data.invoiceId) : null,
      }
    })
    return reply.send({
      refunds: rows.map((r) => refundResponse(r, numbers.get(r.invoiceId))),
      ...(cap === null ? {} : { refundable: cap }),
    })
  })

  app.post('/finance/invoices/:id/refunds', scoped('finance.refund.request'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = requestBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.some((i) => i.path[0] === 'reason') ? 'REASON_REQUIRED' : 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const invoice = await withTenant(tenantId, (ctx) => ctx.invoices.findOne({ _id: id }))
    if (!invoice) return reply.code(404).send({ error: 'UNKNOWN_INVOICE' })
    if (!(await callerCanUseBranch(request, invoice.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const allowedBranchIds = await callerBranchIds(request)

    const result = await transact(tenantId, async (ctx) => {
      const now = new Date()
      const doc: RefundDoc = {
        _id: randomUUID(),
        tenantId,
        refundNumber: await nextNumber(ctx, tenantId, 'refundNumber'),
        invoiceId: invoice._id,
        studentId: invoice.studentId,
        branchId: invoice.branchId,
        amount: parsed.data.amount,
        reason: parsed.data.reason,
        status: 'pending',
        requestedBy: request.auth!.sub,
        decidedBy: null,
        decidedAt: null,
        paidAt: null,
        paidBy: null,
        method: null,
        reference: null,
        createdAt: now,
        updatedAt: now,
      }
      await checkCap(ctx, doc)
      await ctx.refunds.insertOne(doc)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'refund.request',
        entity: 'refund',
        entityId: doc._id,
        branchId: doc.branchId,
        after: doc,
      })
      const approval = await insertRequest(ctx, {
        type: 'finance.refund',
        entityId: doc._id,
        payload: {},
        comment: parsed.data.reason,
        actorId: request.auth!.sub,
        allowedBranchIds,
      })
      if (!approval.ok) throw new FinanceAbort(approval.error)
      return { doc, approvalId: approval.request._id }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send({ ...refundResponse(result.doc, invoice.invoiceNumber), approvalId: result.approvalId })
  })

  app.post('/finance/refunds/:id/pay', scoped('finance.payout'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = payBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const existing = await withTenant(tenantId, (ctx) => ctx.refunds.findOne({ _id: id }))
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, existing.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    await ensureDefaults(tenantId, 'paymentMethod')
    const methods = await withTenant(tenantId, (ctx) => activeCodes(ctx, 'paymentMethod'))
    if (!methods.has(parsed.data.method)) return reply.code(400).send({ error: 'INVALID_PAYMENT_METHOD' })

    // SAMS 11.1: an online refund goes back to the card through the gateway
    // first; the refund is marked paid only if the gateway accepts it.
    let reference = parsed.data.reference
    if (parsed.data.method === 'online') {
      if (existing.status !== 'approved') return reply.code(409).send({ error: 'NOT_APPROVED' })
      const sent = await refundOnline(tenantId, existing, apiBaseOf(request))
      if (!sent.ok) return reply.code(502).send({ error: sent.error })
      reference = sent.refundRef
    }

    const result = await transact(tenantId, async (ctx) => {
      const refund = await ctx.refunds.findOne({ _id: id })
      if (!refund || refund.status !== 'approved') throw new FinanceAbort('NOT_APPROVED')
      // Payments may have been voided since the approval.
      await checkCap(ctx, refund)
      const now = new Date()
      const doc = await ctx.refunds.findOneAndUpdate(
        { _id: id, status: 'approved' },
        { $set: { status: 'paid', paidAt: parsed.data.paidAt, paidBy: request.auth!.sub, method: parsed.data.method, reference, updatedAt: now } },
        { returnDocument: 'after' },
      )
      if (!doc) throw new FinanceAbort('NOT_APPROVED')
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'refund.pay',
        entity: 'refund',
        entityId: id,
        branchId: doc.branchId,
        before: { status: 'approved' },
        after: { status: 'paid', paidAt: doc.paidAt, method: doc.method, reference: doc.reference },
      })
      await refreshStatus(ctx, doc.invoiceId)
      return doc
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(refundResponse(result))
  })

  // The requester (or an approvals.decide holder, through /approvals) may
  // withdraw a refund before it is paid out.
  app.post('/finance/refunds/:id/cancel', scoped('finance.refund.request'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const existing = await withTenant(tenantId, (ctx) => ctx.refunds.findOne({ _id: id }))
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, existing.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    if (existing.requestedBy !== request.auth!.sub) return reply.code(403).send({ error: 'NOT_REQUESTER' })
    const result = await transact(tenantId, async (ctx) => {
      const now = new Date()
      const doc = await ctx.refunds.findOneAndUpdate(
        { _id: id, status: { $in: IN_PROGRESS } },
        { $set: { status: 'cancelled', updatedAt: now } },
        { returnDocument: 'after' },
      )
      if (!doc) throw new FinanceAbort('NOT_CANCELLABLE')
      await cancelPendingFor(ctx, 'finance.refund', id, request.auth!.sub, 'Withdrawn by the requester')
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'refund.cancel',
        entity: 'refund',
        entityId: id,
        branchId: doc.branchId,
        before: { status: existing.status },
        after: { status: 'cancelled' },
      })
      return doc
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(refundResponse(result))
  })
}
