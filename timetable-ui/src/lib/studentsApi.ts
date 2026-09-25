import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'
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

async function call(path: string, init: RequestInit, getToken: TokenGetter): Promise<Response> {
  return authorizedFetch(`${baseUrl()}${path}`, init, getToken)
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
 * optional so old transport-only records still parse). In practice a
 * handful of legacy records predate the fields the server now always
 * fills in (`givenName`/`familyName`/`primaryPhone`/`secondaryPhone`/
 * `stopId`/`transportMode`/`studentGroup`/`studentNumber`) and come back
 * with them missing entirely — `Partial` here, not the stricter shape the
 * type name implies, so TypeScript catches every place that needs a
 * fallback rather than trusting a contract the real data doesn't keep. */
interface WireStudent extends Partial<Omit<Student, 'id' | 'active'>> {
  id: string
  status: StudentStatus
}

function fromWire(w: WireStudent): Student {
  return {
    ...w,
    studentNumber: w.studentNumber ?? '',
    givenName: w.givenName ?? '',
    familyName: w.familyName ?? '',
    studentGroup: w.studentGroup ?? '',
    stopId: w.stopId ?? '',
    transportMode: w.transportMode ?? 'NONE',
    primaryPhone: w.primaryPhone ?? '',
    secondaryPhone: w.secondaryPhone ?? '',
    active: w.status === 'enrolled',
  }
}

export async function listStudents(
  getToken: TokenGetter,
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
    const response = await call(`/students${qs ? `?${qs}` : ''}`, { method: 'GET' }, getToken)
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

/** One student by id — e.g. to open `StudentDetailDialog` from a card that
 * only carries the id (a parent's linked-students list). */
export async function getStudent(getToken: TokenGetter, id: string): Promise<StudentsResult<Student>> {
  try {
    const response = await call(`/students/${encodeURIComponent(id)}`, { method: 'GET' }, getToken)
    const result = await parse<WireStudent>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: fromWire(result.data) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function createStudent(
  getToken: TokenGetter,
  student: NewStudent,
): Promise<StudentsResult<{ id: string }>> {
  try {
    const response = await call('/students', { method: 'POST', body: JSON.stringify(student) }, getToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateStudent(
  getToken: TokenGetter,
  id: string,
  patch: Partial<NewStudent>,
): Promise<StudentsResult<Student>> {
  try {
    const response = await call(
      `/students/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      getToken,
    )
    const result = await parse<WireStudent>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: fromWire(result.data) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

/** Permanent delete: the caller re-enters their own password. Refused for a
 * student with financial history (withdraw them instead). */
export async function deleteStudent(
  getToken: TokenGetter,
  id: string,
  password: string,
): Promise<StudentsResult<null>> {
  try {
    const response = await call(
      `/students/${encodeURIComponent(id)}`,
      { method: 'DELETE', body: JSON.stringify({ password }) },
      getToken,
    )
    if (response.status === 204) return { kind: 'ok', data: null }
    return parse<null>(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
