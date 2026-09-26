import type { TokenGetter } from './http'
import { api, enc, pick, qs } from './apiClient'

/** Client for the SAMS Phase 6 staff routes: inbox, announcements,
 * templates, communication settings, fee reminders, the delivery log and
 * a parent's portal access. */

export type MessageKind =
  | 'absence'
  | 'announcement'
  | 'fee_reminder'
  | 'payment_received'
  | 'admission_decision'
  | 'document_rejected'
  | 'document_expiring'
  | 'approval_decided'
  | 'report_ready'
  | 'clinic_visit'
  | 'incident'

// ---------------------------------------------------------------- inbox --

export interface InboxItem {
  id: string
  kind: MessageKind
  title: string
  body: string
  link: string | null
  createdAt: string
  readAt: string | null
}

export const listInbox = (getToken: TokenGetter, unread = false) =>
  api<{ items: InboxItem[]; unread: number }>(getToken, 'GET', `/inbox${qs({ unread })}`)
export const markRead = (getToken: TokenGetter, id: string) => api<{ ok: true }>(getToken, 'POST', `/inbox/${enc(id)}/read`, {})
export const markAllRead = (getToken: TokenGetter) => api<{ updated: number }>(getToken, 'POST', '/inbox/read-all', {})

// -------------------------------------------------------- announcements --

export type AudienceType = 'school' | 'branch' | 'grade' | 'class' | 'bus'
export interface Audience {
  type: AudienceType
  branchId: string | null
  gradeLevels: string[]
  classIds: string[]
  busIds: string[]
}
export type Channel = 'email' | 'sms'
export interface Announcement {
  id: string
  title: string
  body: string
  titleAr: string | null
  bodyAr: string | null
  audience: Audience
  channels: Channel[]
  status: 'draft' | 'published' | 'archived'
  students: number
  sent: { families: number; inApp: number; email: number; sms: number } | null
  publishedAt: string | null
  createdAt: string
  /** On detail reads: students it reaches (a draft: today). */
  reach?: number
}
export interface AnnouncementInput {
  title: string
  body: string
  titleAr: string | null
  bodyAr: string | null
  audience: Audience
  channels: Channel[]
}

export const listAnnouncements = (getToken: TokenGetter, params: { status?: string; branchId?: string } = {}) =>
  pick(api<{ announcements: Announcement[] }>(getToken, 'GET', `/announcements${qs(params)}`), 'announcements')
export const getAnnouncement = (getToken: TokenGetter, id: string) => api<Announcement>(getToken, 'GET', `/announcements/${enc(id)}`)
export const createAnnouncement = (getToken: TokenGetter, body: AnnouncementInput) =>
  api<Announcement>(getToken, 'POST', '/announcements', body)
export const updateAnnouncement = (getToken: TokenGetter, id: string, body: Partial<AnnouncementInput>) =>
  api<Announcement>(getToken, 'PATCH', `/announcements/${enc(id)}`, body)
export const publishAnnouncement = (getToken: TokenGetter, id: string) =>
  api<Announcement>(getToken, 'POST', `/announcements/${enc(id)}/publish`, {})
export const archiveAnnouncement = (getToken: TokenGetter, id: string) =>
  api<Announcement>(getToken, 'POST', `/announcements/${enc(id)}/archive`, {})

// ------------------------------------------------------------ templates --

export interface Template {
  kind: Exclude<MessageKind, 'absence'>
  tokens: string[]
  customised: boolean
  enabled: boolean
  subject: string
  body: string
  smsBody: string
  subjectAr: string
  bodyAr: string
  smsBodyAr: string
}
export type TemplateInput = Omit<Template, 'kind' | 'tokens' | 'customised'>

export const listTemplates = (getToken: TokenGetter) =>
  pick(api<{ templates: Template[] }>(getToken, 'GET', '/communication/templates'), 'templates')
export const saveTemplate = (getToken: TokenGetter, kind: string, body: TemplateInput) =>
  api<Template>(getToken, 'PUT', `/communication/templates/${enc(kind)}`, body)
export const resetTemplate = (getToken: TokenGetter, kind: string) =>
  api<Template>(getToken, 'DELETE', `/communication/templates/${enc(kind)}`)

// ------------------------------------------------------------- settings --

export interface CommunicationSettings {
  feeReminders: { auto: boolean; daysBefore: number; repeatDays: number }
  documentExpiry: { auto: boolean; daysBefore: number }
  portalDocumentCategories: string[]
  lastRunDate: string | null
}
export const getCommunicationSettings = (getToken: TokenGetter) => api<CommunicationSettings>(getToken, 'GET', '/communication/settings')
export const saveCommunicationSettings = (getToken: TokenGetter, body: Partial<Omit<CommunicationSettings, 'lastRunDate'>>) =>
  api<CommunicationSettings>(getToken, 'PUT', '/communication/settings', body)

export interface Delivered {
  families: number
  inApp: number
  email: number
  sms: number
}
export const sendExpiringDocuments = (getToken: TokenGetter, daysBefore?: number) =>
  api<Delivered & { documents: number }>(getToken, 'POST', '/communication/documents-expiring/send', { daysBefore })

// -------------------------------------------------------- fee reminders --

export interface DueRow {
  invoiceId: string
  invoiceNumber: string
  studentId: string
  studentName: string
  branchId: string
  dueDate: string
  amountDue: number
  overdue: boolean
  remindedAt: string | null
  recent: boolean
}
export const previewReminders = (getToken: TokenGetter, params: { branchId?: string; daysBefore?: number }) =>
  pick(api<{ invoices: DueRow[] }>(getToken, 'GET', `/finance/reminders${qs(params)}`), 'invoices')
export const sendFeeReminders = (getToken: TokenGetter, body: { branchId?: string; daysBefore?: number; invoiceIds?: string[] }) =>
  api<Delivered & { invoices: number; skippedRecent: number; unreachable: number }>(getToken, 'POST', '/finance/reminders/send', body)

// --------------------------------------------------------- delivery log --

export type JobStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'dead' | 'skipped'
export interface LogEntry {
  id: string
  kind: MessageKind
  sourceId: string | null
  branchId: string
  studentId: string | null
  recipientId: string
  recipientName: string
  channel: Channel
  to: string
  subject: string
  status: JobStatus
  attempts: number
  error: string | null
  createdAt: string
  updatedAt: string
}
export const listDeliveryLog = (getToken: TokenGetter, params: { kind?: string; status?: string; branchId?: string }) =>
  api<{
    entries: LogEntry[]
    counts: { pending: number; failed: number; dead: number }
  }>(getToken, 'GET', `/communication/log${qs(params)}`)
export const retryMessage = (getToken: TokenGetter, id: string) =>
  api<LogEntry>(getToken, 'POST', `/communication/log/${enc(id)}/retry`, {})

// ------------------------------------------------------- portal access --

export interface PortalAccess {
  enabled: boolean
  email: string | null
  account: 'none' | 'invited' | 'active' | 'disabled'
  lastLoginAt: string | null
  children?: {
    studentId: string
    name: string
    portalAccess: boolean
    financialResponsibility: boolean
  }[]
  emailSent?: boolean
  emailError?: string | null
}
export const getPortalAccess = (getToken: TokenGetter, parentId: string) =>
  api<PortalAccess>(getToken, 'GET', `/parents/${enc(parentId)}/portal`)
export const enablePortal = (getToken: TokenGetter, parentId: string) =>
  api<PortalAccess>(getToken, 'POST', `/parents/${enc(parentId)}/portal/enable`, {})
export const resendPortalInvite = (getToken: TokenGetter, parentId: string) =>
  api<{ emailSent: boolean; emailError: string | null }>(getToken, 'POST', `/parents/${enc(parentId)}/portal/resend`, {})
export const disablePortal = (getToken: TokenGetter, parentId: string) =>
  api<PortalAccess>(getToken, 'POST', `/parents/${enc(parentId)}/portal/disable`, {})

// ---------------------------------------------------- delivery channels --

export interface ChannelStatus {
  email: { configured: boolean; from: string | null }
  sms: { configured: boolean; provider: 'twilio' | 'webhook' | 'log' | null }
}
export const getChannels = (getToken: TokenGetter) => api<ChannelStatus>(getToken, 'GET', '/communication/channels')
export const testSend = (getToken: TokenGetter, channel: Channel, to: string) =>
  api<{ ok: true; providerMessageId: string | null }>(getToken, 'POST', '/communication/test-send', { channel, to })
export const retryAllFailed = (getToken: TokenGetter, body: { kind?: string; error?: string } = {}) =>
  api<{ requeued: number }>(getToken, 'POST', '/communication/log/retry', body)
