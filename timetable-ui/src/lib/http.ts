/**
 * Shared fetch plumbing for every authenticated API client. Pulled out of
 * `sync.ts` (which had this pattern first, for dataset sync) so the resource
 * APIs — classes, students, enrollments, attendance, notifications, branches
 * — get the same 401-retry behaviour instead of each re-inventing a
 * single-shot fetch that has no way to recover from an expired access token.
 */

/** A token getter: no-arg returns the cached token (refreshing if there is
 * none yet); `force: true` skips the cache — used after a 401. This is
 * `AuthContext`'s `getAccessToken`, passed straight through. */
export type TokenGetter = (force?: boolean) => Promise<string | null>

/** Aborts rather than hanging when the server is unreachable. */
export async function request(url: string, init: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Attaches the current session token and retries once, with a forced
 * refresh, if the server says the token is no good — covers the access
 * token simply having expired mid-session (it's short-lived by design, see
 * `server/src/config.ts`'s `accessTokenTtl`). `getToken(true)` either
 * returns a genuinely new token or `null` (and signs the user out) — never
 * the same stale one — so a second 401 after the retry is a real
 * "session over," not a bug.
 */
export async function authorizedFetch(
  url: string,
  init: RequestInit,
  getToken: TokenGetter,
): Promise<Response> {
  const withAuth = async (token: string | null) =>
    request(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })

  const first = await withAuth(await getToken())
  if (first.status !== 401) return first
  return withAuth(await getToken(true))
}
