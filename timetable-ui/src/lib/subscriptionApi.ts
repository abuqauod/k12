import type { TokenGetter } from './http'
import { api, enc } from './apiClient'
import type { PlanCurrency } from './authApi'

type G = TokenGetter

/** SAMS 13.3: the school's own subscription. Amounts in minor units. */

export type SubscriptionState = 'active' | 'grace' | 'readOnly' | 'locked' | 'inactive'

export interface SubscriptionInvoice {
  id: string
  number: string
  plan: string
  term: 'year' | 'month'
  periodStart: string
  periodEnd: string
  students: number
  currency: PlanCurrency
  lines: { label: string; amount: number }[]
  subtotal: number
  taxRate: number
  tax: number
  total: number
  status: 'open' | 'paid' | 'void'
  dueDate: string
  issuedAt: string
  paidAt: string | null
  paidBy: 'card' | 'transfer' | null
  reference: string | null
  source: 'console' | 'self' | 'renewal'
}

export interface Subscription {
  plan: string
  listed: boolean
  modules: string[]
  limits: { students: number | null; branches: number | null; smsPerStudent: number | null }
  usage: { students: number; branches: number; staff: number; smsThisMonth: number }
  validUntil: string | null
  graceDays: number
  state: SubscriptionState
  graceEnds: string | null
  readOnlyUntil: string | null
  billing: { currency: PlanCurrency; term: 'year' | 'month'; students: number; email: string | null; country: string | null } | null
  invoices: SubscriptionInvoice[]
  cardPayments: boolean
  bankDetails: string | null
  salesEmail: string | null
}

export type PlanChoice = { plan: 'essentials' | 'professional' | 'enterprise'; term: 'year' | 'month'; students?: number }

export interface Quote {
  plan: string
  term: 'year' | 'month'
  currency: PlanCurrency
  students: number
  periodStart: string
  periodEnd: string
  lines: { label: string; amount: number }[]
  subtotal: number
  taxRate: number
  tax: number
  total: number
}

export const getSubscription = (g: G) => api<Subscription>(g, 'GET', '/subscription')
export const quotePlan = (g: G, choice: PlanChoice) => api<Quote>(g, 'POST', '/subscription/quote', choice)
export const createSubscriptionInvoice = (g: G, choice: PlanChoice) => api<SubscriptionInvoice>(g, 'POST', '/subscription/invoices', choice)
export const payInvoiceByCard = (g: G, id: string, lang: 'en' | 'ar') =>
  api<{ redirectUrl: string; checkoutId: string }>(g, 'POST', `/subscription/invoices/${enc(id)}/pay`, { lang })
export const checkoutStatus = (g: G, id: string) =>
  api<{ id: string; status: 'pending' | 'paid' | 'failed'; amount: number; currency: string; invoiceId: string }>(
    g,
    'GET',
    `/subscription/checkouts/${enc(id)}`,
  )
export const invoicePrintPath = (id: string) => `/subscription/invoices/${enc(id)}/print`
