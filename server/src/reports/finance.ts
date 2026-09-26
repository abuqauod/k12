import type { Filter } from 'mongodb'
import type { ExpenseDoc, InvoiceDoc, PaymentDoc, RefundDoc, TenantContext } from '../db.js'
import { invoicePaidTotals } from '../finance/service.js'
import { installmentViews } from '../finance/installments.js'
import { daysBetween, inBranches } from './common.js'

/**
 * SAMS 7.1: the finance figures every screen and report uses. The finance
 * summary (3.6), the dashboard's receivables, and the catalog's finance
 * reports all come from here, so "outstanding" or "overdue" means the same
 * number everywhere. Built on finance's own definitions: counted payments,
 * `invoicePaidTotals` (payments less paid refunds) and the installment
 * views.
 */

export const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const
export type Bucket = (typeof BUCKETS)[number]

export function bucketFor(dueDate: string | null, today: string): Bucket {
  if (!dueDate || dueDate >= today) return 'current'
  const days = daysBetween(dueDate, today)
  return days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus'
}

export interface FinanceScope {
  branchIds: string[] | null
  academicYearId?: string | null
  /** Only these students' invoices (a grade or class filter). */
  studentIds?: string[] | null
}

const invoiceFilter = (scope: FinanceScope): Filter<InvoiceDoc> => ({
  ...inBranches(scope.branchIds),
  ...(scope.academicYearId ? { academicYearId: scope.academicYearId } : {}),
  ...(scope.studentIds ? { studentId: { $in: scope.studentIds } } : {}),
})

// ---------------------------------------------------------- receivables --

export interface Receivable {
  invoice: InvoiceDoc
  paid: number
  outstanding: number
  /** Past due and unpaid today. */
  overdue: number
  oldestDueDate: string | null
  daysOverdue: number
  /** Where the unpaid amount sits by age (per installment with a plan). */
  buckets: Record<Bucket, number>
}

/** Every open or part-paid invoice in scope, with what is left on it and
 * how late, as of `today`. */
export async function receivables(ctx: TenantContext, scope: FinanceScope, today: string): Promise<Receivable[]> {
  const unpaid = await ctx.invoices.find({ ...invoiceFilter(scope), status: { $in: ['open', 'partially_paid'] } }).toArray()
  const paidTotals = await invoicePaidTotals(
    ctx,
    unpaid.map((i) => i._id),
  )
  const out: Receivable[] = []
  for (const invoice of unpaid) {
    const paid = paidTotals.get(invoice._id) ?? 0
    const parts =
      (invoice.installments ?? []).length > 0
        ? installmentViews(invoice.installments!, paid, today).map((v) => ({ dueDate: v.dueDate, left: v.amount - v.paid }))
        : [{ dueDate: invoice.dueDate, left: invoice.total - paid }]
    const buckets: Record<Bucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }
    let overdue = 0
    let oldest: string | null = null
    for (const part of parts) {
      if (part.left <= 0) continue
      const bucket = bucketFor(part.dueDate, today)
      buckets[bucket] += part.left
      if (bucket !== 'current') {
        overdue += part.left
        if (!oldest || part.dueDate! < oldest) oldest = part.dueDate
      }
    }
    out.push({
      invoice,
      paid,
      outstanding: invoice.total - paid,
      overdue,
      oldestDueDate: oldest,
      daysOverdue: oldest ? daysBetween(oldest, today) : 0,
      buckets,
    })
  }
  return out
}

export function agingTotals(rows: Receivable[]) {
  const aging: Record<Bucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }
  for (const r of rows) for (const b of BUCKETS) aging[b] += r.buckets[b]
  return { ...aging, total: BUCKETS.reduce((s, b) => s + aging[b], 0) }
}

// ----------------------------------------------------------- collections --

/** Payments received in the range on invoices in scope (not voided or
 * rejected); `pending` ones are still waiting for confirmation. */
export async function paymentsInRange(
  ctx: TenantContext,
  scope: FinanceScope,
  from: string,
  to: string,
): Promise<{ payments: PaymentDoc[]; invoices: Map<string, InvoiceDoc> }> {
  // Payments carry no branch: take them in the range, then keep those whose
  // invoice is in scope.
  const payments = await ctx.payments
    .find({
      voidedAt: null,
      paidAt: { $gte: from, $lte: to },
      confirmation: { $ne: 'rejected' },
      ...(scope.studentIds ? { studentId: { $in: scope.studentIds } } : {}),
    })
    .toArray()
  const invoices = await ctx.invoices
    .find({ _id: { $in: [...new Set(payments.map((p) => p.invoiceId))] }, ...invoiceFilter(scope) })
    .toArray()
  const byId = new Map(invoices.map((i) => [i._id, i]))
  return { payments: payments.filter((p) => byId.has(p.invoiceId)), invoices: byId }
}

/** Same rule as `COUNTED` (finance/service.ts): confirmed, or from before 3.4. */
export const isCounted = (p: PaymentDoc) => p.confirmation !== 'pending'

const sumBy = <T>(rows: T[], key: (row: T) => string, amount: (row: T) => number) => {
  const map = new Map<string, { amount: number; count: number }>()
  for (const row of rows) {
    const k = key(row)
    const cur = map.get(k) ?? { amount: 0, count: 0 }
    cur.amount += amount(row)
    cur.count++
    map.set(k, cur)
  }
  return [...map.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.amount - a.amount)
}

// --------------------------------------------------------------- summary --

/**
 * SAMS 3.6's finance summary for a branch set and a date range:
 *  - revenue: invoices issued in the range — gross lines, line discounts,
 *    discount types and scholarships, and what was billed after them;
 *  - collections: payments received in the range, by method; plus what is
 *    still waiting for confirmation;
 *  - refunds and expenses: paid out in the range, plus what is in progress;
 *  - net position: collected less refunded less spent (cash basis);
 *  - aging and overdue: as of today.
 */
export async function financeSummary(
  ctx: TenantContext,
  params: { branchIds: string[] | null; academicYearId: string | null; from: string; to: string; today: string },
) {
  const { from, to, today, academicYearId } = params
  const scope: FinanceScope = { branchIds: params.branchIds, academicYearId }
  const inBranch = inBranches(params.branchIds)
  const [issued, open, refundRows, expenseRows, received] = await Promise.all([
    ctx.invoices.find({ ...invoiceFilter(scope), status: { $ne: 'void' }, issueDate: { $gte: from, $lte: to } }).toArray(),
    receivables(ctx, scope, today),
    ctx.refunds.find({ ...(inBranch as Filter<RefundDoc>) }).toArray(),
    ctx.expenses.find({ ...(inBranch as Filter<ExpenseDoc>) }).toArray(),
    paymentsInRange(ctx, scope, from, to),
  ])
  const yearInvoices = academicYearId
    ? new Set((await ctx.invoices.find(invoiceFilter(scope)).toArray()).map((i) => i._id))
    : null
  const students = await ctx.students.find({ _id: { $in: [...new Set(open.map((r) => r.invoice.studentId))] } }).toArray()

  const revenue = { invoices: issued.length, gross: 0, lineDiscounts: 0, discounts: 0, scholarships: 0, billed: 0 }
  for (const inv of issued) {
    for (const line of inv.lineItems) {
      revenue.gross += line.amount
      revenue.lineDiscounts += line.amount - line.netAmount
    }
    for (const adj of inv.adjustments ?? []) {
      if (adj.source === 'scholarship') revenue.scholarships += adj.amount
      else revenue.discounts += adj.amount
    }
    revenue.billed += inv.total
  }

  const counted = received.payments.filter(isCounted)
  const waiting = received.payments.filter((p) => !isCounted(p))
  const collections = {
    total: counted.reduce((s, p) => s + p.amount, 0),
    count: counted.length,
    byMethod: sumBy(counted, (p) => p.method, (p) => p.amount).map(({ key, ...v }) => ({ method: key, ...v })),
    awaitingConfirmation: waiting.reduce((s, p) => s + p.amount, 0),
    awaitingConfirmationCount: waiting.length,
  }

  const yearOk = (invoiceId: string) => yearInvoices === null || yearInvoices.has(invoiceId)
  const refundsPaid = refundRows.filter((r) => r.status === 'paid' && r.paidAt! >= from && r.paidAt! <= to && yearOk(r.invoiceId))
  const refundsOpen = refundRows.filter((r) => (r.status === 'pending' || r.status === 'approved') && yearOk(r.invoiceId))
  const refunds = {
    paid: refundsPaid.reduce((s, r) => s + r.amount, 0),
    paidCount: refundsPaid.length,
    inProgress: refundsOpen.reduce((s, r) => s + r.amount, 0),
    inProgressCount: refundsOpen.length,
  }
  const expensesPaid = expenseRows.filter((e) => e.status === 'paid' && e.paidAt! >= from && e.paidAt! <= to)
  const expenses = {
    paid: expensesPaid.reduce((s, e) => s + e.amount, 0),
    paidCount: expensesPaid.length,
    byCategory: sumBy(expensesPaid, (e) => e.categoryCode, (e) => e.amount).map(({ key, ...v }) => ({ categoryCode: key, ...v })),
    awaitingApproval: expenseRows.filter((e) => e.status === 'pending').reduce((s, e) => s + e.amount, 0),
    awaitingPayment: expenseRows.filter((e) => e.status === 'approved').reduce((s, e) => s + e.amount, 0),
  }

  const names = new Map(students.map((s) => [s._id, `${s.givenName} ${s.familyName}`.trim()]))
  const overdue = open
    .filter((r) => r.overdue > 0 && r.oldestDueDate)
    .map((r) => ({
      invoiceId: r.invoice._id,
      invoiceNumber: r.invoice.invoiceNumber,
      studentId: r.invoice.studentId,
      studentName: names.get(r.invoice.studentId) ?? '',
      branchId: r.invoice.branchId,
      overdue: r.overdue,
      outstanding: r.outstanding,
      oldestDueDate: r.oldestDueDate!,
      daysOverdue: r.daysOverdue,
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || b.overdue - a.overdue)

  return {
    from,
    to,
    asOf: today,
    revenue,
    collections,
    refunds,
    expenses,
    net: {
      cashIn: collections.total,
      cashOut: refunds.paid + expenses.paid,
      net: collections.total - refunds.paid - expenses.paid,
    },
    aging: agingTotals(open),
    overdue: { total: overdue.reduce((s, o) => s + o.overdue, 0), count: overdue.length, invoices: overdue.slice(0, 100) },
  }
}

/** The dashboard's receivables card: counts and amounts, as of today. */
export async function receivablesOverview(ctx: TenantContext, branchIds: string[] | null, today: string) {
  const rows = await receivables(ctx, { branchIds }, today)
  const late = rows.filter((r) => r.overdue > 0)
  return {
    openInvoices: rows.length,
    outstanding: rows.reduce((s, r) => s + r.outstanding, 0),
    overdueInvoices: late.length,
    overdue: late.reduce((s, r) => s + r.overdue, 0),
  }
}
