import type { TokenGetter } from './http'
import { api, enc, qs } from './apiClient'

type G = TokenGetter

/** SAMS 11.1: online fee payment. Amounts in minor units (hundredths). */

export type ProviderKey = 'paytabs' | 'hyperpay' | 'test'

export interface PaymentSettings {
  enabled: boolean
  provider: ProviderKey | null
  currency: string
  settings: Record<string, string>
  secretsSet: Record<string, boolean>
  providers: ProviderKey[]
  fields: Record<ProviderKey, { settings: string[]; secrets: string[] }>
  paytabsRegions: string[]
}

export interface OnlinePayment {
  id: string
  studentId: string
  studentName: string | null
  branchId: string
  amount: number
  currency: string
  provider: ProviderKey
  providerRef: string | null
  status: 'pending' | 'paid' | 'failed' | 'cancelled'
  message: string | null
  receiptId: string | null
  overpaid: number
  refunded: number
  createdAt: string
  settledAt: string | null
}

export const getPaymentSettings = (g: G) => api<PaymentSettings>(g, 'GET', '/settings/payments')
export const savePaymentSettings = (
  g: G,
  body: {
    enabled: boolean
    provider: ProviderKey | null
    currency: string
    settings: Record<string, string>
    secrets: Record<string, string>
  },
) => api<PaymentSettings>(g, 'PUT', '/settings/payments', body)

export const listOnlinePayments = (g: G, q: { branchId?: string; status?: string } = {}) =>
  api<{ payments: OnlinePayment[] }>(g, 'GET', `/finance/online-payments${qs(q)}`)
export const checkOnlinePayment = (g: G, id: string) => api<OnlinePayment>(g, 'POST', `/finance/online-payments/${enc(id)}/check`, {})

export const portalPay = (g: G, studentId: string, amount: number | null) =>
  api<OnlinePayment & { redirectUrl: string }>(g, 'POST', `/portal/children/${enc(studentId)}/pay`, { amount })
export const portalPayment = (g: G, id: string) => api<OnlinePayment>(g, 'GET', `/portal/payments/${enc(id)}`)
