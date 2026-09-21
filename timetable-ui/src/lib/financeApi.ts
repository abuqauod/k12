import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'
import type {
  DiscountType,
  FeeStructure,
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

export async function voidInvoice(getToken: TokenGetter, id: string): Promise<FinanceResult<Invoice>> {
  try {
    const response = await call(`/finance/invoices/${encodeURIComponent(id)}/void`, { method: 'POST' }, getToken)
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
}

export async function recordPayment(
  getToken: TokenGetter,
  invoiceId: string,
  payment: NewPayment,
): Promise<FinanceResult<{ payment: Payment; receipt: Receipt; invoice: Invoice }>> {
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
): Promise<FinanceResult<{ payment: Payment; invoice: Invoice }>> {
  try {
    const response = await call(`/finance/payments/${encodeURIComponent(id)}/void`, { method: 'POST' }, getToken)
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
