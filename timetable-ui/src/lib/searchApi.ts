import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/** Client for `/search` — a small, tenant-scoped fan-out search across
 * students, parents, classes, buses and stops. */

export type SearchResultType = 'student' | 'parent' | 'class' | 'bus' | 'stop' | 'enrollment' | 'invoice' | 'payment'

export interface SearchResult {
  type: SearchResultType
  id: string
  label: string
  meta: string | null
  branchId: string | null
}

export type SearchApiResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, getToken: TokenGetter): Promise<Response> {
  return authorizedFetch(`${baseUrl()}${path}`, init, getToken)
}

async function parse<T>(response: Response): Promise<SearchApiResult<T>> {
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

export async function globalSearch(
  getToken: TokenGetter,
  params: { q: string; branchId?: string },
): Promise<SearchApiResult<SearchResult[]>> {
  try {
    const query = new URLSearchParams({ q: params.q })
    if (params.branchId) query.set('branchId', params.branchId)
    const response = await call(`/search?${query.toString()}`, { method: 'GET' }, getToken)
    const result = await parse<{ results: SearchResult[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.results } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
