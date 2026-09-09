import type { Problem } from '../domain/types'

/**
 * Sync client for the working dataset.
 *
 * The server contract is deliberately tiny — two endpoints against one document
 * per school, with an integer revision for optimistic concurrency:
 *
 *   GET  {baseUrl}/datasets/{schoolId}
 *        -> 200 { revision: number, updatedAt: string, problem: Problem }
 *        -> 404 when the school has never pushed
 *
 *   PUT  {baseUrl}/datasets/{schoolId}
 *        body { baseRevision: number, problem: Problem }
 *        -> 200 { revision, updatedAt }
 *        -> 409 { revision, updatedAt, problem }  when the server moved on
 *
 * A 409 is a real outcome, not an error: someone else saved first. The caller
 * decides whether to keep local work or take the server copy.
 *
 * Authentication is normally the signed-in user's session — see `getToken`
 * on every call below, which is `AuthContext`'s `getAccessToken`. Setting
 * `apiKey` switches every request to `X-Api-Key` instead, for syncing
 * without anyone logged in (a script, a scheduled task) — see
 * `server/src/apikeys/` for how a key is created and what it can do.
 */

export type SyncState = 'idle' | 'syncing' | 'synced' | 'conflict' | 'error' | 'unconfigured'

export interface SyncSettings {
  baseUrl: string
  schoolId: string
  /** When set, used instead of the signed-in user's session for every request. */
  apiKey?: string
}

/** A token getter: no-arg returns the cached token (refreshing if there is
 * none yet); `force: true` skips the cache — used after a 401. */
export type TokenGetter = (force?: boolean) => Promise<string | null>

export interface SyncStatus {
  state: SyncState
  /** ISO timestamp of the last successful exchange. */
  lastSyncedAt: string | null
  serverRevision: number | null
  message: string | null
}

export interface PullResult {
  kind: 'pulled' | 'empty' | 'error'
  problem?: Problem
  revision?: number
  updatedAt?: string
  message?: string
}

export interface PushResult {
  kind: 'pushed' | 'conflict' | 'error'
  revision?: number
  updatedAt?: string
  /** Present on a conflict: what the server currently holds. */
  serverProblem?: Problem
  message?: string
}

/** The backend this build ships pointed at by default; still editable in Settings. */
export const DEFAULT_BASE_URL = 'https://heymueen.com/api'

export const EMPTY_SYNC_SETTINGS: SyncSettings = { baseUrl: DEFAULT_BASE_URL, schoolId: 'default' }

const SETTINGS_KEY = 'timetable.sync'

export function loadSyncSettings(): SyncSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...EMPTY_SYNC_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<SyncSettings>
    return {
      baseUrl: parsed.baseUrl ?? DEFAULT_BASE_URL,
      schoolId: parsed.schoolId || 'default',
      apiKey: parsed.apiKey || undefined,
    }
  } catch {
    return { ...EMPTY_SYNC_SETTINGS }
  }
}

export function saveSyncSettings(settings: SyncSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Preference simply will not persist.
  }
}

export function isConfigured(settings: SyncSettings): boolean {
  return settings.baseUrl.trim().length > 0
}

function endpoint(settings: SyncSettings): string {
  const base = settings.baseUrl.trim().replace(/\/+$/, '')
  return `${base}/datasets/${encodeURIComponent(settings.schoolId || 'default')}`
}

/** Aborts rather than hanging when the server is unreachable. */
async function request(url: string, init: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * With `settings.apiKey` set, every request goes out with `X-Api-Key`
 * instead — no session, no refresh, nothing to retry (a key is either valid
 * or it isn't). Otherwise, attaches the current session token and retries
 * once, with a forced refresh, if the server says the token is no good —
 * covers the access token simply having expired mid-session (it's
 * short-lived by design).
 */
async function authorizedRequest(
  url: string,
  init: RequestInit,
  getToken: TokenGetter,
  settings: SyncSettings,
): Promise<Response> {
  if (settings.apiKey) {
    return request(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': settings.apiKey },
    })
  }

  const withAuth = async (token: string | null) =>
    request(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })

  const first = await withAuth(await getToken())
  if (first.status !== 401) return first
  return withAuth(await getToken(true))
}

export async function pullDataset(settings: SyncSettings, getToken: TokenGetter): Promise<PullResult> {
  if (!isConfigured(settings)) return { kind: 'error', message: 'NOT_CONFIGURED' }
  try {
    const response = await authorizedRequest(endpoint(settings), { method: 'GET' }, getToken, settings)
    if (response.status === 404) return { kind: 'empty' }
    if (response.status === 401) {
      return { kind: 'error', message: settings.apiKey ? 'API_KEY_INVALID' : 'SESSION_EXPIRED' }
    }
    if (!response.ok) return { kind: 'error', message: `HTTP ${response.status}` }
    const body = (await response.json()) as {
      revision: number
      updatedAt: string
      problem: Problem
    }
    if (!body?.problem?.lessons) return { kind: 'error', message: 'BAD_PAYLOAD' }
    return {
      kind: 'pulled',
      problem: body.problem,
      revision: body.revision,
      updatedAt: body.updatedAt,
    }
  } catch (error) {
    return { kind: 'error', message: describe(error) }
  }
}

export async function pushDataset(
  settings: SyncSettings,
  problem: Problem,
  baseRevision: number,
  getToken: TokenGetter,
): Promise<PushResult> {
  if (!isConfigured(settings)) return { kind: 'error', message: 'NOT_CONFIGURED' }
  try {
    const response = await authorizedRequest(
      endpoint(settings),
      { method: 'PUT', body: JSON.stringify({ baseRevision, problem }) },
      getToken,
      settings,
    )
    if (response.status === 401) {
      return { kind: 'error', message: settings.apiKey ? 'API_KEY_INVALID' : 'SESSION_EXPIRED' }
    }
    if (response.status === 409) {
      const body = (await response.json()) as {
        revision: number
        updatedAt: string
        problem: Problem
      }
      return {
        kind: 'conflict',
        revision: body.revision,
        updatedAt: body.updatedAt,
        serverProblem: body.problem,
      }
    }
    if (!response.ok) return { kind: 'error', message: `HTTP ${response.status}` }
    const body = (await response.json()) as { revision: number; updatedAt: string }
    return { kind: 'pushed', revision: body.revision, updatedAt: body.updatedAt }
  } catch (error) {
    return { kind: 'error', message: describe(error) }
  }
}

// ------------------------------------------------------------- generic doc --
// `pullDataset`/`pushDataset` above are the original, Problem-specific pair,
// kept as-is so nothing calling them has to change. These do the same thing
// for any other JSON-serializable document under a *fixed* key — e.g. a
// school's bus fleet at `fleet`, its roster at `students` — reusing the same
// `/datasets/:key` endpoint and revision/conflict model rather than standing
// up a separate API for each. The backend stores a document as an opaque
// blob regardless of key (see server/src/datasets/routes.ts), so this needs
// no server-side change beyond that.

export interface DocPullResult<T> {
  kind: 'pulled' | 'empty' | 'error'
  data?: T
  revision?: number
  updatedAt?: string
  message?: string
}

export interface DocPushResult<T> {
  kind: 'pushed' | 'conflict' | 'error'
  revision?: number
  updatedAt?: string
  /** Present on a conflict: what the server currently holds. */
  serverData?: T
  message?: string
}

function documentEndpoint(settings: SyncSettings, key: string): string {
  const base = settings.baseUrl.trim().replace(/\/+$/, '')
  return `${base}/datasets/${encodeURIComponent(key)}`
}

export async function pullDocument<T>(
  settings: SyncSettings,
  key: string,
  getToken: TokenGetter,
): Promise<DocPullResult<T>> {
  if (!isConfigured(settings)) return { kind: 'error', message: 'NOT_CONFIGURED' }
  try {
    const response = await authorizedRequest(documentEndpoint(settings, key), { method: 'GET' }, getToken, settings)
    if (response.status === 404) return { kind: 'empty' }
    if (response.status === 401) {
      return { kind: 'error', message: settings.apiKey ? 'API_KEY_INVALID' : 'SESSION_EXPIRED' }
    }
    if (!response.ok) return { kind: 'error', message: `HTTP ${response.status}` }
    const body = (await response.json()) as { revision: number; updatedAt: string; problem: T }
    return { kind: 'pulled', data: body.problem, revision: body.revision, updatedAt: body.updatedAt }
  } catch (error) {
    return { kind: 'error', message: describe(error) }
  }
}

export async function pushDocument<T>(
  settings: SyncSettings,
  key: string,
  data: T,
  baseRevision: number,
  getToken: TokenGetter,
): Promise<DocPushResult<T>> {
  if (!isConfigured(settings)) return { kind: 'error', message: 'NOT_CONFIGURED' }
  try {
    const response = await authorizedRequest(
      documentEndpoint(settings, key),
      { method: 'PUT', body: JSON.stringify({ baseRevision, problem: data }) },
      getToken,
      settings,
    )
    if (response.status === 401) {
      return { kind: 'error', message: settings.apiKey ? 'API_KEY_INVALID' : 'SESSION_EXPIRED' }
    }
    if (response.status === 409) {
      const body = (await response.json()) as { revision: number; updatedAt: string; problem: T }
      return { kind: 'conflict', revision: body.revision, updatedAt: body.updatedAt, serverData: body.problem }
    }
    if (!response.ok) return { kind: 'error', message: `HTTP ${response.status}` }
    const body = (await response.json()) as { revision: number; updatedAt: string }
    return { kind: 'pushed', revision: body.revision, updatedAt: body.updatedAt }
  } catch (error) {
    return { kind: 'error', message: describe(error) }
  }
}

function describe(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'TIMEOUT'
  if (!navigator.onLine) return 'OFFLINE'
  return error instanceof Error ? error.message : 'UNKNOWN'
}
