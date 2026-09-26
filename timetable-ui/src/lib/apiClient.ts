import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/**
 * A small typed client shared by the HR and operations APIs (SAMS Phases
 * 4–5): one call shape, errors as `{ kind: 'error', error: CODE }` with any
 * extra fields the server sent.
 */

export type ApiResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string; details?: Record<string, unknown> }

const baseUrl = () => loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')

export async function api<T>(getToken: TokenGetter, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const init: RequestInit = { method }
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await authorizedFetch(`${baseUrl()}${path}`, init, getToken)
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      /* keep null */
    }
    if (!response.ok) {
      const b = (parsed ?? {}) as { error?: string } & Record<string, unknown>
      return { kind: 'error', error: b.error ?? `HTTP_${response.status}`, details: b }
    }
    return { kind: 'ok', data: parsed as T }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

/** A query string from the set values only. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const enc = encodeURIComponent

/** `{ key: T }` → T. */
export async function pick<K extends string, T>(res: Promise<ApiResult<Record<K, T>>>, key: K): Promise<ApiResult<T>> {
  const r = await res
  return r.kind === 'ok' ? { kind: 'ok', data: r.data[key] } : r
}
