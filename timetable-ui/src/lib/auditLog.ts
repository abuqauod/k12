import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/** Client for `/audit-log` — the school's activity trail (admin only). */

export interface AuditEntry {
  id: string
  actorId: string | null
  action: string
  entity: string | null
  entityId: string | null
  meta: Record<string, unknown>
  createdAt: string
}

export type AuditResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

export async function listAuditLog(
  getToken: TokenGetter,
  limit = 100,
): Promise<AuditResult<AuditEntry[]>> {
  try {
    const response = await authorizedFetch(`${baseUrl()}/audit-log?limit=${limit}`, {}, getToken)
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
