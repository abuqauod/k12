import { randomUUID } from 'node:crypto'
import type { InvoiceDoc, InvoiceInstallment } from '../db.js'

/**
 * Installment plans (SAMS 3.1): an invoice's total split into dated
 * amounts. Nothing is stored per installment except the plan itself; what
 * is paid, due or overdue is worked out on read from the invoice's paid
 * total, applied to the installments oldest first. So a payment, a void or
 * a refund never has to update the plan.
 */

export const MAX_INSTALLMENTS = 24

/** `count` equal parts (the last absorbs the rounding) every
 * `intervalMonths` from `firstDueDate`. */
export function splitEvenly(total: number, count: number, firstDueDate: string, intervalMonths: number): InvoiceInstallment[] {
  const base = Math.floor(total / count)
  return Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    dueDate: addMonths(firstDueDate, i * intervalMonths),
    amount: i === count - 1 ? total - base * (count - 1) : base,
  }))
}

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  // Clamp to the month's last day (31 Jan + 1 month → 28/29 Feb).
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, last))
  return target.toISOString().slice(0, 10)
}

/** Null when the plan is acceptable for an invoice of `total`. */
export function planError(plan: { dueDate: string; amount: number }[], total: number): string | null {
  if (plan.length === 0) return null
  if (plan.length > MAX_INSTALLMENTS) return 'TOO_MANY_INSTALLMENTS'
  if (plan.some((p) => !Number.isInteger(p.amount) || p.amount <= 0)) return 'INVALID_INSTALLMENT_AMOUNT'
  for (let i = 1; i < plan.length; i++) {
    if (plan[i]!.dueDate < plan[i - 1]!.dueDate) return 'INSTALLMENTS_OUT_OF_ORDER'
  }
  if (plan.reduce((s, p) => s + p.amount, 0) !== total) return 'INSTALLMENTS_TOTAL_MISMATCH'
  return null
}

export type InstallmentStatus = 'paid' | 'partial' | 'due' | 'overdue'

export interface InstallmentView extends InvoiceInstallment {
  paid: number
  status: InstallmentStatus
}

/** Each installment's share of `paid`, oldest first, and its status on `today`. */
export function installmentViews(plan: InvoiceInstallment[], paid: number, today: string): InstallmentView[] {
  let left = Math.max(0, paid)
  return plan.map((p) => {
    const covered = Math.min(left, p.amount)
    left -= covered
    const status: InstallmentStatus =
      covered >= p.amount ? 'paid' : p.dueDate < today ? 'overdue' : covered > 0 ? 'partial' : 'due'
    return { ...p, paid: covered, status }
  })
}

/** What is past due and unpaid on `today`: the plan's overdue installments,
 * or without a plan the whole outstanding amount once the due date passed. */
export function overdueAmount(invoice: InvoiceDoc, paid: number, today: string): number {
  if (invoice.status === 'void' || invoice.status === 'paid') return 0
  const plan = invoice.installments ?? []
  if (plan.length > 0) {
    return installmentViews(plan, paid, today)
      .filter((v) => v.status === 'overdue')
      .reduce((s, v) => s + v.amount - v.paid, 0)
  }
  if (invoice.dueDate && invoice.dueDate < today) return Math.max(0, invoice.total - paid)
  return 0
}

/** The oldest date something unpaid fell due (for aging), or null. */
export function oldestUnpaidDueDate(invoice: InvoiceDoc, paid: number, today: string): string | null {
  if (invoice.status === 'void' || invoice.status === 'paid') return null
  const plan = invoice.installments ?? []
  if (plan.length > 0) {
    return installmentViews(plan, paid, today).find((v) => v.status !== 'paid')?.dueDate ?? null
  }
  return invoice.total - paid > 0 ? invoice.dueDate : null
}
