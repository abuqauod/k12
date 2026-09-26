/** A paymentMethod settings-list code (SAMS 1.11) — built-ins plus any the
 * school adds; see lib/settingsApi.ts. */
export type PaymentMethod = string
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

/** SAMS 3.2: an invoice-level discount or scholarship. */
export interface InvoiceAdjustment {
  id: string
  source: 'discount' | 'scholarship'
  refId: string
  label: string
  type: DiscountType
  value: number
  amount: number
  appliedAt: string
  appliedBy: string | null
}

export type InstallmentStatus = 'paid' | 'partial' | 'due' | 'overdue'

/** SAMS 3.1; `paid`/`status` are present when the invoice was read with
 * its payments (list and detail). */
export interface InvoiceInstallment {
  id: string
  dueDate: string
  amount: number
  paid?: number
  status?: InstallmentStatus
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
  subtotal: number
  adjustments: InvoiceAdjustment[]
  total: number
  installments: InvoiceInstallment[]
  installmentsMatchTotal: boolean
  /** Present on list and detail reads. */
  paidTotal?: number
  outstanding?: number
  overdue?: number
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
  batchId: string | null
  confirmation: 'pending' | 'confirmed' | 'rejected'
  confirmedAt: string | null
  /** On queue listings. */
  invoiceNumber?: string | null
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
  allocations: { paymentId: string; invoiceId: string; invoiceNumber: string | null; amount: number }[]
  createdAt: string
}

/** SAMS 3.2: a named discount on the price list. */
export interface DiscountTypeDef {
  id: string
  name: string
  nameAr: string | null
  type: DiscountType
  value: number
  active: boolean
}

export type ScholarshipStatus = 'pending' | 'active' | 'rejected' | 'cancelled' | 'revoked'
export interface Scholarship {
  id: string
  studentId: string
  studentName: string | null
  branchId: string
  academicYearId: string
  name: string
  type: DiscountType
  value: number
  reason: string
  status: ScholarshipStatus
  requestedBy: string
  decidedAt: string | null
  revokedAt: string | null
  revokeReason: string | null
  createdAt: string
}

export type RefundStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'paid'
export interface Refund {
  id: string
  refundNumber: string
  invoiceId: string
  invoiceNumber: string | null
  studentId: string
  branchId: string
  amount: number
  reason: string
  status: RefundStatus
  requestedBy: string
  decidedAt: string | null
  paidAt: string | null
  method: string | null
  reference: string | null
  createdAt: string
}

export interface Vendor {
  id: string
  name: string
  contactName: string | null
  phone: string | null
  email: string | null
  taxNumber: string | null
  notes: string | null
  active: boolean
}

export type ExpenseStatus = RefundStatus
export interface Expense {
  id: string
  expenseNumber: string
  branchId: string
  categoryCode: string
  vendorId: string | null
  vendorName: string | null
  description: string
  amount: number
  expenseDate: string
  reference: string | null
  status: ExpenseStatus
  requestedBy: string
  decidedAt: string | null
  paidAt: string | null
  method: string | null
  paymentReference: string | null
  createdAt: string
}

/** SAMS 3.6: GET /finance/reports/summary. */
export interface FinanceSummary {
  from: string
  to: string
  asOf: string
  revenue: { invoices: number; gross: number; lineDiscounts: number; discounts: number; scholarships: number; billed: number }
  collections: {
    total: number
    count: number
    byMethod: { method: string; amount: number; count: number }[]
    awaitingConfirmation: number
    awaitingConfirmationCount: number
  }
  refunds: { paid: number; paidCount: number; inProgress: number; inProgressCount: number }
  expenses: {
    paid: number
    paidCount: number
    byCategory: { categoryCode: string; amount: number; count: number }[]
    awaitingApproval: number
    awaitingPayment: number
  }
  net: { cashIn: number; cashOut: number; net: number }
  aging: { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; total: number }
  overdue: {
    total: number
    count: number
    invoices: {
      invoiceId: string
      invoiceNumber: string
      studentId: string
      studentName: string
      overdue: number
      outstanding: number
      oldestDueDate: string
      daysOverdue: number
    }[]
  }
}

export interface StudentBalance {
  invoicedTotal: number
  paidTotal: number
  outstandingBalance: number
}


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
