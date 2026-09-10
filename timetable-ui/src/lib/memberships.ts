import { loadSyncSettings } from './sync'

/**
 * Client for the signed-in user's own `/memberships` — a school managing its
 * own staff. Distinct from the platform console, which is vendor-only and
 * can reach any school; this only ever touches the caller's own tenant,
 * because the server derives it from the JWT, never a parameter.
 */

export type MemberRole = 'owner' | 'admin' | 'scheduler' | 'viewer'

export interface Member {
  userId: string
  role: MemberRole
  email: string | null
  displayName: string | null
  active: boolean
  /** null = every branch (the owner/admin default). */
  branchIds: string[] | null
}

export type InviteOutcome = 'invited' | 'added' | 'already_member'

export type MembershipsResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, accessToken: string): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  })
}

async function parse<T>(response: Response): Promise<MembershipsResult<T>> {
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

export async function listMembers(accessToken: string): Promise<MembershipsResult<Member[]>> {
  try {
    const response = await call('/memberships', { method: 'GET' }, accessToken)
    const result = await parse<{ members: Member[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.members } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function inviteMember(
  accessToken: string,
  email: string,
  role: MemberRole,
): Promise<MembershipsResult<{ outcome: InviteOutcome }>> {
  try {
    const response = await call(
      '/memberships/invite',
      { method: 'POST', body: JSON.stringify({ email, role }) },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function changeMemberRole(
  accessToken: string,
  userId: string,
  role: MemberRole,
): Promise<MembershipsResult<null>> {
  try {
    const response = await call(
      `/memberships/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: JSON.stringify({ role }) },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function setMemberBranches(
  accessToken: string,
  userId: string,
  branchIds: string[] | null,
): Promise<MembershipsResult<{ ok: true; branchIds: string[] | null }>> {
  try {
    const response = await call(
      `/memberships/${encodeURIComponent(userId)}/branches`,
      { method: 'PATCH', body: JSON.stringify({ branchIds }) },
      accessToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function removeMember(accessToken: string, userId: string): Promise<MembershipsResult<null>> {
  try {
    const response = await call(`/memberships/${encodeURIComponent(userId)}`, { method: 'DELETE' }, accessToken)
    if (response.status === 204) return { kind: 'ok', data: null }
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
