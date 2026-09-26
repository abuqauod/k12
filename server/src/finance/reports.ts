import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { ExpenseDoc, InvoiceDoc, RefundDoc } from '../db.js'
import { invoicePaidTotals } from './service.js'
import { installmentViews } from './installments.js'
import { branchFilter, scoped, todayIso } from './common.js'

/**
 * SAMS 3.6: one finance summary for a branch (or every branch the caller
 * may see) and a date range. Every figure comes from the same definitions
 * the rest of finance uses (counted payments, `invoicePaidTotals`, the installment
 * views), never a second formula.
 *
 *  - revenue: invoices issued in the range — gross lines, line discounts,
 *    discount types and scholarships, and what was billed after them;
 *  - collections: payments received in the range, by method; plus what is
 *    still waiting for confirmation;
 *  - refunds and expenses: paid out in the range, plus what is in progress;
 *  - net position: collected less refunded less spent (cash basis);
 *  - aging and overdue: as of today, every unpaid amount by how long past
 *    its due date (per installment when the invoice has a plan).
 */

const query = z
  .object({
    branchId: z.string().optional(),
    from: z.string().date(),
    to: z.string().date(),
    academicYearId: z.string().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from after to' })

const BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const
type Bucket = (typeof BUCKETS)[number]

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

function bucketFor(dueDate: string | null, today: string): Bucket {
  if (!dueDate || dueDate >= today) return 'current'
  const days = daysBetween(dueDate, today)
  return days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus'
}

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

export function registerFinanceReportRoutes(app: FastifyInstance): void {
  app.get('/finance/reports/summary', scoped('reports.finance'), async (request, reply) => {
    const parsed = query.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { from, to, academicYearId } = parsed.data
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const inBranch = branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}
    const today = todayIso()

    const data = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const invoiceScope: Filter<InvoiceDoc> = { ...inBranch, ...(academicYearId ? { academicYearId } : {}) }
      const [issued, unpaid, refunds, expenses] = await Promise.all([
        ctx.invoices.find({ ...invoiceScope, status: { $ne: 'void' }, issueDate: { $gte: from, $lte: to } }).toArray(),
        ctx.invoices.find({ ...invoiceScope, status: { $in: ['open', 'partially_paid'] } }).toArray(),
        ctx.refunds.find({ ...(inBranch as Filter<RefundDoc>) }).toArray(),
        ctx.expenses.find({ ...(inBranch as Filter<ExpenseDoc>) }).toArray(),
      ])
      // Payments carry no branch: take them in the range, then keep those
      // whose invoice is in scope.
      const payments = await ctx.payments
        .find({ voidedAt: null, paidAt: { $gte: from, $lte: to }, confirmation: { $ne: 'rejected' } })
        .toArray()
      const payInvoices = await ctx.invoices
        .find({ _id: { $in: [...new Set(payments.map((p) => p.invoiceId))] }, ...invoiceScope })
        .toArray()
      const payInScope = new Set(payInvoices.map((i) => i._id))
      const scopedPayments = payments.filter((p) => payInScope.has(p.invoiceId))
      const paid = await invoicePaidTotals(ctx, unpaid.map((i) => i._id))
      const students = await ctx.students
        .find({ _id: { $in: [...new Set(unpaid.map((i) => i.studentId))] } })
        .toArray()
      const yearInvoices = academicYearId
        ? new Set((await ctx.invoices.find({ ...invoiceScope }).toArray()).map((i) => i._id))
        : null
      return { issued, unpaid, refunds, expenses, scopedPayments, paid, students, yearInvoices }
    })

    // Revenue
    const revenue = { invoices: data.issued.length, gross: 0, lineDiscounts: 0, discounts: 0, scholarships: 0, billed: 0 }
    for (const inv of data.issued) {
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

    // Collections
    // Same rule as `COUNTED` (finance/service.ts): confirmed or from before 3.4.
    const received = data.scopedPayments.filter((p) => p.confirmation !== 'pending')
    const waiting = data.scopedPayments.filter((p) => p.confirmation === 'pending')
    const collections = {
      total: received.reduce((s, p) => s + p.amount, 0),
      count: received.length,
      byMethod: sumBy(received, (p) => p.method, (p) => p.amount).map(({ key, ...v }) => ({ method: key, ...v })),
      awaitingConfirmation: waiting.reduce((s, p) => s + p.amount, 0),
      awaitingConfirmationCount: waiting.length,
    }

    // Refunds and expenses
    const yearOk = (invoiceId: string) => data.yearInvoices === null || data.yearInvoices.has(invoiceId)
    const refundsPaid = data.refunds.filter((r) => r.status === 'paid' && r.paidAt! >= from && r.paidAt! <= to && yearOk(r.invoiceId))
    const refundsOpen = data.refunds.filter((r) => (r.status === 'pending' || r.status === 'approved') && yearOk(r.invoiceId))
    const refunds = {
      paid: refundsPaid.reduce((s, r) => s + r.amount, 0),
      paidCount: refundsPaid.length,
      inProgress: refundsOpen.reduce((s, r) => s + r.amount, 0),
      inProgressCount: refundsOpen.length,
    }
    const expensesPaid = data.expenses.filter((e) => e.status === 'paid' && e.paidAt! >= from && e.paidAt! <= to)
    const expenses = {
      paid: expensesPaid.reduce((s, e) => s + e.amount, 0),
      paidCount: expensesPaid.length,
      byCategory: sumBy(expensesPaid, (e) => e.categoryCode, (e) => e.amount).map(({ key, ...v }) => ({ categoryCode: key, ...v })),
      awaitingApproval: data.expenses.filter((e) => e.status === 'pending').reduce((s, e) => s + e.amount, 0),
      awaitingPayment: data.expenses.filter((e) => e.status === 'approved').reduce((s, e) => s + e.amount, 0),
    }

    // Aging and overdue, as of today
    const aging: Record<Bucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }
    const names = new Map(data.students.map((s) => [s._id, `${s.givenName} ${s.familyName}`.trim()]))
    const overdue: {
      invoiceId: string
      invoiceNumber: string
      studentId: string
      studentName: string
      branchId: string
      overdue: number
      outstanding: number
      oldestDueDate: string
      daysOverdue: number
    }[] = []
    for (const inv of data.unpaid) {
      const paidSoFar = data.paid.get(inv._id) ?? 0
      const parts =
        (inv.installments ?? []).length > 0
          ? installmentViews(inv.installments!, paidSoFar, today).map((v) => ({ dueDate: v.dueDate, left: v.amount - v.paid }))
          : [{ dueDate: inv.dueDate, left: inv.total - paidSoFar }]
      let late = 0
      let oldest: string | null = null
      for (const part of parts) {
        if (part.left <= 0) continue
        const bucket = bucketFor(part.dueDate, today)
        aging[bucket] += part.left
        if (bucket !== 'current') {
          late += part.left
          if (!oldest || part.dueDate! < oldest) oldest = part.dueDate
        }
      }
      if (late > 0 && oldest) {
        overdue.push({
          invoiceId: inv._id,
          invoiceNumber: inv.invoiceNumber,
          studentId: inv.studentId,
          studentName: names.get(inv.studentId) ?? '',
          branchId: inv.branchId,
          overdue: late,
          outstanding: inv.total - paidSoFar,
          oldestDueDate: oldest,
          daysOverdue: daysBetween(oldest, today),
        })
      }
    }
    overdue.sort((a, b) => b.daysOverdue - a.daysOverdue || b.overdue - a.overdue)
    const outstandingTotal = BUCKETS.reduce((s, b) => s + aging[b], 0)

    return reply.send({
      from,
      to,
      asOf: today,
      branchId: parsed.data.branchId ?? null,
      revenue,
      collections,
      refunds,
      expenses,
      net: {
        cashIn: collections.total,
        cashOut: refunds.paid + expenses.paid,
        net: collections.total - refunds.paid - expenses.paid,
      },
      aging: { ...aging, total: outstandingTotal },
      overdue: { total: overdue.reduce((s, o) => s + o.overdue, 0), count: overdue.length, invoices: overdue.slice(0, 100) },
    })
  })
}
