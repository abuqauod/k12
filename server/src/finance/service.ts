import { randomUUID } from 'node:crypto'
import type { Filter } from 'mongodb'
import type {
  DiscountType,
  InvoiceAdjustment,
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
import { oldestUnpaidDueDate } from './installments.js'
import { money } from '../records.js'
import { notifyFamilies, schoolName } from '../notifications/messages.js'
import { nextNumber } from '../numbering.js'

/**
 * Fee structures, invoices, payments and receipts — the Finance & Accounting
 * "core loop". Every function takes a live `TenantContext` (a `withTenant`
 * transaction), matching the convention in enrollments/service.ts and
 * parents/service.ts. Money is integer minor units throughout — see db.ts's
 * finance-section file comment for why.
 */

const today = () => new Date().toISOString().slice(0, 10)

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

/**
 * An invoice's total from its lines and adjustments (SAMS 3.2) — the one
 * place this is worked out. Adjustments apply in order to the lines' net
 * sum (a percent is of that sum); together they never take the total
 * below 0.
 */
export function price(
  lineItems: InvoiceLineItem[],
  adjustments: InvoiceAdjustment[] = [],
): { subtotal: number; total: number; adjustments: InvoiceAdjustment[] } {
  const subtotal = lineItems.reduce((sum, line) => sum + line.netAmount, 0)
  let left = subtotal
  const priced = adjustments.map((a) => {
    const want = a.type === 'percent' ? Math.round((subtotal * a.value) / 100) : a.value
    const amount = Math.min(left, want)
    left -= amount
    return { ...a, amount }
  })
  return { subtotal, total: left, adjustments: priced }
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

  // Approved scholarships for this student and year apply from the start.
  const now = new Date()
  const scholarships = await ctx.scholarships
    .find({ studentId: params.studentId, academicYearId: enrollment.academicYearId, status: 'active' })
    .sort({ decidedAt: 1 })
    .toArray()
  const priced = price(
    lineItems,
    scholarships.map((sch) => scholarshipAdjustment(sch, now, params.actorId)),
  )

  const invoice: InvoiceDoc = {
    _id: randomUUID(),
    tenantId,
    studentId: params.studentId,
    branchId: enrollment.branchId,
    academicYearId: enrollment.academicYearId,
    termId: null,
    feeStructureId: structure._id,
    invoiceNumber: await nextNumber(ctx, tenantId, 'invoiceNumber'),
    issueDate: today(),
    dueDate: params.dueDate ?? null,
    lineItems,
    ...(priced.adjustments.length > 0 ? { adjustments: priced.adjustments } : {}),
    total: priced.total,
    status: statusFromPaid(priced, 0),
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
    branchId: invoice.branchId,
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

  const priced = price(lineItems, before.adjustments)
  // A changed total can change the status too — a discount down to exactly
  // what was already paid makes the invoice paid.
  const status = statusFromPaid(priced, await paidTotalFor(ctx, invoiceId))
  const updated = await ctx.invoices.findOneAndUpdate(
    { _id: invoiceId },
    {
      $set: {
        lineItems,
        total: priced.total,
        ...(before.adjustments ? { adjustments: priced.adjustments } : {}),
        status,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  )
  await recordAudit(ctx.auditLog, {
    actorId,
    action,
    entity: 'invoice',
    entityId: invoiceId,
    branchId: before.branchId,
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
    /** Where a generated charge came from (e.g. `transport:<feeId>`), so it
     * is never added twice. */
    sourceFeeItemId?: string | null
  },
): Promise<LineItemResult> {
  return writeLineItems(ctx, invoiceId, params.actorId, 'invoice.lineItem.add', (before) => [
    ...before.lineItems,
    {
      id: randomUUID(),
      label: params.label,
      labelAr: params.labelAr,
      sourceFeeItemId: params.sourceFeeItemId ?? null,
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
    branchId: before.branchId,
    before,
    after: updated,
  })
  return { ok: true, invoice: updated! }
}

/** An invoice whose adjustments bring a non-empty bill to 0 is settled. */
export function statusFromPaid(priced: { subtotal: number; total: number }, paid: number): InvoiceStatus {
  if (priced.total <= 0 && priced.subtotal > 0) return 'paid'
  if (paid <= 0) return 'open'
  if (paid >= priced.total) return 'paid'
  return 'partially_paid'
}

/** Recomputes a (non-void) invoice's status after its payments, refunds or
 * adjustments changed. */
export async function refreshStatus(ctx: TenantContext, invoiceId: string): Promise<InvoiceDoc | null> {
  const invoice = await ctx.invoices.findOne({ _id: invoiceId })
  if (!invoice || invoice.status === 'void') return invoice
  const status = statusFromPaid(price(invoice.lineItems, invoice.adjustments), await paidTotalFor(ctx, invoiceId))
  if (status === invoice.status) return invoice
  return ctx.invoices.findOneAndUpdate({ _id: invoiceId }, { $set: { status, updatedAt: new Date() } }, { returnDocument: 'after' })
}

/** Payments that count toward what an invoice has been paid: not void, and
 * not waiting for (or refused) confirmation (SAMS 3.4). */
export const COUNTED: Filter<PaymentDoc> = { voidedAt: null, confirmation: { $nin: ['pending', 'rejected'] } }

/** What an invoice has been paid (counted payments less paid refunds). */
export const invoicePaidTotal = (ctx: TenantContext, invoiceId: string) => paidTotalFor(ctx, invoiceId)

async function paidTotalFor(ctx: TenantContext, invoiceId: string): Promise<number> {
  return (await invoicePaidTotals(ctx, [invoiceId])).get(invoiceId) ?? 0
}

/** What each invoice has been paid, batched: counted payments less paid
 * refunds (SAMS 3.3). The one definition every balance uses. */
export async function invoicePaidTotals(ctx: TenantContext, invoiceIds: string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>()
  if (invoiceIds.length === 0) return totals
  const [payments, refunds] = await Promise.all([
    ctx.payments.find({ invoiceId: { $in: invoiceIds }, ...COUNTED }).toArray(),
    ctx.refunds.find({ invoiceId: { $in: invoiceIds }, status: 'paid' }).toArray(),
  ])
  for (const p of payments) totals.set(p.invoiceId, (totals.get(p.invoiceId) ?? 0) + p.amount)
  for (const r of refunds) totals.set(r.invoiceId, (totals.get(r.invoiceId) ?? 0) - r.amount)
  return totals
}

/** An approved scholarship as an invoice adjustment. */
export function scholarshipAdjustment(
  sch: { _id: string; name: string; type: DiscountType; value: number },
  at: Date,
  actorId: string | null,
): InvoiceAdjustment {
  return { id: randomUUID(), source: 'scholarship', refId: sch._id, label: sch.name, type: sch.type, value: sch.value, amount: 0, appliedAt: at, appliedBy: actorId }
}

/** Replaces an invoice's adjustments and re-prices it (SAMS 3.2). */
export async function setAdjustments(
  ctx: TenantContext,
  invoice: InvoiceDoc,
  adjustments: InvoiceAdjustment[],
  audit: { actorId: string | null; action: string },
): Promise<InvoiceDoc> {
  const priced = price(invoice.lineItems, adjustments)
  const status = statusFromPaid(priced, await paidTotalFor(ctx, invoice._id))
  const updated = await ctx.invoices.findOneAndUpdate(
    { _id: invoice._id },
    { $set: { adjustments: priced.adjustments, total: priced.total, status, updatedAt: new Date() } },
    { returnDocument: 'after' },
  )
  await recordAudit(ctx.auditLog, {
    actorId: audit.actorId,
    action: audit.action,
    entity: 'invoice',
    entityId: invoice._id,
    branchId: invoice.branchId,
    before: { adjustments: invoice.adjustments ?? [], total: invoice.total },
    after: { adjustments: priced.adjustments, total: priced.total },
  })
  return updated!
}

export interface PaymentInput {
  method: PaymentMethod
  reference: string | null
  paidAt: string
  payerName: string
  notes: string | null
  /** SAMS 3.4: wait for confirmation (a cheque or transfer not yet cleared). */
  awaitingConfirmation?: boolean
  actorId: string | null
}

export type RecordPaymentsResult =
  | { ok: true; payments: PaymentDoc[]; receipt: ReceiptDoc | null; invoices: InvoiceDoc[] }
  | { ok: false; error: 'UNKNOWN_INVOICE' | 'INVOICE_VOID' | 'INVOICE_OTHER_STUDENT' | 'DUPLICATE_ALLOCATION' }

/**
 * Records one amount taken from a payer, spread over one or more of a
 * student's invoices (SAMS 3.4): one payment row per invoice, sharing a
 * `batchId`, and one receipt listing the split. A payment awaiting
 * confirmation gets its receipt when it is confirmed. Checking the split
 * against what is outstanding is the caller's job (`allocate`); the
 * single-invoice route allows over-payment, as it always has.
 */
export async function recordPayments(
  ctx: TenantContext,
  tenantId: string,
  params: PaymentInput & { studentId: string | null; allocations: { invoiceId: string; amount: number }[] },
): Promise<RecordPaymentsResult> {
  const ids = params.allocations.map((a) => a.invoiceId)
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'DUPLICATE_ALLOCATION' }
  const invoices = await ctx.invoices.find({ _id: { $in: ids } }).toArray()
  const byId = new Map(invoices.map((i) => [i._id, i]))
  for (const id of ids) {
    const invoice = byId.get(id)
    if (!invoice) return { ok: false, error: 'UNKNOWN_INVOICE' }
    if (invoice.status === 'void') return { ok: false, error: 'INVOICE_VOID' }
    if (params.studentId !== null && invoice.studentId !== params.studentId) return { ok: false, error: 'INVOICE_OTHER_STUDENT' }
  }
  const studentId = byId.get(ids[0]!)!.studentId
  if (invoices.some((i) => i.studentId !== studentId)) return { ok: false, error: 'INVOICE_OTHER_STUDENT' }

  const link = await ctx.parentStudentLinks.findOne({ studentId, financialResponsibility: true, active: true })
  const now = new Date()
  const batchId = randomUUID()
  const pending = params.awaitingConfirmation === true
  const payments: PaymentDoc[] = params.allocations.map((a) => ({
    _id: randomUUID(),
    tenantId,
    invoiceId: a.invoiceId,
    studentId,
    amount: a.amount,
    method: params.method,
    reference: params.reference,
    paidAt: params.paidAt,
    payerName: params.payerName,
    payerParentId: link?.parentId ?? null,
    notes: params.notes,
    receivedBy: params.actorId,
    batchId,
    confirmation: pending ? 'pending' : 'confirmed',
    confirmedAt: pending ? null : now,
    confirmedBy: pending ? null : params.actorId,
    createdAt: now,
    voidedAt: null,
    voidedBy: null,
  }))
  for (const payment of payments) await ctx.payments.insertOne(payment)
  for (const payment of payments) {
    await recordAudit(ctx.auditLog, {
      actorId: params.actorId,
      action: 'payment.record',
      entity: 'payment',
      entityId: payment._id,
      branchId: byId.get(payment.invoiceId)!.branchId,
      before: null,
      after: payment,
    })
  }
  const receipt = pending ? null : await issueReceipt(ctx, tenantId, payments, byId, params.actorId)
  const updated: InvoiceDoc[] = []
  for (const id of ids) updated.push((await refreshStatus(ctx, id))!)
  return { ok: true, payments, receipt, invoices: updated }
}

async function issueReceipt(
  ctx: TenantContext,
  tenantId: string,
  payments: PaymentDoc[],
  invoices: Map<string, InvoiceDoc>,
  actorId: string | null,
): Promise<ReceiptDoc> {
  const first = payments[0]!
  const receipt: ReceiptDoc = {
    _id: randomUUID(),
    tenantId,
    paymentId: first._id,
    invoiceId: first.invoiceId,
    studentId: first.studentId,
    receiptNumber: await nextNumber(ctx, tenantId, 'receiptNumber'),
    amount: payments.reduce((sum, p) => sum + p.amount, 0),
    method: first.method,
    payerName: first.payerName,
    issueDate: first.paidAt,
    allocations: payments.map((p) => ({
      paymentId: p._id,
      invoiceId: p.invoiceId,
      invoiceNumber: invoices.get(p.invoiceId)?.invoiceNumber ?? '',
      amount: p.amount,
    })),
    createdAt: new Date(),
    createdBy: actorId,
  }
  await ctx.receipts.insertOne(receipt)
  // SAMS 6.3: the paying family hears it arrived.
  const school = await schoolName(tenantId)
  await notifyFamilies(ctx, tenantId, {
    kind: 'payment_received',
    sourceId: receipt._id,
    studentIds: [receipt.studentId],
    recipients: 'financial',
    tokens: (student, parent) => ({
      parentName: parent.fullName,
      studentName: `${student.givenName} ${student.familyName}`.trim(),
      amount: money(receipt.amount),
      receiptNumber: receipt.receiptNumber,
      schoolName: school,
    }),
    link: (studentId) => `/portal/children/${studentId}?tab=finance`,
    trigger: 'manual',
    actorId,
  })
  await recordAudit(ctx.auditLog, {
    actorId,
    action: 'receipt.issue',
    entity: 'receipt',
    entityId: receipt._id,
    branchId: invoices.get(first.invoiceId)?.branchId ?? null,
    before: null,
    after: receipt,
  })
  return receipt
}

export type RecordPaymentResult =
  | { ok: true; payment: PaymentDoc; receipt: ReceiptDoc | null; invoice: InvoiceDoc }
  | { ok: false; error: 'UNKNOWN_INVOICE' | 'INVOICE_VOID' }

/** One payment against one invoice. Over-payment is allowed (it leaves a
 * credit, i.e. a negative outstanding balance). */
export async function recordPayment(
  ctx: TenantContext,
  tenantId: string,
  params: PaymentInput & { invoiceId: string; amount: number },
): Promise<RecordPaymentResult> {
  const res = await recordPayments(ctx, tenantId, {
    ...params,
    studentId: null,
    allocations: [{ invoiceId: params.invoiceId, amount: params.amount }],
  })
  if (!res.ok) return { ok: false, error: res.error === 'INVOICE_VOID' ? 'INVOICE_VOID' : 'UNKNOWN_INVOICE' }
  return { ok: true, payment: res.payments[0]!, receipt: res.receipt, invoice: res.invoices[0]! }
}

export interface OpenInvoice {
  invoice: InvoiceDoc
  /** Counted payments less paid refunds (`invoicePaidTotals`). */
  paid: number
  /** Total less counted payments, paid refunds and payments awaiting
   * confirmation — what a new payment may still cover. */
  outstanding: number
}

/** A student's invoices with something left to pay, oldest due first
 * (earliest unpaid installment or due date, then issue date). */
export async function openInvoices(ctx: TenantContext, studentId: string): Promise<OpenInvoice[]> {
  const invoices = await ctx.invoices.find({ studentId, status: { $in: ['open', 'partially_paid'] } }).toArray()
  const ids = invoices.map((i) => i._id)
  const [paid, waiting] = await Promise.all([
    invoicePaidTotals(ctx, ids),
    ctx.payments.find({ invoiceId: { $in: ids }, voidedAt: null, confirmation: 'pending' }).toArray(),
  ])
  const pendingBy = new Map<string, number>()
  for (const p of waiting) pendingBy.set(p.invoiceId, (pendingBy.get(p.invoiceId) ?? 0) + p.amount)
  const today = new Date().toISOString().slice(0, 10)
  const due = (i: InvoiceDoc) => oldestUnpaidDueDate(i, paid.get(i._id) ?? 0, today) ?? i.dueDate ?? '9999-12-31'
  return invoices
    .map((invoice) => ({
      invoice,
      paid: paid.get(invoice._id) ?? 0,
      outstanding: invoice.total - (paid.get(invoice._id) ?? 0) - (pendingBy.get(invoice._id) ?? 0),
    }))
    .filter((o) => o.outstanding > 0)
    .sort((a, b) => due(a.invoice).localeCompare(due(b.invoice)) || a.invoice.issueDate.localeCompare(b.invoice.issueDate))
}

export type AllocateResult =
  | { ok: true; allocations: { invoiceId: string; amount: number }[] }
  | { ok: false; error: 'AMOUNT_EXCEEDS_OUTSTANDING' | 'ALLOCATION_EXCEEDS_OUTSTANDING' | 'ALLOCATION_MISMATCH' | 'NOTHING_OUTSTANDING'; outstanding: number }

/** Splits `amount` over a student's open invoices: as given (each part at
 * most that invoice's outstanding, parts adding up to the amount), or
 * oldest due first. Never more than is outstanding in total. */
export function allocate(
  open: OpenInvoice[],
  amount: number,
  requested?: { invoiceId: string; amount: number }[],
): AllocateResult {
  const outstanding = open.reduce((sum, o) => sum + o.outstanding, 0)
  if (outstanding <= 0) return { ok: false, error: 'NOTHING_OUTSTANDING', outstanding: 0 }
  if (requested) {
    const byId = new Map(open.map((o) => [o.invoice._id, o.outstanding]))
    if (requested.reduce((sum, a) => sum + a.amount, 0) !== amount) return { ok: false, error: 'ALLOCATION_MISMATCH', outstanding }
    for (const a of requested) {
      if (a.amount > (byId.get(a.invoiceId) ?? 0)) return { ok: false, error: 'ALLOCATION_EXCEEDS_OUTSTANDING', outstanding }
    }
    return { ok: true, allocations: requested.filter((a) => a.amount > 0) }
  }
  if (amount > outstanding) return { ok: false, error: 'AMOUNT_EXCEEDS_OUTSTANDING', outstanding }
  let left = amount
  const allocations: { invoiceId: string; amount: number }[] = []
  for (const o of open) {
    if (left <= 0) break
    const part = Math.min(left, o.outstanding)
    allocations.push({ invoiceId: o.invoice._id, amount: part })
    left -= part
  }
  return { ok: true, allocations }
}

export type ConfirmResult =
  | { ok: true; payments: PaymentDoc[]; receipt: ReceiptDoc | null; invoices: InvoiceDoc[] }
  | { ok: false; error: 'UNKNOWN_PAYMENT' | 'NOT_PENDING' }

/** Confirms or rejects a payment awaiting confirmation, together with the
 * rest of its batch (SAMS 3.4). Confirming issues the receipt; a rejected
 * (bounced) payment never counts. */
export async function decidePayment(
  ctx: TenantContext,
  tenantId: string,
  paymentId: string,
  params: { confirm: boolean; actorId: string | null },
): Promise<ConfirmResult> {
  const payment = await ctx.payments.findOne({ _id: paymentId })
  if (!payment) return { ok: false, error: 'UNKNOWN_PAYMENT' }
  if (payment.confirmation !== 'pending' || payment.voidedAt) return { ok: false, error: 'NOT_PENDING' }
  const batch = payment.batchId
    ? await ctx.payments.find({ batchId: payment.batchId, confirmation: 'pending', voidedAt: null }).toArray()
    : [payment]
  const now = new Date()
  const to = params.confirm ? 'confirmed' : 'rejected'
  await ctx.payments.updateMany(
    { _id: { $in: batch.map((p) => p._id) }, confirmation: 'pending' },
    { $set: { confirmation: to, confirmedAt: now, confirmedBy: params.actorId } },
  )
  const invoices = await ctx.invoices.find({ _id: { $in: batch.map((p) => p.invoiceId) } }).toArray()
  const byId = new Map(invoices.map((i) => [i._id, i]))
  for (const p of batch) {
    await recordAudit(ctx.auditLog, {
      actorId: params.actorId,
      action: params.confirm ? 'payment.confirm' : 'payment.reject',
      entity: 'payment',
      entityId: p._id,
      branchId: byId.get(p.invoiceId)?.branchId ?? null,
      before: { confirmation: 'pending' },
      after: { confirmation: to },
    })
  }
  const confirmed = batch.map((p) => ({ ...p, confirmation: to, confirmedAt: now, confirmedBy: params.actorId }) as PaymentDoc)
  const receipt = params.confirm ? await issueReceipt(ctx, tenantId, confirmed, byId, params.actorId) : null
  const updated: InvoiceDoc[] = []
  for (const id of new Set(batch.map((p) => p.invoiceId))) {
    const inv = await refreshStatus(ctx, id)
    if (inv) updated.push(inv)
  }
  return { ok: true, payments: confirmed, receipt, invoices: updated }
}

export type VoidPaymentResult =
  | { ok: true; payment: PaymentDoc; invoice: InvoiceDoc }
  | { ok: false; error: 'UNKNOWN_PAYMENT' }

/** Reverses a mis-recorded payment — voided, never edited or deleted, so
 * the audit trail always shows what was really entered. This undoes the
 * bookkeeping entry; money actually handed back is a refund (SAMS 3.3). */
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
  const invoice = await ctx.invoices.findOne({ _id: before.invoiceId })
  await recordAudit(ctx.auditLog, {
    actorId,
    action: 'payment.void',
    entity: 'payment',
    entityId: paymentId,
    branchId: invoice?.branchId ?? null,
    before,
    after: updated,
  })
  const updatedInvoice = await refreshStatus(ctx, before.invoiceId)
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
 * invoices, then `invoicePaidTotals`, grouped in memory.
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
  const paidByInvoice = await invoicePaidTotals(ctx, invoices.map((inv) => inv._id))

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

export interface ChargeResult {
  charged: { studentId: string; invoiceId: string; amount: number }[]
  /** Already carrying this charge. */
  alreadyCharged: string[]
  /** No non-void invoice for the year to add it to. */
  noInvoice: string[]
}

/**
 * Adds one charge line to each student's invoice for a year (SAMS 5.4
 * transport fees, 5.6 event fees): the most recent non-void invoice of that
 * student and year. A line with the same `sourceFeeItemId` is never added
 * twice, so running it again only charges newcomers.
 */
export async function chargeStudents(
  ctx: TenantContext,
  params: {
    academicYearId: string
    charges: { studentId: string; amount: number }[]
    label: string
    labelAr: string | null
    sourceFeeItemId: string
    actorId: string | null
  },
): Promise<ChargeResult> {
  const result: ChargeResult = { charged: [], alreadyCharged: [], noInvoice: [] }
  const invoices = await ctx.invoices
    .find({ studentId: { $in: params.charges.map((c) => c.studentId) }, academicYearId: params.academicYearId, status: { $ne: 'void' } })
    .sort({ issueDate: -1, createdAt: -1 })
    .toArray()
  for (const charge of params.charges) {
    const mine = invoices.filter((i) => i.studentId === charge.studentId)
    if (mine.some((i) => i.lineItems.some((l) => l.sourceFeeItemId === params.sourceFeeItemId))) {
      result.alreadyCharged.push(charge.studentId)
      continue
    }
    const target = mine[0]
    if (!target || charge.amount <= 0) {
      if (!target) result.noInvoice.push(charge.studentId)
      continue
    }
    const res = await addLineItem(ctx, target._id, {
      label: params.label,
      labelAr: params.labelAr,
      amount: charge.amount,
      discount: null,
      actorId: params.actorId,
      sourceFeeItemId: params.sourceFeeItemId,
    })
    if (res.ok) result.charged.push({ studentId: charge.studentId, invoiceId: target._id, amount: charge.amount })
  }
  return result
}
