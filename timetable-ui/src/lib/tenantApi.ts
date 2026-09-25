import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/** Client for `GET /tenant` — the school's own organization profile and
 * subscription status. Read-only: identity/billing fields are vendor-
 * provisioned (see server/src/tenant/routes.ts), this just makes them
 * visible instead of only ever surfacing as a blocked-request error. */

export type TenantResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

export interface TenantProfile {
  id: string
  name: string
  plan: string
  status: 'active' | 'suspended' | 'cancelled'
  validUntil: string | null
  graceDays: number
  /** School-editable contact details (SAMS 1.11). */
  profile: ContactProfile
}

export interface ContactProfile {
  nameAr: string | null
  phone: string | null
  email: string | null
  address: string | null
  website: string | null
  taxNumber: string | null
}

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

export async function getTenant(getToken: TokenGetter): Promise<TenantResult<TenantProfile>> {
  try {
    const response = await authorizedFetch(`${baseUrl()}/tenant`, { method: 'GET' }, getToken)
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
    return { kind: 'ok', data: body as TenantProfile }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

/** `PATCH /tenant` — only the contact profile; everything else is vendor-only. */
export async function updateTenantProfile(
  getToken: TokenGetter,
  profile: Partial<ContactProfile>,
): Promise<TenantResult<{ profile: ContactProfile }>> {
  try {
    const response = await authorizedFetch(
      `${baseUrl()}/tenant`,
      { method: 'PATCH', body: JSON.stringify({ profile }) },
      getToken,
    )
    const text = await response.text()
    const body = text ? (JSON.parse(text) as unknown) : null
    if (!response.ok) {
      return { kind: 'error', error: (body as { error?: string } | null)?.error ?? `HTTP_${response.status}` }
    }
    return { kind: 'ok', data: body as { profile: ContactProfile } }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
