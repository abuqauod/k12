import type { TokenGetter } from './http'
import { api, enc } from './apiClient'
import { loadSyncSettings } from './sync'

/** Client for the parent portal (`/portal/*`, SAMS 6.4). */

export interface PortalChild {
  id: string
  name: string
  nameAr: string | null
  studentNumber: string
  status: string
  branchName: string
  className: string | null
  relationship: string
  finance: boolean
}
export interface PortalMe {
  school: { name: string; nameAr: string | null }
  parent: {
    id: string
    fullName: string
    fullNameAr: string | null
    email: string | null
    preferredLanguage: 'en' | 'ar'
  }
  children: PortalChild[]
}
export interface PortalChildDetail {
  id: string
  name: string
  nameAr: string | null
  studentNumber: string
  dob: string | null
  status: string
  branchName: string
  className: string | null
  academicYear: { name: string; startDate: string; endDate: string } | null
  finance: boolean
  attendance: {
    since: string
    counts: Record<string, number>
    recent: { date: string; status: string; note: string | null }[]
  }
}
export interface PortalInvoice {
  id: string
  invoiceNumber: string
  issueDate: string
  dueDate: string | null
  status: string
  total: number
  paid: number
  balance: number
  lines: { label: string; labelAr: string | null; amount: number }[]
  adjustments: { label: string; amount: number }[]
  installments: {
    dueDate: string
    amount: number
    paid: number
    status: 'paid' | 'partial' | 'due' | 'overdue'
  }[]
}
export interface PortalReceipt {
  id: string
  receiptNumber: string
  issueDate: string
  amount: number
  method: string
  payerName: string
  allocations: { invoiceNumber: string; amount: number }[]
}
export interface PortalDocument {
  id: string
  category: string
  categoryLabel: string
  categoryLabelAr: string | null
  fileName: string
  mime: string
  size: number
  expiresAt: string | null
  uploadedAt: string
}
export interface PortalAnnouncement {
  id: string
  title: string
  body: string
  titleAr: string | null
  bodyAr: string | null
  publishedAt: string | null
  children: string[]
}

export const portalMe = (getToken: TokenGetter) => api<PortalMe>(getToken, 'GET', '/portal/me')
export const portalChild = (getToken: TokenGetter, id: string) => api<PortalChildDetail>(getToken, 'GET', `/portal/children/${enc(id)}`)
export const portalFinance = (getToken: TokenGetter, id: string) =>
  api<{
    balance: number
    /** SAMS 11.1: null when the school takes no online payments. */
    onlinePayment: { currency: string } | null
    invoices: PortalInvoice[]
    receipts: PortalReceipt[]
  }>(getToken, 'GET', `/portal/children/${enc(id)}/finance`)
export const portalDocuments = (getToken: TokenGetter, id: string) =>
  api<{ documents: PortalDocument[] }>(getToken, 'GET', `/portal/children/${enc(id)}/documents`)
export const portalDocumentLink = (getToken: TokenGetter, id: string, download = false) =>
  api<{ token: string; expiresAt: string }>(getToken, 'POST', `/portal/documents/${enc(id)}/link`, { download })
export const portalAnnouncements = (getToken: TokenGetter) =>
  api<{ announcements: PortalAnnouncement[] }>(getToken, 'GET', '/portal/announcements')

/** A signed URL to one shared document, valid for a few minutes. */
export async function portalFileUrl(getToken: TokenGetter, id: string, download = false) {
  const res = await portalDocumentLink(getToken, id, download)
  if (res.kind !== 'ok') return res
  const base = loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
  return {
    kind: 'ok' as const,
    data: `${base}/documents/file?token=${encodeURIComponent(res.data.token)}`,
  }
}
