import { loadSyncSettings } from './sync'

/** Client for enrollment history and the operations that change it —
 * transfer, withdraw, bulk class assignment. */

export type EnrollmentStatus = 'active' | 'withdrawn' | 'graduated' | 'transferred'

export interface Enrollment {
  id: string
  studentId: string
  branchId: string
  classId: string
  academicYearId: string
  startDate: string
  endDate: string | null
  status: EnrollmentStatus
  supersededBy: string | null
  reason: string | null
  createdAt: string
}

export interface BulkAssignRow {
  studentId: string
  outcome: 'transferred' | 'enrolled' | 'unchanged' | 'error'
  error?: string
}

export type EnrollmentsResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, accessToken: string): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  })
}

async function parse<T>(response: Response): Promise<EnrollmentsResult<T>> {
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

export async function getEnrollments(
  accessToken: string,
  studentId: string,
): Promise<EnrollmentsResult<Enrollment[]>> {
  try {
    const response = await call(
      `/students/${encodeURIComponent(studentId)}/enrollments`,
      { method: 'GET' },
      accessToken,
    )
    const result = await parse<{ enrollments: Enrollment[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.enrollments } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function transferStudent(
  accessToken: string,
  studentId: string,
  input: { toClassId: string; effectiveDate?: string; reason?: string | null },
): Promise<EnrollmentsResult<{ from: Enrollment; to: Enrollment }>> {
  try {
    const response = await call(
      `/students/${encodeURIComponent(studentId)}/transfer`,
      { method: 'POST', body: JSON.stringify(input) },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function withdrawStudent(
  accessToken: string,
  studentId: string,
  input: { status: 'withdrawn' | 'graduated'; effectiveDate?: string; reason?: string | null },
): Promise<EnrollmentsResult<{ enrollment: Enrollment }>> {
  try {
    const response = await call(
      `/students/${encodeURIComponent(studentId)}/withdraw`,
      { method: 'POST', body: JSON.stringify(input) },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function bulkAssign(
  accessToken: string,
  input: { studentIds: string[]; toClassId: string; effectiveDate?: string; reason?: string | null },
): Promise<EnrollmentsResult<{ summary: Record<string, number>; rows: BulkAssignRow[] }>> {
  try {
    const response = await call(
      '/enrollments/bulk-assign',
      { method: 'POST', body: JSON.stringify(input) },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
