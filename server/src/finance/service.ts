import { randomUUID } from 'node:crypto'
import type {
  DiscountType,
  InvoiceDoc,
  InvoiceLineItem,
  InvoiceStatus,
  PaymentDoc,
  PaymentMethod,
  ReceiptDoc,
  TenantContext,
} from '../db.js'
import { activeEnrollment } from '../enrollments/service.js'
import { recordAudit } from '../audit.js'

/**
 * Fee structures, invoices, payments and receipts — the Finance & Accounting
 * "core loop". Every function takes a live `TenantContext` (a `withTenant`
 * transaction), matching the convention in enrollments/service.ts and
 * parents/service.ts. Money is integer minor units throughout — see db.ts's
 * finance-section file comment for why.
 */

const today = () => new Date().toISOString().slice(0, 10)

async function nextSequence(
  ctx: TenantContext,
  tenantId: string,
  kind: 'invoiceNumber' | 'receiptNumber',
): Promise<number> {
  const updated = await ctx.financeCounters.findOneAndUpdate(
    { _id: `${tenantId}:${kind}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  )
  return updated!.seq
}

/** The one place discount math happens — called by both invoice generation
 * and every line-item write, so it is never duplicated. Floored at 0: a
 * discount can reduce a line to free, never negative. */
export function computeLineNet(
  amount: number,
  discount: { type: DiscountType; value: number } | null,
): number {
  if (!discount) return amount
  const reduction = discount.type === 'percent' ? Math.round((amount * discount.value) / 100) : discount.value
  return Math.max(0, amount - reduction)
}

function recomputeTotal(lineItems: InvoiceLineItem[]): number {
  return lineItems.reduce((sum, line) => sum + line.netAmount, 0)
}

export type GenerateInvoiceResult =
  | { ok: true; invoice: InvoiceDoc }
  | { ok: false; error: 'UNKNOWN_STUDENT' | 'NOT_ENROLLED' | 'UNKNOWN_FEE_STRUCTURE' | 'FEE_STRUCTURE_BRANCH_MISMATCH' }

/**
 * Generates an invoice for a student from a fee structure. The structure's
 * `branchId`/`academicYearId` must match the student's active enrollment —
 * hard error on mismatch, since billing a student against another branch's
 * or year's price list is very likely a mistake. `gradeLevel` mismatch is
 * NOT blocked (a held-back or accelerated student legitimately may not
 * match the structure's nominal grade).
 */
export async function generateInvoice(
  ctx: TenantContext,
  tenantId: string,
  params: {
    studentId: string
    feeStructureId: string
    dueDate?: string | null
    notes?: string | null
    actorId: string | null
  },
): Promise<GenerateInvoiceResult> {
  const student = await ctx.students.findOne({ _id: params.studentId })
  if (!student) return { ok: false, error: 'UNKNOWN_STUDENT' }
  const enrollment = await activeEnrollment(ctx, params.studentId)
  if (!enrollment) return { ok: false, error: 'NOT_ENROLLED' }

  const structure = await ctx.feeStructures.findOne({ _id: params.feeStructureId, active: true })
  if (!structure) return { ok: false, error: 'UNKNOWN_FEE_STRUCTURE' }
  if (structure.branchId !== enrollment.branchId || structure.academicYearId !== enrollment.academicYearId) {
    return { ok: false, error: 'FEE_STRUCTURE_BRANCH_MISMATCH' }
  }

  const lineItems: InvoiceLineItem[] = structure.lineItems.map((item) => ({
    id: randomUUID(),
    label: item.label,
    labelAr: item.labelAr,
    sourceFeeItemId: item.id,
    amount: item.amount,
    discount: null,
    netAmount: item.amount,
  }))

  const seq = await nextSequence(ctx, tenantId, 'invoiceNumber')
  const now = new Date()
  const invoice: InvoiceDoc = {
    _id: randomUUID(),
    tenantId,
    studentId: params.studentId,
    branchId: enrollment.branchId,
    academicYearId: enrollment.academicYearId,
    termId: null,
    feeStructureId: structure._id,
    invoiceNumber: `INV-${String(seq).padStart(6, '0')}`,
    issueDate: today(),
    dueDate: params.dueDate ?? null,
    lineItems,
    total: recomputeTotal(lineItems),
    status: 'open',
    notes: params.notes ?? null,
    createdAt: now,
    updatedAt: now,
    createdBy: params.actorId,
    voidedAt: null,
    voidedBy: null,
  }
  await ctx.invoices.insertOne(invoice)
  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'invoice.generate',
    entity: 'invoice',
    entityId: invoice._id,
    before: null,
    after: invoice,
  })
  return { ok: true, invoice }
}

export type LineItemResult =
  | { ok: true; invoice: InvoiceDoc }
  | { ok: false; error: 'UNKNOWN_INVOICE' | 'INVOICE_VOID' | 'UNKNOWN_LINE_ITEM' }

async function writeLineItems(
  ctx: TenantContext,
  invoiceId: string,
  actorId: string | null,
  action: string,
  build: (before: InvoiceDoc) => InvoiceLineItem[] | null,
): Promise<LineItemResult> {
  const before = await ctx.invoices.findOne({ _id: invoiceId })
  if (!before) return { ok: false, error: 'UNKNOWN_INVOICE' }
  if (before.status === 'void') return { ok: false, error: 'INVOICE_VOID' }
  const lineItems = build(before)
  if (!lineItems) return { ok: false, error: 'UNKNOWN_LINE_ITEM' }

  const total = recomputeTotal(lineItems)
  const updated = await ctx.invoices.findOneAndUpdate(
    { _id: invoiceId },
    { $set: { lineItems, total, updatedAt: new Date() } },
    { returnDocument: 'after' },
  )
  await recordAudit(ctx.auditLog, {
    actorId,
    action,
    entity: 'invoice',
    entityId: invoiceId,
    before,
    after: updated,
  })
  return { ok: true, invoice: updated! }
}

export function addLineItem(
  ctx: TenantContext,
  invoiceId: string,
  params: {
    label: string
    labelAr: string | null
    amount: number
    discount: { type: DiscountType; value: number } | null
    actorId: string | null
  },
): Promise<LineItemResult> {
  return writeLineItems(ctx, invoiceId, params.actorId, 'invoice.lineItem.add', (before) => [
    ...before.lineItems,
    {
      id: randomUUID(),
      label: params.label,
      labelAr: params.labelAr,
      sourceFeeItemId: null,
      amount: params.amount,
      discount: params.discount,
      netAmount: computeLineNet(params.amount, params.discount),
    },
  ])
}

export function updateLineItem(
  ctx: TenantContext,
  invoiceId: string,
  lineItemId: string,
  params: {
    label?: string
    labelAr?: string | null
    amount?: number
    discount?: { type: DiscountType; value: number } | null
    actorId: string | null
  },
): Promise<LineItemResult> {
  return writeLineItems(ctx, invoiceId, params.actorId, 'invoice.lineItem.update', (before) => {
    if (!before.lineItems.some((l) => l.id === lineItemId)) return null
    return before.lineItems.map((line) => {
      if (line.id !== lineItemId) return line
      const amount = params.amount ?? line.amount
      const discount = params.discount !== undefined ? params.discount : line.discount
      return {
        ...line,
        label: params.label ?? line.label,
        labelAr: params.labelAr !== undefined ? params.labelAr : line.labelAr,
        amount,
        discount,
        netAmount: computeLineNet(amount, discount),
      }
    })
  })
}

export function removeLineItem(
  ctx: TenantContext,
  invoiceId: string,
  lineItemId: string,
  actorId: string | null,
): Promise<LineItemResult> {
  return writeLineItems(ctx, invoiceId, actorId, 'invoice.lineItem.remove', (before) => {
    if (!before.lineItems.some((l) => l.id === lineItemId)) return null
    return before.lineItems.filter((line) => line.id !== lineItemId)
  })
}

export type VoidInvoiceResult = { ok: true; invoice: InvoiceDoc } | { ok: false; error: 'UNKNOWN_INVOICE' }

export async function voidInvoice(
  ctx: TenantContext,
  invoiceId: string,
  actorId: string | null,
): Promise<VoidInvoiceResult> {
  const before = await ctx.invoices.findOne({ _id: invoiceId })
  if (!before) return { ok: false, error: 'UNKNOWN_INVOICE' }
  const now = new Date()
  const updated = await ctx.invoices.findOneAndUpdate(
    { _id: invoiceId },
    { $set: { status: 'void', voidedAt: now, voidedBy: actorId, updatedAt: now } },
    { returnDocument: 'after' },
  )
  await recordAudit(ctx.auditLog, {
    actorId,
    action: 'invoice.void',
    entity: 'invoice',
    entityId: invoiceId,
    before,
    after: updated,
  })
  return { ok: true, invoice: updated! }
}

function statusFromPaid(total: number, paid: number): InvoiceStatus {
  if (paid <= 0) return 'open'
  if (paid >= total) return 'paid'
  return 'partially_paid'
}

async function paidTotalFor(ctx: TenantContext, invoiceId: string): Promise<number> {
  const rows = await ctx.payments.find({ invoiceId, voidedAt: null }).toArray()
  return rows.reduce((sum, p) => sum + p.amount, 0)
}

export type RecordPaymentResult =
  | { ok: true; payment: PaymentDoc; receipt: ReceiptDoc; invoice: InvoiceDoc }
  | { ok: false; error: 'UNKNOWN_INVOICE' | 'INVOICE_VOID' }

/**
 * Records a payment against an invoice and issues its receipt in the same
 * step — a receipt is never created standalone (db.ts's ReceiptDoc comment).
 * Over-payment is allowed (simply leaves a negative outstanding balance) —
 * no installment-plan enforcement, that's out of this PR's scope.
 */
export async function recordPayment(
  ctx: TenantContext,
  tenantId: string,
  params: {
    invoiceId: string
    amount: number
    method: PaymentMethod
    reference: string | null
    paidAt: string
    payerName: string
    notes: string | null
    actorId: string | null
  },
): Promise<RecordPaymentResult> {
  const invoice = await ctx.invoices.findOne({ _id: params.invoiceId })
  if (!invoice) return { ok: false, error: 'UNKNOWN_INVOICE' }
  if (invoice.status === 'void') return { ok: false, error: 'INVOICE_VOID' }

  const link = await ctx.parentStudentLinks.findOne({
    studentId: invoice.studentId,
    financialResponsibility: true,
    active: true,
  })

  const now = new Date()
  const payment: PaymentDoc = {
    _id: randomUUID(),
    tenantId,
    invoiceId: invoice._id,
    studentId: invoice.studentId,
    amount: params.amount,
    method: params.method,
    reference: params.reference,
    paidAt: params.paidAt,
    payerName: params.payerName,
    payerParentId: link?.parentId ?? null,
    notes: params.notes,
    receivedBy: params.actorId,
    createdAt: now,
    voidedAt: null,
    voidedBy: null,
  }
  await ctx.payments.insertOne(payment)

  const paid = await paidTotalFor(ctx, invoice._id)
  const updatedInvoice = await ctx.invoices.findOneAndUpdate(
    { _id: invoice._id },
    { $set: { status: statusFromPaid(invoice.total, paid), updatedAt: now } },
    { returnDocument: 'after' },
  )

  const seq = await nextSequence(ctx, tenantId, 'receiptNumber')
  const receipt: ReceiptDoc = {
    _id: randomUUID(),
    tenantId,
    paymentId: payment._id,
    invoiceId: invoice._id,
    studentId: invoice.studentId,
    receiptNumber: `RCT-${String(seq).padStart(6, '0')}`,
    amount: payment.amount,
    method: payment.method,
    payerName: payment.payerName,
    issueDate: payment.paidAt,
    createdAt: now,
    createdBy: params.actorId,
  }
  await ctx.receipts.insertOne(receipt)

  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'payment.record',
    entity: 'payment',
    entityId: payment._id,
    before: null,
    after: payment,
  })
  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'receipt.issue',
    entity: 'receipt',
    entityId: receipt._id,
    before: null,
    after: receipt,
  })

  return { ok: true, payment, receipt, invoice: updatedInvoice! }
}

export type VoidPaymentResult =
  | { ok: true; payment: PaymentDoc; invoice: InvoiceDoc }
  | { ok: false; error: 'UNKNOWN_PAYMENT' }

/** Reverses a mis-recorded payment — voided, never edited or deleted, so
 * the audit trail always shows what was really entered. No refund flow
 * exists (out of scope): this only undoes the bookkeeping entry, it does
 * not represent money actually returned to anyone. */
export async function voidPayment(
  ctx: TenantContext,
  paymentId: string,
  actorId: string | null,
): Promise<VoidPaymentResult> {
  const before = await ctx.payments.findOne({ _id: paymentId })
  if (!before) return { ok: false, error: 'UNKNOWN_PAYMENT' }
  const now = new Date()
  const updated = await ctx.payments.findOneAndUpdate(
    { _id: paymentId },
    { $set: { voidedAt: now, voidedBy: actorId } },
    { returnDocument: 'after' },
  )
  await recordAudit(ctx.auditLog, {
    actorId,
    action: 'payment.void',
    entity: 'payment',
    entityId: paymentId,
    before,
    after: updated,
  })

  const paid = await paidTotalFor(ctx, before.invoiceId)
  const invoice = await ctx.invoices.findOne({ _id: before.invoiceId })
  const updatedInvoice = invoice
    ? await ctx.invoices.findOneAndUpdate(
        { _id: before.invoiceId },
        invoice.status === 'void'
          ? { $set: { updatedAt: now } }
          : { $set: { status: statusFromPaid(invoice.total, paid), updatedAt: now } },
        { returnDocument: 'after' },
      )
    : null

  return { ok: true, payment: updated!, invoice: updatedInvoice! }
}

export interface StudentBalance {
  invoicedTotal: number
  paidTotal: number
  outstandingBalance: number
}

/**
 * The one place outstanding balance is computed — everything that shows a
 * balance (parents/service.ts's composeLinkedStudents, the student billing
 * section) calls this rather than re-deriving it. Batched: one query over
 * invoices, one over their payments, grouped in memory.
 */
export async function computeStudentBalances(
  ctx: TenantContext,
  studentIds: string[],
): Promise<Map<string, StudentBalance>> {
  const result = new Map<string, StudentBalance>()
  if (studentIds.length === 0) return result

  const invoices = await ctx.invoices
    .find({ studentId: { $in: studentIds }, status: { $ne: 'void' } })
    .toArray()
  const invoiceIds = invoices.map((inv) => inv._id)
  const payments =
    invoiceIds.length > 0
      ? await ctx.payments.find({ invoiceId: { $in: invoiceIds }, voidedAt: null }).toArray()
      : []
  const paidByInvoice = new Map<string, number>()
  for (const payment of payments) {
    paidByInvoice.set(payment.invoiceId, (paidByInvoice.get(payment.invoiceId) ?? 0) + payment.amount)
  }

  for (const studentId of studentIds) result.set(studentId, { invoicedTotal: 0, paidTotal: 0, outstandingBalance: 0 })
  for (const invoice of invoices) {
    const bucket = result.get(invoice.studentId)!
    const paidForInvoice = paidByInvoice.get(invoice._id) ?? 0
    bucket.invoicedTotal += invoice.total
    bucket.paidTotal += paidForInvoice
    bucket.outstandingBalance = bucket.invoicedTotal - bucket.paidTotal
  }
  return result
}
