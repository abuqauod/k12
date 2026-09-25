import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/** Client for enrollment history and the operations that change it —
 * transfer, withdraw, re-enroll / plan a place, activate or cancel a
 * planned one, bulk class assignment. */

export type EnrollmentStatus = 'active' | 'pending' | 'withdrawn' | 'graduated' | 'transferred' | 'cancelled'

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
  /** A `withdrawalReason` code on a withdrawn row (SAMS 2.4). */
  reasonCode: string | null
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

async function call(path: string, init: RequestInit, getToken: TokenGetter): Promise<Response> {
  return authorizedFetch(`${baseUrl()}${path}`, init, getToken)
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
  getToken: TokenGetter,
  studentId: string,
): Promise<EnrollmentsResult<Enrollment[]>> {
  try {
    const response = await call(
      `/students/${encodeURIComponent(studentId)}/enrollments`,
      { method: 'GET' },
      getToken,
    )
    const result = await parse<{ enrollments: Enrollment[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.enrollments } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function transferStudent(
  getToken: TokenGetter,
  studentId: string,
  input: { toClassId: string; effectiveDate?: string; reason?: string | null },
): Promise<EnrollmentsResult<{ from: Enrollment; to: Enrollment }>> {
  try {
    const response = await call(
      `/students/${encodeURIComponent(studentId)}/transfer`,
      { method: 'POST', body: JSON.stringify(input) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function withdrawStudent(
  getToken: TokenGetter,
  studentId: string,
  input: {
    status: 'withdrawn' | 'graduated'
    effectiveDate?: string
    reason?: string | null
    reasonCode?: string | null
  },
): Promise<EnrollmentsResult<{ enrollment: Enrollment }>> {
  try {
    const response = await call(
      `/students/${encodeURIComponent(studentId)}/withdraw`,
      { method: 'POST', body: JSON.stringify(input) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function bulkAssign(
  getToken: TokenGetter,
  input: { studentIds: string[]; toClassId: string; effectiveDate?: string; reason?: string | null },
): Promise<EnrollmentsResult<{ summary: Record<string, number>; rows: BulkAssignRow[] }>> {
  try {
    const response = await call(
      '/enrollments/bulk-assign',
      { method: 'POST', body: JSON.stringify(input) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

/** Re-enroll now (`pending: false`) or plan a future place (`pending: true`). */
export async function openEnrollment(
  getToken: TokenGetter,
  studentId: string,
  input: { classId: string; startDate?: string; pending: boolean },
): Promise<EnrollmentsResult<{ enrollment: Enrollment }>> {
  try {
    const response = await call(
      `/students/${encodeURIComponent(studentId)}/enrollments`,
      { method: 'POST', body: JSON.stringify(input) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function activateEnrollment(
  getToken: TokenGetter,
  enrollmentId: string,
  startDate?: string,
): Promise<EnrollmentsResult<{ enrollment: Enrollment }>> {
  try {
    const response = await call(
      `/enrollments/${encodeURIComponent(enrollmentId)}/activate`,
      { method: 'POST', body: JSON.stringify(startDate ? { startDate } : {}) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function cancelEnrollment(
  getToken: TokenGetter,
  enrollmentId: string,
  reason: string,
): Promise<EnrollmentsResult<{ enrollment: Enrollment }>> {
  try {
    const response = await call(
      `/enrollments/${encodeURIComponent(enrollmentId)}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
