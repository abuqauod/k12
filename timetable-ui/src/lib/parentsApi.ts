import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'
import type {
  DuplicateCandidate,
  Parent,
  ParentDetail,
  ParentStatus,
  ParentStudentLink,
  PreferredContactMethod,
} from '../domain/parents'

/** Client for the signed-in user's own `/parents` — the normalized Parent
 * Management model (server/src/parents/routes.ts), distinct from the
 * embedded guardians on a Student record (studentsApi.ts). */

export type ParentsResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, getToken: TokenGetter): Promise<Response> {
  return authorizedFetch(`${baseUrl()}${path}`, init, getToken)
}

async function parse<T>(response: Response): Promise<ParentsResult<T>> {
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

interface WireParent extends Omit<Parent, 'id'> {
  id: string
}

export async function listParents(
  getToken: TokenGetter,
  params: {
    search?: string
    studentName?: string
    branchId?: string
    classId?: string
    gradeLevel?: string
    status?: ParentStatus
  } = {},
): Promise<ParentsResult<Parent[]>> {
  try {
    const query = new URLSearchParams()
    if (params.search) query.set('search', params.search)
    if (params.studentName) query.set('studentName', params.studentName)
    if (params.branchId) query.set('branchId', params.branchId)
    if (params.classId) query.set('classId', params.classId)
    if (params.gradeLevel) query.set('gradeLevel', params.gradeLevel)
    if (params.status) query.set('status', params.status)
    const qs = query.toString()
    const response = await call(`/parents${qs ? `?${qs}` : ''}`, { method: 'GET' }, getToken)
    const result = await parse<{ parents: WireParent[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.parents } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function getParent(getToken: TokenGetter, id: string): Promise<ParentsResult<ParentDetail>> {
  try {
    const response = await call(`/parents/${encodeURIComponent(id)}`, { method: 'GET' }, getToken)
    return parse<ParentDetail>(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

/** What the create/edit form supplies — everything but server-derived fields. */
export type NewParent = Omit<
  Parent,
  'id' | 'status' | 'portalAccess' | 'linkedStudentCount' | 'createdAt' | 'updatedAt' | 'archivedAt'
> & {
  preferredContactMethod: PreferredContactMethod
  /** Only takes effect for an admin+ caller — the server enforces this. */
  portalAccessEnabled: boolean
}

export interface CreateParentResponse {
  parent: Parent
  warnings: DuplicateCandidate[]
}

export async function createParent(
  getToken: TokenGetter,
  parent: NewParent,
): Promise<ParentsResult<CreateParentResponse>> {
  try {
    const response = await call('/parents', { method: 'POST', body: JSON.stringify(parent) }, getToken)
    return parse<CreateParentResponse>(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateParent(
  getToken: TokenGetter,
  id: string,
  patch: Partial<NewParent>,
): Promise<ParentsResult<Parent & { warnings: DuplicateCandidate[] }>> {
  try {
    const response = await call(
      `/parents/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function archiveParent(getToken: TokenGetter, id: string, reason: string): Promise<ParentsResult<Parent>> {
  try {
    const response = await call(
      `/parents/${encodeURIComponent(id)}/archive`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function reactivateParent(getToken: TokenGetter, id: string): Promise<ParentsResult<Parent>> {
  try {
    const response = await call(`/parents/${encodeURIComponent(id)}/reactivate`, { method: 'POST' }, getToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export type NewLink = Omit<ParentStudentLink, 'id' | 'parentId' | 'active'>

export async function createParentLink(
  getToken: TokenGetter,
  parentId: string,
  link: NewLink,
): Promise<ParentsResult<ParentStudentLink>> {
  try {
    const response = await call(
      `/parents/${encodeURIComponent(parentId)}/links`,
      { method: 'POST', body: JSON.stringify(link) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateParentLink(
  getToken: TokenGetter,
  parentId: string,
  linkId: string,
  patch: Partial<NewLink>,
): Promise<ParentsResult<ParentStudentLink>> {
  try {
    const response = await call(
      `/parents/${encodeURIComponent(parentId)}/links/${encodeURIComponent(linkId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function deactivateParentLink(
  getToken: TokenGetter,
  parentId: string,
  linkId: string,
  reason: string,
): Promise<ParentsResult<ParentStudentLink>> {
  try {
    const response = await call(
      `/parents/${encodeURIComponent(parentId)}/links/${encodeURIComponent(linkId)}/deactivate`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
