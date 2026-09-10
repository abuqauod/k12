import { loadSyncSettings } from './sync'
import type { Branch, NewBranch } from '../domain/branches'

/** Client for `/branches` — the campuses of the signed-in user's school. */

export type BranchesResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, accessToken: string): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  })
}

async function parse<T>(response: Response): Promise<BranchesResult<T>> {
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

export async function listBranches(accessToken: string): Promise<BranchesResult<Branch[]>> {
  try {
    const response = await call('/branches', { method: 'GET' }, accessToken)
    const result = await parse<{ branches: Branch[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.branches } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function createBranch(
  accessToken: string,
  branch: NewBranch,
): Promise<BranchesResult<Branch>> {
  try {
    const response = await call('/branches', { method: 'POST', body: JSON.stringify(branch) }, accessToken)
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateBranch(
  accessToken: string,
  id: string,
  patch: Partial<NewBranch> & { active?: boolean },
): Promise<BranchesResult<Branch>> {
  try {
    const response = await call(
      `/branches/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
