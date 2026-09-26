import { api, enc } from './apiClient'
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
  terms?: { id: string; name: string; startDate: string; endDate: string }[]
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

/** Creates an academic year (`academicYears.write`). */
export async function createAcademicYear(
  getToken: TokenGetter,
  body: { name: string; startDate: string; endDate: string },
): Promise<AcademicYearsResult<AcademicYear>> {
  return mutate(getToken, '/academic-years', body)
}

/** Makes one year current (the server clears the flag on every other). */
export async function setCurrentAcademicYear(getToken: TokenGetter, id: string): Promise<AcademicYearsResult<AcademicYear>> {
  return mutate(getToken, `/academic-years/${encodeURIComponent(id)}/set-current`, {})
}

async function mutate<T>(getToken: TokenGetter, path: string, body: unknown): Promise<AcademicYearsResult<T>> {
  try {
    const response = await authorizedFetch(`${baseUrl()}${path}`, { method: 'POST', body: JSON.stringify(body) }, getToken)
    const text = await response.text()
    const parsed = text ? (JSON.parse(text) as unknown) : null
    if (!response.ok) {
      return { kind: 'error', error: (parsed as { error?: string } | null)?.error ?? `HTTP_${response.status}` }
    }
    return { kind: 'ok', data: parsed as T }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

/** SAMS 11.2: sets a year's terms (a kept term keeps its id). */
export const setAcademicYearTerms = (getToken: TokenGetter, id: string, terms: { id?: string; name: string; startDate: string; endDate: string }[]) =>
  api<AcademicYear>(getToken, 'PUT', `/academic-years/${enc(id)}/terms`, { terms })
