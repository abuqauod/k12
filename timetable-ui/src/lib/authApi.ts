import { loadSyncSettings } from './sync'

/**
 * Thin client for the backend's /auth endpoints. Uses the same server address
 * as dataset sync (`Settings → Sync → Server URL`) — one backend serves both.
 */

export type Role = 'owner' | 'admin' | 'scheduler' | 'viewer'

export interface AuthUser {
  id: string
  email: string
  displayName: string
  displayNameAr: string | null
  role: Role
}

export interface AuthTenant {
  id: string
  slug: string
  name: string
}

export interface TenantChoice {
  slug: string
  name: string
}

interface SessionTokens {
  accessToken: string
  refreshToken: string
}

export type LoginResult =
  | ({ kind: 'success' } & SessionTokens & { user: AuthUser; tenant: AuthTenant })
  | { kind: 'tenantRequired'; tenants: TenantChoice[] }
  | { kind: 'error'; error: string }

export type RefreshResult = ({ kind: 'success' } & SessionTokens) | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function post(path: string, body: unknown, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'TIMEOUT'
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'OFFLINE'
  return 'NETWORK_ERROR'
}

export async function login(
  email: string,
  password: string,
  tenantSlug?: string,
): Promise<LoginResult> {
  if (!baseUrl()) return { kind: 'error', error: 'NOT_CONFIGURED' }
  try {
    const response = await post('/auth/login', { email, password, tenantSlug })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>

    if (response.status === 200) {
      return {
        kind: 'success',
        accessToken: body.accessToken as string,
        refreshToken: body.refreshToken as string,
        user: body.user as AuthUser,
        tenant: body.tenant as AuthTenant,
      }
    }
    if (response.status === 300) {
      return { kind: 'tenantRequired', tenants: (body.tenants as TenantChoice[]) ?? [] }
    }
    return { kind: 'error', error: (body.error as string) ?? `HTTP_${response.status}` }
  } catch (error) {
    return { kind: 'error', error: describeNetworkError(error) }
  }
}

export async function refresh(refreshToken: string): Promise<RefreshResult> {
  if (!baseUrl()) return { kind: 'error', error: 'NOT_CONFIGURED' }
  try {
    const response = await post('/auth/refresh', { refreshToken })
    if (!response.ok) return { kind: 'error', error: `HTTP_${response.status}` }
    const body = (await response.json()) as SessionTokens
    return { kind: 'success', accessToken: body.accessToken, refreshToken: body.refreshToken }
  } catch (error) {
    return { kind: 'error', error: describeNetworkError(error) }
  }
}

/** Best-effort — the caller is logging out either way. */
export async function logout(refreshToken: string): Promise<void> {
  if (!baseUrl()) return
  try {
    await post('/auth/logout', { refreshToken })
  } catch {
    // Nothing to do — the refresh token will simply age out server-side.
  }
}

export type ActionResult = { kind: 'ok' } | { kind: 'error'; error: string }

/** The invite/reset link a school's owner or a forgotten-password email points at. */
export async function acceptInvite(token: string, password: string): Promise<ActionResult> {
  if (!baseUrl()) return { kind: 'error', error: 'NOT_CONFIGURED' }
  try {
    const response = await post('/auth/accept-invite', { token, password })
    if (response.ok) return { kind: 'ok' }
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    return { kind: 'error', error: body.error ?? `HTTP_${response.status}` }
  } catch (error) {
    return { kind: 'error', error: describeNetworkError(error) }
  }
}

export async function forgotPassword(email: string): Promise<ActionResult> {
  if (!baseUrl()) return { kind: 'error', error: 'NOT_CONFIGURED' }
  try {
    const response = await post('/auth/forgot-password', { email })
    if (response.ok) return { kind: 'ok' }
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    return { kind: 'error', error: body.error ?? `HTTP_${response.status}` }
  } catch (error) {
    return { kind: 'error', error: describeNetworkError(error) }
  }
}

export async function resetPassword(token: string, password: string): Promise<ActionResult> {
  if (!baseUrl()) return { kind: 'error', error: 'NOT_CONFIGURED' }
  try {
    const response = await post('/auth/reset-password', { token, password })
    if (response.ok) return { kind: 'ok' }
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    return { kind: 'error', error: body.error ?? `HTTP_${response.status}` }
  } catch (error) {
    return { kind: 'error', error: describeNetworkError(error) }
  }
}
