import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/** Client for the signed-in user's own `/attendance` — one school's daily register. */

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused' | 'early_departure'

export const ATTENDANCE_STATUSES: AttendanceStatus[] = [
  'present',
  'absent',
  'late',
  'excused',
  'early_departure',
]

export interface RegisterRow {
  studentId: string
  givenName: string
  familyName: string
  status: AttendanceStatus | null
  note: string | null
  /** Set when this mark has since been corrected. */
  updatedAt: string | null
}

export interface HistoryRow {
  date: string
  status: AttendanceStatus
  note: string | null
  classId?: string
  academicYearId?: string
}

export interface CorrectionRow {
  id: string
  date: string
  from: { status: AttendanceStatus; note: string | null }
  to: { status: AttendanceStatus; note: string | null }
  reason: string | null
  changedBy: string
  changedAt: string
}

export type AttendanceResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, getToken: TokenGetter): Promise<Response> {
  return authorizedFetch(`${baseUrl()}${path}`, init, getToken)
}

async function parse<T>(response: Response): Promise<AttendanceResult<T>> {
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

export interface Register {
  date: string
  classId: string
  branchId: string
  label: string
  students: RegisterRow[]
}

export async function getRegister(
  getToken: TokenGetter,
  date: string,
  classId: string,
): Promise<AttendanceResult<Register>> {
  try {
    const response = await call(
      `/attendance?date=${encodeURIComponent(date)}&classId=${encodeURIComponent(classId)}`,
      { method: 'GET' },
      getToken,
    )
    return parse<Register>(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export interface MarkOutcome {
  ok: true
  inserted: number
  corrected: number
  unchanged: number
  count: number
}

export async function markAttendance(
  getToken: TokenGetter,
  date: string,
  records: Array<{ studentId: string; status: AttendanceStatus; note?: string | null }>,
  reason?: string | null,
): Promise<AttendanceResult<MarkOutcome>> {
  try {
    const response = await call(
      '/attendance',
      { method: 'PUT', body: JSON.stringify({ date, reason: reason ?? null, records }) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function getStudentCorrections(
  getToken: TokenGetter,
  studentId: string,
): Promise<AttendanceResult<CorrectionRow[]>> {
  try {
    const response = await call(
      `/attendance/student/${encodeURIComponent(studentId)}/corrections`,
      { method: 'GET' },
      getToken,
    )
    const result = await parse<{ corrections: CorrectionRow[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.corrections } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function getStudentHistory(
  getToken: TokenGetter,
  studentId: string,
  from?: string,
  to?: string,
): Promise<AttendanceResult<HistoryRow[]>> {
  try {
    const query = new URLSearchParams()
    if (from) query.set('from', from)
    if (to) query.set('to', to)
    const qs = query.toString()
    const response = await call(
      `/attendance/student/${encodeURIComponent(studentId)}${qs ? `?${qs}` : ''}`,
      { method: 'GET' },
      getToken,
    )
    const result = await parse<{ records: HistoryRow[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.records } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
