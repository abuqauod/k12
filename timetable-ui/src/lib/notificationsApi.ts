import { loadSyncSettings } from './sync'

/**
 * Client for the absence-notification feature: per-branch settings, the send
 * log, and the manual "notify now" trigger. The scheduled sweep on the
 * server hits the same code path as the trigger.
 */

export type NotifyChannel = 'email' | 'sms'

export interface NotificationSettings {
  absenceNotifyEnabled: boolean
  cutoffTime: string
  channels: NotifyChannel[]
  notifyOnUnmarked: boolean
  schoolDays: number[]
  emailSubject: string
  emailBody: string
  smsBody: string
  lastSweptDate: string | null
}

export interface NotificationLogEntry {
  id: string
  branchId: string
  studentId: string
  date: string
  channel: NotifyChannel
  to: string
  guardianName: string
  status: 'sent' | 'failed' | 'skipped'
  error: string | null
  trigger: 'auto' | 'manual'
  actorId: string | null
  createdAt: string
}

export interface NotifyOutcome {
  branchId: string
  date: string
  attempted: number
  sent: number
  failed: number
  skipped: number
}

export type NotificationsResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, accessToken: string): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  })
}

async function parse<T>(response: Response): Promise<NotificationsResult<T>> {
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

export async function getNotificationSettings(
  accessToken: string,
  branchId: string,
): Promise<NotificationsResult<NotificationSettings>> {
  try {
    const response = await call(
      `/branches/${encodeURIComponent(branchId)}/notification-settings`,
      { method: 'GET' },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function putNotificationSettings(
  accessToken: string,
  branchId: string,
  settings: Omit<NotificationSettings, 'lastSweptDate'>,
): Promise<NotificationsResult<{ ok: true }>> {
  try {
    const response = await call(
      `/branches/${encodeURIComponent(branchId)}/notification-settings`,
      { method: 'PUT', body: JSON.stringify(settings) },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function listNotifications(
  accessToken: string,
  params: { branchId?: string; date?: string; studentId?: string; limit?: number } = {},
): Promise<NotificationsResult<NotificationLogEntry[]>> {
  try {
    const query = new URLSearchParams()
    if (params.branchId) query.set('branchId', params.branchId)
    if (params.date) query.set('date', params.date)
    if (params.studentId) query.set('studentId', params.studentId)
    if (params.limit) query.set('limit', String(params.limit))
    const qs = query.toString()
    const response = await call(`/notifications${qs ? `?${qs}` : ''}`, { method: 'GET' }, accessToken)
    const result = await parse<{ entries: NotificationLogEntry[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.entries } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function runAbsenceNotifications(
  accessToken: string,
  input: { branchId: string; date?: string; studentId?: string },
): Promise<NotificationsResult<NotifyOutcome>> {
  try {
    const response = await call(
      '/notifications/run',
      { method: 'POST', body: JSON.stringify(input) },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
