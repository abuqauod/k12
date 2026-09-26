import type { TokenGetter } from './http'
import { api, enc, qs } from './apiClient'

/** SAMS 11.4: the canteen and students' wallets. Minor units. */

type G = TokenGetter

export interface Product {
  id: string
  branchId: string
  name: string
  nameAr: string | null
  price: number
  categoryCode: string | null
  active: boolean
}
export interface WalletTx {
  id: string
  type: 'topup' | 'purchase' | 'refund' | 'adjust'
  amount: number
  balanceAfter: number
  method: string | null
  items: { productId: string; name: string; qty: number; price: number }[]
  reference: string | null
  voided: boolean
  createdAt: string
}
export interface CardLookup {
  studentId: string
  name: string
  studentNumber: string
  balance: number
  active: boolean
  leftToday: number | null
  blockedCategories: string[]
}

export const listProducts = (g: G, q: { branchId?: string; all?: boolean } = {}) =>
  api<{ products: Product[] }>(g, 'GET', `/canteen/products${qs({ branchId: q.branchId, all: q.all ? '1' : undefined })}`)
export const saveProduct = (g: G, body: Omit<Product, 'id'>, id?: string) =>
  id ? api<{ id: string }>(g, 'PATCH', `/canteen/products/${enc(id)}`, body) : api<{ id: string }>(g, 'POST', '/canteen/products', body)
export const lookupCard = (g: G, card: string) => api<CardLookup>(g, 'GET', `/canteen/card${qs({ card })}`)
export const sell = (g: G, body: { card: string; items: { productId: string; qty: number }[] }) =>
  api<WalletTx & { total: number; name: string }>(g, 'POST', '/canteen/sales', body)
export const refundSale = (g: G, id: string) => api<WalletTx>(g, 'POST', `/canteen/sales/${enc(id)}/refund`, {})
export const canteenSummary = (g: G, q: { branchId?: string; date?: string } = {}) =>
  api<{ date: string; sales: number; salesTotal: number; topups: number; products: { name: string; qty: number; total: number }[] }>(
    g,
    'GET',
    `/canteen/summary${qs(q)}`,
  )
export const getWallet = (g: G, studentId: string) =>
  api<{
    studentId: string
    name: string
    balance: number
    dailyLimit: number | null
    blockedCategories: string[]
    active: boolean
    transactions: WalletTx[]
  }>(g, 'GET', `/canteen/wallets/${enc(studentId)}`)
export const topUp = (g: G, studentId: string, body: { amount: number; method: string; reference: string | null }) =>
  api<WalletTx>(g, 'POST', `/canteen/wallets/${enc(studentId)}/topup`, body)

export interface PortalWallet {
  categories: { code: string; label: string; labelAr: string }[]
  balance: number
  dailyLimit: number | null
  blockedCategories: string[]
  spentToday: number
  canTopUp: boolean
  canControl: boolean
  topupMin: number
  topupMax: number
  currency: string
  transactions: WalletTx[]
}
export const portalWallet = (g: G, id: string) => api<PortalWallet>(g, 'GET', `/portal/children/${enc(id)}/wallet`)
export const portalWalletControls = (g: G, id: string, body: { dailyLimit: number | null; blockedCategories: string[] }) =>
  api<{ dailyLimit: number | null; blockedCategories: string[] }>(g, 'PUT', `/portal/children/${enc(id)}/wallet/controls`, body)
export const portalWalletTopup = (g: G, id: string, amount: number) =>
  api<{ id: string; redirectUrl: string }>(g, 'POST', `/portal/children/${enc(id)}/wallet/topup`, { amount })
