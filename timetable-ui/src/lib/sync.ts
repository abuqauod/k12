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
 */

export type SyncState = 'idle' | 'syncing' | 'synced' | 'conflict' | 'error' | 'unconfigured'

export interface SyncSettings {
  baseUrl: string
  schoolId: string
  /** Sent as `Authorization: Bearer …` when present. */
  token: string
}

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

export const EMPTY_SYNC_SETTINGS: SyncSettings = { baseUrl: '', schoolId: 'default', token: '' }

const SETTINGS_KEY = 'timetable.sync'

export function loadSyncSettings(): SyncSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...EMPTY_SYNC_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<SyncSettings>
    return {
      baseUrl: parsed.baseUrl ?? '',
      schoolId: parsed.schoolId || 'default',
      token: parsed.token ?? '',
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

function headers(settings: SyncSettings): HeadersInit {
  const out: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.token.trim()) out.Authorization = `Bearer ${settings.token.trim()}`
  return out
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

export async function pullDataset(settings: SyncSettings): Promise<PullResult> {
  if (!isConfigured(settings)) return { kind: 'error', message: 'NOT_CONFIGURED' }
  try {
    const response = await request(endpoint(settings), {
      method: 'GET',
      headers: headers(settings),
    })
    if (response.status === 404) return { kind: 'empty' }
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
): Promise<PushResult> {
  if (!isConfigured(settings)) return { kind: 'error', message: 'NOT_CONFIGURED' }
  try {
    const response = await request(endpoint(settings), {
      method: 'PUT',
      headers: headers(settings),
      body: JSON.stringify({ baseRevision, problem }),
    })
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

function describe(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'TIMEOUT'
  if (!navigator.onLine) return 'OFFLINE'
  return error instanceof Error ? error.message : 'UNKNOWN'
}
