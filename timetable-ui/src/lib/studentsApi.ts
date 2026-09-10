import { loadSyncSettings } from './sync'
import type { Student, StudentStatus } from '../domain/students'

/**
 * Client for the signed-in user's own `/students` — the real, per-record
 * student roster (replacing the old whole-array blob sync at dataset key
 * "students"). Named studentsApi, not students, to not collide with the
 * domain module.
 */

export type StudentsResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, accessToken: string): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  })
}

async function parse<T>(response: Response): Promise<StudentsResult<T>> {
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

/** The wire shape a student comes back as — `id`, not `_id`, and the SIS
 * fields are always present (unlike the domain type, which makes them
 * optional so old transport-only records still parse). */
interface WireStudent extends Omit<Student, 'id' | 'active'> {
  id: string
  status: StudentStatus
}

function fromWire(w: WireStudent): Student {
  return { ...w, active: w.status === 'enrolled' }
}

export async function listStudents(
  accessToken: string,
  params: {
    branchId?: string
    classId?: string
    studentGroup?: string
    status?: StudentStatus
    search?: string
  } = {},
): Promise<StudentsResult<Student[]>> {
  try {
    const query = new URLSearchParams()
    if (params.branchId) query.set('branchId', params.branchId)
    if (params.classId) query.set('classId', params.classId)
    if (params.studentGroup) query.set('studentGroup', params.studentGroup)
    if (params.status) query.set('status', params.status)
    if (params.search) query.set('search', params.search)
    const qs = query.toString()
    const response = await call(`/students${qs ? `?${qs}` : ''}`, { method: 'GET' }, accessToken)
    const result = await parse<{ students: WireStudent[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.students.map(fromWire) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

/** What the create/update form supplies. `branchId` and the `studentGroup`
 * label are derived from `classId` server-side, so they're not sent. */
export type NewStudent = Omit<Student, 'id' | 'active' | 'branchId' | 'studentGroup' | 'classId'> & {
  classId: string
}

export async function createStudent(
  accessToken: string,
  student: NewStudent,
): Promise<StudentsResult<{ id: string }>> {
  try {
    const response = await call('/students', { method: 'POST', body: JSON.stringify(student) }, accessToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateStudent(
  accessToken: string,
  id: string,
  patch: Partial<NewStudent>,
): Promise<StudentsResult<Student>> {
  try {
    const response = await call(
      `/students/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      accessToken,
    )
    const result = await parse<WireStudent>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: fromWire(result.data) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
