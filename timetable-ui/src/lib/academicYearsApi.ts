import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'

/** Client for `/academic-years` — read-only for now; nothing in the
 * frontend needed this until the Finance page's fee-structure picker did. */

export type AcademicYearsResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

export interface AcademicYear {
  id: string
  name: string
  startDate: string
  endDate: string
  current: boolean
}

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

export async function listAcademicYears(getToken: TokenGetter): Promise<AcademicYearsResult<AcademicYear[]>> {
  try {
    const response = await authorizedFetch(`${baseUrl()}/academic-years`, { method: 'GET' }, getToken)
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
    return { kind: 'ok', data: (body as { years: AcademicYear[] }).years }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
