import { loadSyncSettings } from './sync'
import type { Branch } from '../domain/branches'

/**
 * Client for `/branches` — the campuses of the signed-in user's school.
 * READ ONLY: a branch's identity (name, code, address, timezone, active) is
 * provisioned by the vendor through the platform console. A school's own
 * users only read the list, and run the operational side (school calendar,
 * absence-notification settings) through their own routes.
 */

export type BranchesResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

export async function listBranches(accessToken: string): Promise<BranchesResult<Branch[]>> {
  try {
    const response = await fetch(`${baseUrl()}/branches`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    })
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
    return { kind: 'ok', data: (body as { branches: Branch[] }).branches }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
