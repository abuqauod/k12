import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/** Client for `/audit-log` — the school's activity trail (admin only). */

export interface AuditEntry {
  id: string
  actorId: string | null
  action: string
  entity: string | null
  entityId: string | null
  branchId: string | null
  meta: Record<string, unknown>
  /** SAMS 1.12 — null on older rows and background jobs. */
  ip?: string | null
  userAgent?: string | null
  reason?: string | null
  createdAt: string
}

export type AuditResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

export interface AuditLogFilters {
  entity?: string
  entityId?: string
  actorId?: string
  action?: string
  branchId?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
}

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

function toQuery(filters: AuditLogFilters): string {
  const params = new URLSearchParams()
  if (filters.entity) params.set('entity', filters.entity)
  if (filters.entityId) params.set('entityId', filters.entityId)
  if (filters.actorId) params.set('actorId', filters.actorId)
  if (filters.action) params.set('action', filters.action)
  if (filters.branchId) params.set('branchId', filters.branchId)
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
  if (filters.dateTo) params.set('dateTo', filters.dateTo)
  if (filters.limit) params.set('limit', String(filters.limit))
  return params.toString()
}

export async function listAuditLog(
  getToken: TokenGetter,
  filters: AuditLogFilters = {},
): Promise<AuditResult<AuditEntry[]>> {
  try {
    const response = await authorizedFetch(`${baseUrl()}/audit-log?${toQuery(filters)}`, {}, getToken)
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      /* keep null */
    }
    if (!response.ok) {
      return { kind: 'error', error: (body as { error?: string } | null)?.error ?? `HTTP_${response.status}` }
    }
    return { kind: 'ok', data: (body as { entries: AuditEntry[] }).entries }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

/** Downloads the CSV export directly — the endpoint needs the bearer token,
 * so this fetches the file as a blob and triggers the save via an object
 * URL rather than a plain `<a href>` (which can't carry an Authorization
 * header). */
export async function exportAuditLog(
  getToken: TokenGetter,
  filters: AuditLogFilters = {},
): Promise<AuditResult<void>> {
  try {
    const response = await authorizedFetch(`${baseUrl()}/audit-log/export?${toQuery(filters)}`, {}, getToken)
    if (!response.ok) {
      let error = `HTTP_${response.status}`
      try {
        const body = JSON.parse(await response.text()) as { error?: string }
        if (body?.error) error = body.error
      } catch {
        /* keep the HTTP_ fallback */
      }
      return { kind: 'error', error }
    }
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const match = /filename="([^"]+)"/.exec(disposition)
    const filename = match?.[1] ?? `audit-log-${Date.now()}.csv`
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(url)
    return { kind: 'ok', data: undefined }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
