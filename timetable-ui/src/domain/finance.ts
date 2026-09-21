export type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'cheque' | 'other'
export type InvoiceStatus = 'open' | 'partially_paid' | 'paid' | 'void'
export type DiscountType = 'amount' | 'percent'

/** All money fields below are integer minor units (fils/cents) — never a
 * float, so summing many line items and payments over months never drifts.
 * Conversion to a displayed major-unit amount happens only where a value is
 * actually rendered (see `formatMinorUnits`). */

export interface FeeStructureLineItem {
  /** Stable id from the server; absent only on a line the form just added
   * and hasn't saved yet (same convention as `Guardian.id` in
   * domain/students.ts). */
  id?: string
  label: string
  labelAr: string | null
  amount: number
}

export interface FeeStructure {
  id: string
  branchId: string
  academicYearId: string
  gradeLevel: string
  name: string
  lineItems: FeeStructureLineItem[]
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface InvoiceLineItem {
  id: string
  label: string
  labelAr: string | null
  sourceFeeItemId: string | null
  amount: number
  discount: { type: DiscountType; value: number } | null
  netAmount: number
}

export interface Invoice {
  id: string
  studentId: string
  branchId: string
  academicYearId: string
  feeStructureId: string | null
  invoiceNumber: string
  issueDate: string
  dueDate: string | null
  lineItems: InvoiceLineItem[]
  total: number
  status: InvoiceStatus
  notes: string | null
  createdAt: string
  updatedAt: string
  voidedAt: string | null
}

export interface Payment {
  id: string
  invoiceId: string
  studentId: string
  amount: number
  method: PaymentMethod
  reference: string | null
  paidAt: string
  payerName: string
  payerParentId: string | null
  notes: string | null
  createdAt: string
  voidedAt: string | null
}

export interface Receipt {
  id: string
  paymentId: string
  invoiceId: string
  studentId: string
  receiptNumber: string
  amount: number
  method: PaymentMethod
  payerName: string
  issueDate: string
  createdAt: string
}

export interface StudentBalance {
  invoicedTotal: number
  paidTotal: number
  outstandingBalance: number
}

export const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'bank_transfer', 'card', 'cheque', 'other']

/** Minor units -> a display string, e.g. 12345 -> "123.45". Assumes a
 * 2-decimal currency (fils/cents), the common case; a 0-decimal currency
 * would need this parameterized, not needed by anything in this codebase
 * today. */
export function formatMinorUnits(minor: number): string {
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** The inverse of `formatMinorUnits` — a form input's text back to minor
 * units. Returns `null` for anything that doesn't parse as a non-negative
 * amount, so callers can reject rather than silently coerce to 0. */
export function parseMinorUnits(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

export function emptyFeeStructureLine(): FeeStructureLineItem {
  return { label: '', labelAr: null, amount: 0 }
}
