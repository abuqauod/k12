import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/**
 * Client for the signed-in user's own `/memberships` — a school managing its
 * own staff. Distinct from the platform console, which is vendor-only and
 * can reach any school; this only ever touches the caller's own tenant,
 * because the server derives it from the JWT, never a parameter.
 */

export type MemberRole = 'owner' | 'admin' | 'scheduler' | 'viewer'

/** Named administrative presets (server: auth/scopes.ts). */
export const ROLE_KEYS = [
  'school_admin',
  'branch_admin',
  'registrar',
  'finance_officer',
  'hr',
  'operations',
  'reception',
] as const
export type RoleKey = (typeof ROLE_KEYS)[number]

/** What a role picker selects: a plain rank or a preset. */
export type RoleChoice = MemberRole | RoleKey

export const isPreset = (choice: RoleChoice): choice is RoleKey => (ROLE_KEYS as readonly string[]).includes(choice)

/** The request body for granting `choice`. */
function grantBody(choice: RoleChoice, branchIds?: string[] | null) {
  return isPreset(choice) ? { roleKey: choice, ...(branchIds !== undefined ? { branchIds } : {}) } : { role: choice }
}

export interface RoleCatalog {
  ranks: { rank: MemberRole; scopes: string[] }[]
  presets: { key: RoleKey; rank: MemberRole; requiresBranches: boolean; scopes: string[] }[]
}

export interface Member {
  userId: string
  role: MemberRole
  roleKey: RoleKey | null
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

async function call(path: string, init: RequestInit, getToken: TokenGetter): Promise<Response> {
  return authorizedFetch(`${baseUrl()}${path}`, init, getToken)
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

export async function listMembers(getToken: TokenGetter): Promise<MembershipsResult<Member[]>> {
  try {
    const response = await call('/memberships', { method: 'GET' }, getToken)
    const result = await parse<{ members: Member[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.members } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function inviteMember(
  getToken: TokenGetter,
  email: string,
  choice: RoleChoice,
  branchIds?: string[] | null,
): Promise<MembershipsResult<{ outcome: InviteOutcome }>> {
  try {
    const response = await call(
      '/memberships/invite',
      { method: 'POST', body: JSON.stringify({ email, ...grantBody(choice, branchIds) }) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function changeMemberRole(
  getToken: TokenGetter,
  userId: string,
  choice: RoleChoice,
  branchIds?: string[] | null,
): Promise<MembershipsResult<null>> {
  try {
    const response = await call(
      `/memberships/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: JSON.stringify(grantBody(choice, branchIds)) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function setMemberBranches(
  getToken: TokenGetter,
  userId: string,
  branchIds: string[] | null,
): Promise<MembershipsResult<{ ok: true; branchIds: string[] | null }>> {
  try {
    const response = await call(
      `/memberships/${encodeURIComponent(userId)}/branches`,
      { method: 'PATCH', body: JSON.stringify({ branchIds }) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function removeMember(getToken: TokenGetter, userId: string): Promise<MembershipsResult<null>> {
  try {
    const response = await call(`/memberships/${encodeURIComponent(userId)}`, { method: 'DELETE' }, getToken)
    if (response.status === 204) return { kind: 'ok', data: null }
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function getRoleCatalog(getToken: TokenGetter): Promise<MembershipsResult<RoleCatalog>> {
  try {
    return parse(await call('/memberships/roles', { method: 'GET' }, getToken))
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

/** The caller's own resolved access (`GET /auth/me`). */
export async function fetchMyAccess(
  getToken: TokenGetter,
): Promise<MembershipsResult<{ roleKey: RoleKey | null; scopes: string[] }>> {
  try {
    return parse(await call('/auth/me', { method: 'GET' }, getToken))
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
