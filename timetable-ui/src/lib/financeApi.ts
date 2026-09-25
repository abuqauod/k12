import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'
import type {
  DiscountType,
  DiscountTypeDef,
  Expense,
  FeeStructure,
  FinanceSummary,
  Refund,
  Scholarship,
  Vendor,
  FeeStructureLineItem,
  Invoice,
  InvoiceStatus,
  Payment,
  PaymentMethod,
  Receipt,
  StudentBalance,
} from '../domain/finance'

/** Client for `/finance/*` — fee structures, invoices, payments, receipts.
 * Same structural template as parentsApi.ts/studentsApi.ts. */

export type FinanceResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, getToken: TokenGetter): Promise<Response> {
  return authorizedFetch(`${baseUrl()}${path}`, init, getToken)
}

async function parse<T>(response: Response): Promise<FinanceResult<T>> {
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* keep null */
  }
  if (!response.ok) {
    const error = (body as { error?: string } | null)?.error ?? `HTTP_${response.status}`
    return { kind: 'error', error }
  }
  return { kind: 'ok', data: body as T }
}

// ------------------------------------------------------------ fee structures

export type NewFeeStructure = Omit<FeeStructure, 'id' | 'active' | 'createdAt' | 'updatedAt'>

export async function listFeeStructures(
  getToken: TokenGetter,
  params: { branchId?: string; academicYearId?: string; gradeLevel?: string; includeInactive?: boolean } = {},
): Promise<FinanceResult<FeeStructure[]>> {
  try {
    const query = new URLSearchParams()
    if (params.branchId) query.set('branchId', params.branchId)
    if (params.academicYearId) query.set('academicYearId', params.academicYearId)
    if (params.gradeLevel) query.set('gradeLevel', params.gradeLevel)
    if (params.includeInactive) query.set('includeInactive', 'true')
    const qs = query.toString()
    const response = await call(`/finance/fee-structures${qs ? `?${qs}` : ''}`, { method: 'GET' }, getToken)
    const result = await parse<{ feeStructures: FeeStructure[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.feeStructures } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function createFeeStructure(
  getToken: TokenGetter,
  structure: NewFeeStructure,
): Promise<FinanceResult<FeeStructure>> {
  try {
    const response = await call('/finance/fee-structures', { method: 'POST', body: JSON.stringify(structure) }, getToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateFeeStructure(
  getToken: TokenGetter,
  id: string,
  patch: { name?: string; lineItems?: FeeStructureLineItem[] },
): Promise<FinanceResult<FeeStructure>> {
  try {
    const response = await call(
      `/finance/fee-structures/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function deactivateFeeStructure(getToken: TokenGetter, id: string): Promise<FinanceResult<FeeStructure>> {
  try {
    const response = await call(`/finance/fee-structures/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }, getToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

// ------------------------------------------------------------------ invoices

export async function listInvoices(
  getToken: TokenGetter,
  params: { studentId?: string; branchId?: string; academicYearId?: string; status?: InvoiceStatus } = {},
): Promise<FinanceResult<Invoice[]>> {
  try {
    const query = new URLSearchParams()
    if (params.studentId) query.set('studentId', params.studentId)
    if (params.branchId) query.set('branchId', params.branchId)
    if (params.academicYearId) query.set('academicYearId', params.academicYearId)
    if (params.status) query.set('status', params.status)
    const qs = query.toString()
    const response = await call(`/finance/invoices${qs ? `?${qs}` : ''}`, { method: 'GET' }, getToken)
    const result = await parse<{ invoices: Invoice[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.invoices } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function getInvoice(getToken: TokenGetter, id: string): Promise<FinanceResult<Invoice>> {
  try {
    const response = await call(`/finance/invoices/${encodeURIComponent(id)}`, { method: 'GET' }, getToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function generateInvoice(
  getToken: TokenGetter,
  params: { studentId: string; feeStructureId: string; dueDate?: string | null; notes?: string | null },
): Promise<FinanceResult<Invoice>> {
  try {
    const response = await call('/finance/invoices', { method: 'POST', body: JSON.stringify(params) }, getToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export interface NewInvoiceLine {
  label: string
  labelAr: string | null
  amount: number
  discount: { type: DiscountType; value: number } | null
}

export async function addInvoiceLineItem(
  getToken: TokenGetter,
  invoiceId: string,
  line: NewInvoiceLine,
): Promise<FinanceResult<Invoice>> {
  try {
    const response = await call(
      `/finance/invoices/${encodeURIComponent(invoiceId)}/line-items`,
      { method: 'POST', body: JSON.stringify(line) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateInvoiceLineItem(
  getToken: TokenGetter,
  invoiceId: string,
  lineItemId: string,
  patch: Partial<NewInvoiceLine>,
): Promise<FinanceResult<Invoice>> {
  try {
    const response = await call(
      `/finance/invoices/${encodeURIComponent(invoiceId)}/line-items/${encodeURIComponent(lineItemId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function removeInvoiceLineItem(
  getToken: TokenGetter,
  invoiceId: string,
  lineItemId: string,
): Promise<FinanceResult<Invoice>> {
  try {
    const response = await call(
      `/finance/invoices/${encodeURIComponent(invoiceId)}/line-items/${encodeURIComponent(lineItemId)}`,
      { method: 'DELETE' },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

/** `reason` is required by the server (3+ characters) and kept in the audit log. */
export async function voidInvoice(getToken: TokenGetter, id: string, reason: string): Promise<FinanceResult<Invoice>> {
  try {
    const response = await call(
      `/finance/invoices/${encodeURIComponent(id)}/void`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

// ------------------------------------------------------------------ payments

export async function listPayments(
  getToken: TokenGetter,
  params: { invoiceId?: string; studentId?: string },
): Promise<FinanceResult<Payment[]>> {
  try {
    const query = new URLSearchParams()
    if (params.invoiceId) query.set('invoiceId', params.invoiceId)
    if (params.studentId) query.set('studentId', params.studentId)
    const response = await call(`/finance/payments?${query.toString()}`, { method: 'GET' }, getToken)
    const result = await parse<{ payments: Payment[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.payments } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export interface NewPayment {
  amount: number
  method: PaymentMethod
  reference: string | null
  paidAt: string
  payerName: string
  notes: string | null
  /** SAMS 3.4: count it only once confirmed (cheques, transfers). */
  awaitingConfirmation?: boolean
}

export async function recordPayment(
  getToken: TokenGetter,
  invoiceId: string,
  payment: NewPayment,
): Promise<FinanceResult<{ payment: Payment; receipt: Receipt | null; invoice: Invoice }>> {
  try {
    const response = await call(
      `/finance/invoices/${encodeURIComponent(invoiceId)}/payments`,
      { method: 'POST', body: JSON.stringify(payment) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function voidPayment(
  getToken: TokenGetter,
  id: string,
  reason: string,
): Promise<FinanceResult<{ payment: Payment; invoice: Invoice }>> {
  try {
    const response = await call(
      `/finance/payments/${encodeURIComponent(id)}/void`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

// ------------------------------------------------------------------ receipts

export async function listReceipts(
  getToken: TokenGetter,
  params: { invoiceId?: string; studentId?: string },
): Promise<FinanceResult<Receipt[]>> {
  try {
    const query = new URLSearchParams()
    if (params.invoiceId) query.set('invoiceId', params.invoiceId)
    if (params.studentId) query.set('studentId', params.studentId)
    const response = await call(`/finance/receipts?${query.toString()}`, { method: 'GET' }, getToken)
    const result = await parse<{ receipts: Receipt[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.receipts } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function getReceipt(getToken: TokenGetter, id: string): Promise<FinanceResult<Receipt>> {
  try {
    const response = await call(`/finance/receipts/${encodeURIComponent(id)}`, { method: 'GET' }, getToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function getStudentBalance(getToken: TokenGetter, studentId: string): Promise<FinanceResult<StudentBalance>> {
  try {
    const response = await call(`/finance/students/${encodeURIComponent(studentId)}/balance`, { method: 'GET' }, getToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

// ------------------------------------------------------------ Phase 3 --
// Installments, discounts, scholarships, refunds, allocation, confirmations,
// expenses and reports share one small request helper.

async function send<T>(getToken: TokenGetter, method: string, path: string, body?: unknown): Promise<FinanceResult<T>> {
  try {
    const init: RequestInit = { method }
    if (body !== undefined) init.body = JSON.stringify(body)
    return parse<T>(await call(path, init, getToken))
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

const qs = (params: Record<string, string | undefined | null | boolean>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}
const enc = encodeURIComponent

async function unwrap<K extends string, T>(res: Promise<FinanceResult<Record<K, T>>>, key: K): Promise<FinanceResult<T>> {
  const r = await res
  return r.kind === 'ok' ? { kind: 'ok', data: r.data[key] } : r
}

/** SAMS 3.1: an even split, explicit dates, or `[]` to clear the plan. */
export const setInstallments = (
  getToken: TokenGetter,
  invoiceId: string,
  plan: { split: { count: number; firstDueDate: string; intervalMonths: number } } | { installments: { dueDate: string; amount: number }[] },
) => send<Invoice>(getToken, 'PUT', `/finance/invoices/${enc(invoiceId)}/installments`, plan)

// 3.2 discount types and scholarships
export const listDiscountTypes = (getToken: TokenGetter, includeInactive = false) =>
  unwrap(send<{ discountTypes: DiscountTypeDef[] }>(getToken, 'GET', `/finance/discount-types${qs({ includeInactive })}`), 'discountTypes')
export const createDiscountType = (getToken: TokenGetter, body: { name: string; nameAr: string | null; type: DiscountType; value: number }) =>
  send<DiscountTypeDef>(getToken, 'POST', '/finance/discount-types', body)
export const updateDiscountType = (getToken: TokenGetter, id: string, patch: Partial<Pick<DiscountTypeDef, 'name' | 'nameAr' | 'value' | 'active'>>) =>
  send<DiscountTypeDef>(getToken, 'PATCH', `/finance/discount-types/${enc(id)}`, patch)
export const applyDiscount = (getToken: TokenGetter, invoiceId: string, discountTypeId: string) =>
  send<Invoice>(getToken, 'POST', `/finance/invoices/${enc(invoiceId)}/adjustments`, { discountTypeId })
export const removeAdjustment = (getToken: TokenGetter, invoiceId: string, adjustmentId: string, reason: string) =>
  send<Invoice>(getToken, 'DELETE', `/finance/invoices/${enc(invoiceId)}/adjustments/${enc(adjustmentId)}`, { reason })

export const listScholarships = (
  getToken: TokenGetter,
  params: { studentId?: string; branchId?: string; academicYearId?: string; status?: string } = {},
) => unwrap(send<{ scholarships: Scholarship[] }>(getToken, 'GET', `/finance/scholarships${qs(params)}`), 'scholarships')
export const requestScholarship = (
  getToken: TokenGetter,
  body: { studentId: string; academicYearId?: string; name: string; type: DiscountType; value: number; reason: string },
) => send<Scholarship & { approvalId: string }>(getToken, 'POST', '/finance/scholarships', body)
export const revokeScholarship = (getToken: TokenGetter, id: string, reason: string) =>
  send<Scholarship & { invoicesUpdated: number }>(getToken, 'POST', `/finance/scholarships/${enc(id)}/revoke`, { reason })

// 3.3 refunds
export const listRefunds = (
  getToken: TokenGetter,
  params: { invoiceId?: string; studentId?: string; branchId?: string; status?: string } = {},
) => send<{ refunds: Refund[]; refundable?: number }>(getToken, 'GET', `/finance/refunds${qs(params)}`)
export const requestRefund = (getToken: TokenGetter, invoiceId: string, body: { amount: number; reason: string }) =>
  send<Refund & { approvalId: string }>(getToken, 'POST', `/finance/invoices/${enc(invoiceId)}/refunds`, body)
export const payRefund = (getToken: TokenGetter, id: string, body: { paidAt: string; method: string; reference: string | null }) =>
  send<Refund>(getToken, 'POST', `/finance/refunds/${enc(id)}/pay`, body)
export const cancelRefund = (getToken: TokenGetter, id: string) =>
  send<Refund>(getToken, 'POST', `/finance/refunds/${enc(id)}/cancel`, {})

// 3.4 allocation and confirmations
export type OpenInvoice = Invoice & { outstanding: number }
export const listOpenInvoices = (getToken: TokenGetter, studentId: string) =>
  unwrap(send<{ invoices: OpenInvoice[] }>(getToken, 'GET', `/finance/students/${enc(studentId)}/open-invoices`), 'invoices')
export const recordStudentPayment = (
  getToken: TokenGetter,
  studentId: string,
  body: NewPayment & { allocations?: { invoiceId: string; amount: number }[] },
) => send<{ payments: Payment[]; receipt: Receipt | null; invoices: Invoice[] }>(getToken, 'POST', `/finance/students/${enc(studentId)}/payments`, body)
export const listPendingPayments = (getToken: TokenGetter, branchId?: string) =>
  unwrap(send<{ payments: Payment[] }>(getToken, 'GET', `/finance/payments${qs({ confirmation: 'pending', branchId })}`), 'payments')
export const confirmPayment = (getToken: TokenGetter, id: string) =>
  send<{ payments: Payment[]; receipt: Receipt | null }>(getToken, 'POST', `/finance/payments/${enc(id)}/confirm`, {})
export const rejectPayment = (getToken: TokenGetter, id: string, reason: string) =>
  send<{ payments: Payment[] }>(getToken, 'POST', `/finance/payments/${enc(id)}/reject`, { reason })

// 3.5 vendors and expenses
export const listVendors = (getToken: TokenGetter, includeInactive = false) =>
  unwrap(send<{ vendors: Vendor[] }>(getToken, 'GET', `/finance/vendors${qs({ includeInactive })}`), 'vendors')
export const createVendor = (getToken: TokenGetter, body: Partial<Omit<Vendor, 'id' | 'active'>> & { name: string }) =>
  send<Vendor>(getToken, 'POST', '/finance/vendors', body)
export const updateVendor = (getToken: TokenGetter, id: string, patch: Partial<Omit<Vendor, 'id'>>) =>
  send<Vendor>(getToken, 'PATCH', `/finance/vendors/${enc(id)}`, patch)
export const listExpenses = (
  getToken: TokenGetter,
  params: { branchId?: string; status?: string; categoryCode?: string; from?: string; to?: string } = {},
) => unwrap(send<{ expenses: Expense[] }>(getToken, 'GET', `/finance/expenses${qs(params)}`), 'expenses')
export const createExpense = (
  getToken: TokenGetter,
  body: { branchId: string; categoryCode: string; vendorId: string | null; description: string; amount: number; expenseDate: string; reference: string | null },
) => send<Expense & { approvalId: string }>(getToken, 'POST', '/finance/expenses', body)
export const payExpense = (getToken: TokenGetter, id: string, body: { paidAt: string; method: string; reference: string | null }) =>
  send<Expense>(getToken, 'POST', `/finance/expenses/${enc(id)}/pay`, body)
export const cancelExpense = (getToken: TokenGetter, id: string) =>
  send<Expense>(getToken, 'POST', `/finance/expenses/${enc(id)}/cancel`, {})

// 3.6 reports
export const getFinanceSummary = (getToken: TokenGetter, params: { branchId?: string; from: string; to: string; academicYearId?: string }) =>
  send<FinanceSummary>(getToken, 'GET', `/finance/reports/summary${qs(params)}`)
