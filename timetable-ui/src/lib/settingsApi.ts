import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/** Client for settings lists (SAMS 1.11, server/src/settings). */

export type LookupKind = 'paymentMethod' | 'documentCategory' | 'admissionSource' | 'withdrawalReason'

export interface LookupItem {
  code: string
  label: string
  labelAr: string | null
  active: boolean
  order: number
  builtIn: boolean
}

export type SettingsResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

export async function settingsRequest<T>(
  path: string,
  init: RequestInit,
  getToken: TokenGetter,
): Promise<SettingsResult<T>> {
  try {
    const response = await authorizedFetch(`${baseUrl()}${path}`, init, getToken)
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
    return { kind: 'ok', data: body as T }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function listLookups(
  getToken: TokenGetter,
  kind: LookupKind,
  includeInactive = false,
): Promise<SettingsResult<LookupItem[]>> {
  const result = await settingsRequest<{ items: LookupItem[] }>(
    `/settings/lookups/${kind}${includeInactive ? '?includeInactive=1' : ''}`,
    { method: 'GET' },
    getToken,
  )
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.items } : result
}

export function createLookup(
  getToken: TokenGetter,
  kind: LookupKind,
  body: { code: string; label: string; labelAr: string | null },
): Promise<SettingsResult<LookupItem>> {
  return settingsRequest(`/settings/lookups/${kind}`, { method: 'POST', body: JSON.stringify(body) }, getToken)
}

export function updateLookup(
  getToken: TokenGetter,
  kind: LookupKind,
  code: string,
  body: Partial<Pick<LookupItem, 'label' | 'labelAr' | 'active' | 'order'>>,
): Promise<SettingsResult<LookupItem>> {
  return settingsRequest(
    `/settings/lookups/${kind}/${encodeURIComponent(code)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    getToken,
  )
}

/** A lookup's display label in the active language — the lookup itself
 * first (covers school-created codes), else `fallback` (e.g. a translation
 * for a built-in), else the raw code. */
export function lookupLabel(items: LookupItem[], code: string, lang: string, fallback?: string): string {
  const item = items.find((i) => i.code === code)
  if (item) return (lang === 'ar' && item.labelAr) || item.label
  return fallback ?? code
}
