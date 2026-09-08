import { loadSyncSettings } from './sync'

/**
 * Client for the signed-in user's own `/api-keys` — a school's admin
 * managing that school's machine-to-machine keys (see
 * `server/src/apikeys/`). Uses the same server address as dataset sync;
 * this is a Settings-page feature, not something the solver or dashboard
 * ever calls.
 */

export type ApiKeyRole = 'admin' | 'scheduler' | 'viewer'

export interface ApiKeySummary {
  id: string
  name: string
  preview: string
  role: ApiKeyRole
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
}

export type ApiKeysResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, accessToken: string): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  })
}

async function parse<T>(response: Response): Promise<ApiKeysResult<T>> {
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

export async function listApiKeys(accessToken: string): Promise<ApiKeysResult<ApiKeySummary[]>> {
  try {
    const response = await call('/api-keys', { method: 'GET' }, accessToken)
    const result = await parse<{ keys: ApiKeySummary[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.keys } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function createApiKey(
  accessToken: string,
  name: string,
  role: ApiKeyRole,
): Promise<ApiKeysResult<{ id: string; key: string; preview: string }>> {
  try {
    const response = await call('/api-keys', { method: 'POST', body: JSON.stringify({ name, role }) }, accessToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function revokeApiKey(accessToken: string, id: string): Promise<ApiKeysResult<null>> {
  try {
    const response = await call(`/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }, accessToken)
    if (response.status === 204) return { kind: 'ok', data: null }
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
