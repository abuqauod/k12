import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/** Client for the shared approval engine (SAMS 1.10, server/src/approvals). */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface ApprovalComment {
  id: string
  actorId: string
  body: string
  at: string
  kind: 'request' | 'approve' | 'reject' | 'cancel'
}

export interface Approval {
  id: string
  type: string
  entity: string
  entityId: string
  branchId: string | null
  status: ApprovalStatus
  payload: Record<string, unknown>
  summary: string
  requestedBy: string
  decidedBy: string | null
  decidedAt: string | null
  comments: ApprovalComment[]
  createdAt: string
}

export interface ApprovalTypeInfo {
  type: string
  entity: string
  canRequest: boolean
  canDecide: boolean
}

export type ApprovalsResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function request<T>(path: string, init: RequestInit, getToken: TokenGetter): Promise<ApprovalsResult<T>> {
  try {
    const response = await authorizedFetch(`${baseUrl()}${path}`, init, getToken)
    const text = await response.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      /* keep null */
    }
    if (!response.ok) {
      return { kind: 'error', error: (body as { error?: string } | null)?.error ?? `HTTP_${response.status}` }
    }
    return { kind: 'ok', data: body as T }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function listApprovals(
  getToken: TokenGetter,
  filters: { view?: 'mine' | 'toDecide' | 'all'; status?: ApprovalStatus; entity?: string; entityId?: string } = {},
): Promise<ApprovalsResult<Approval[]>> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
  const result = await request<{ approvals: Approval[] }>(`/approvals?${params}`, { method: 'GET' }, getToken)
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.approvals } : result
}

export async function listApprovalTypes(getToken: TokenGetter): Promise<ApprovalsResult<ApprovalTypeInfo[]>> {
  const result = await request<{ types: ApprovalTypeInfo[] }>('/approvals/types', { method: 'GET' }, getToken)
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.types } : result
}

export function requestApproval(
  getToken: TokenGetter,
  body: { type: string; entityId: string; payload: Record<string, unknown>; comment: string | null },
): Promise<ApprovalsResult<Approval>> {
  return request('/approvals', { method: 'POST', body: JSON.stringify(body) }, getToken)
}

export function decideApproval(
  getToken: TokenGetter,
  id: string,
  action: 'approve' | 'reject' | 'cancel',
  comment: string | null,
): Promise<ApprovalsResult<Approval>> {
  return request(
    `/approvals/${encodeURIComponent(id)}/${action}`,
    { method: 'POST', body: JSON.stringify({ comment }) },
    getToken,
  )
}
