import { loadSyncSettings } from './sync'
import type { NewClass, SchoolClass } from '../domain/classes'

/** Client for `/classes` — homeroom classes under a branch. */

export type ClassesResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, accessToken: string): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  })
}

async function parse<T>(response: Response): Promise<ClassesResult<T>> {
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

export async function listClasses(
  accessToken: string,
  params: { branchId?: string; includeInactive?: boolean } = {},
): Promise<ClassesResult<SchoolClass[]>> {
  try {
    const query = new URLSearchParams()
    if (params.branchId) query.set('branchId', params.branchId)
    if (params.includeInactive) query.set('includeInactive', 'true')
    const qs = query.toString()
    const response = await call(`/classes${qs ? `?${qs}` : ''}`, { method: 'GET' }, accessToken)
    const result = await parse<{ classes: SchoolClass[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.classes } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function createClass(
  accessToken: string,
  klass: NewClass,
): Promise<ClassesResult<SchoolClass>> {
  try {
    const response = await call('/classes', { method: 'POST', body: JSON.stringify(klass) }, accessToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function createSections(
  accessToken: string,
  input: { branchId: string; gradeLevel: string; capacity: number; sections: string[] },
): Promise<ClassesResult<{ created: SchoolClass[] }>> {
  try {
    const response = await call('/classes/bulk', { method: 'POST', body: JSON.stringify(input) }, accessToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateClass(
  accessToken: string,
  id: string,
  patch: Partial<Omit<NewClass, 'branchId'>> & { active?: boolean },
): Promise<ClassesResult<SchoolClass>> {
  try {
    const response = await call(
      `/classes/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function deleteClass(accessToken: string, id: string): Promise<ClassesResult<null>> {
  try {
    const response = await call(`/classes/${encodeURIComponent(id)}`, { method: 'DELETE' }, accessToken)
    if (response.status === 204) return { kind: 'ok', data: null }
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
