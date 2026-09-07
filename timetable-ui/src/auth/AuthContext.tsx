import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as authApi from '../lib/authApi'
import type { AuthTenant, AuthUser, TenantChoice } from '../lib/authApi'

export type { AuthTenant, AuthUser, TenantChoice }

export type SignInResult =
  | { ok: true }
  | { ok: false; needsTenant: true; tenants: TenantChoice[] }
  | { ok: false; needsTenant?: false; error: string }

interface StoredSession {
  refreshToken: string
  user: AuthUser
  tenant: AuthTenant
}

interface AuthValue {
  user: AuthUser | null
  tenant: AuthTenant | null
  signIn: (email: string, password: string, tenantSlug?: string) => Promise<SignInResult>
  signOut: () => void
  /**
   * Returns a usable access token — from memory if one's already held, or by
   * spending the refresh token if not (e.g. right after a page reload).
   * `force: true` skips the cached token; `sync.ts` calls that once after a
   * 401, since the access token is short-lived by design and can simply
   * expire mid-session.
   */
  getAccessToken: (force?: boolean) => Promise<string | null>
}

const AuthContext = createContext<AuthValue | null>(null)
const STORAGE_KEY = 'timetable.session'

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredSession) : null
  } catch {
    return null
  }
}

function writeStoredSession(session: StoredSession | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Session simply will not survive a reload.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Computed once, lazily, on mount — not a ref access, so it's safe to read
  // during render (unlike useRef(...).current, which oxlint correctly flags).
  const [initial] = useState(readStoredSession)
  const [user, setUser] = useState<AuthUser | null>(initial?.user ?? null)
  const [tenant, setTenant] = useState<AuthTenant | null>(initial?.tenant ?? null)

  // The access token is short-lived and kept in memory only; the refresh
  // token is the thing persisted, so "stay signed in" survives a reload.
  const accessTokenRef = useRef<string | null>(null)
  const refreshTokenRef = useRef<string | null>(initial?.refreshToken ?? null)
  const sessionRef = useRef<{ user: AuthUser; tenant: AuthTenant } | null>(
    initial ? { user: initial.user, tenant: initial.tenant } : null,
  )
  // Concurrent callers (a dashboard load kicking off several requests at
  // once) share one in-flight refresh rather than each spending the token.
  const refreshingRef = useRef<Promise<string | null> | null>(null)

  const applySession = useCallback(
    (accessToken: string, refreshToken: string, next: { user: AuthUser; tenant: AuthTenant }) => {
      accessTokenRef.current = accessToken
      refreshTokenRef.current = refreshToken
      sessionRef.current = next
      setUser(next.user)
      setTenant(next.tenant)
      writeStoredSession({ refreshToken, user: next.user, tenant: next.tenant })
    },
    [],
  )

  const clear = useCallback(() => {
    accessTokenRef.current = null
    refreshTokenRef.current = null
    sessionRef.current = null
    setUser(null)
    setTenant(null)
    writeStoredSession(null)
  }, [])

  const signIn = useCallback(
    async (email: string, password: string, tenantSlug?: string): Promise<SignInResult> => {
      const result = await authApi.login(email, password, tenantSlug)
      if (result.kind === 'success') {
        applySession(result.accessToken, result.refreshToken, { user: result.user, tenant: result.tenant })
        return { ok: true }
      }
      if (result.kind === 'tenantRequired') {
        return { ok: false, needsTenant: true, tenants: result.tenants }
      }
      return { ok: false, error: result.error }
    },
    [applySession],
  )

  const signOut = useCallback(() => {
    const token = refreshTokenRef.current
    clear()
    if (token) void authApi.logout(token)
  }, [clear])

  const getAccessToken = useCallback(async (force = false): Promise<string | null> => {
    if (accessTokenRef.current && !force) return accessTokenRef.current
    const refreshToken = refreshTokenRef.current
    if (!refreshToken) return null

    if (!refreshingRef.current) {
      refreshingRef.current = authApi
        .refresh(refreshToken)
        .then((result) => {
          if (result.kind === 'success' && sessionRef.current) {
            accessTokenRef.current = result.accessToken
            refreshTokenRef.current = result.refreshToken
            writeStoredSession({ refreshToken: result.refreshToken, ...sessionRef.current })
            return result.accessToken
          }
          // The refresh token is dead (expired, revoked, or reused) — the
          // session is over; RequireAuth will send the user back to /login.
          clear()
          return null
        })
        .finally(() => {
          refreshingRef.current = null
        })
    }
    return refreshingRef.current
  }, [clear])

  // Validate a restored session in the background: a dead refresh token
  // (expired after weeks away, or revoked) should log the user out promptly
  // rather than waiting for the first sync attempt to discover it.
  // `getAccessToken` and `initial` are both stable across renders, so this
  // runs exactly once despite listing them as dependencies.
  useEffect(() => {
    if (initial) void getAccessToken()
  }, [initial, getAccessToken])

  const value: AuthValue = { user, tenant, signIn, signOut, getAccessToken }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside an AuthProvider')
  return value
}
