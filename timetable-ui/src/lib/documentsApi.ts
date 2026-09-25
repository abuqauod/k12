import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'
import { settingsRequest, type SettingsResult } from './settingsApi'

/** Client for documents (SAMS 2.1, server/src/documents). */

export type DocumentOwnerType = 'student' | 'parent'
export type VerificationStatus = 'unverified' | 'verified' | 'rejected'

export interface SchoolDocument {
  id: string
  ownerType: DocumentOwnerType
  ownerId: string
  categoryCode: string
  seriesId: string
  version: number
  isCurrent: boolean
  fileName: string
  mime: string
  size: number
  expiresAt: string | null
  expired: boolean
  verification: {
    status: VerificationStatus
    by: string | null
    byName: string | null
    at: string | null
    note: string | null
  }
  uploadedBy: string
  uploadedByName: string | null
  createdAt: string
  archivedAt: string | null
}

/** Must match the server's MAX_DOCUMENT_BYTES default. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const ACCEPTED_TYPES = 'application/pdf,image/png,image/jpeg,image/webp'

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

export async function listDocuments(
  getToken: TokenGetter,
  ownerType: DocumentOwnerType,
  ownerId: string,
  includeArchived = false,
): Promise<SettingsResult<SchoolDocument[]>> {
  const query = new URLSearchParams({ ownerType, ownerId, ...(includeArchived ? { includeArchived: '1' } : {}) })
  const result = await settingsRequest<{ documents: SchoolDocument[] }>(
    `/documents?${query}`,
    { method: 'GET' },
    getToken,
  )
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.documents } : result
}

export async function listVersions(getToken: TokenGetter, id: string): Promise<SettingsResult<SchoolDocument[]>> {
  const result = await settingsRequest<{ versions: SchoolDocument[] }>(
    `/documents/${encodeURIComponent(id)}/versions`,
    { method: 'GET' },
    getToken,
  )
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.versions } : result
}

/** Sends the raw file. `replaces` uploads a new version of that document. */
export async function uploadDocument(
  getToken: TokenGetter,
  file: File,
  target:
    | { ownerType: DocumentOwnerType; ownerId: string; category: string; expiresAt?: string }
    | { replaces: string; expiresAt?: string },
): Promise<SettingsResult<SchoolDocument>> {
  const query = new URLSearchParams({ fileName: file.name })
  if (target.expiresAt) query.set('expiresAt', target.expiresAt)
  let path = '/documents'
  if ('replaces' in target) path = `/documents/${encodeURIComponent(target.replaces)}/versions`
  else {
    query.set('ownerType', target.ownerType)
    query.set('ownerId', target.ownerId)
    query.set('category', target.category)
  }
  try {
    const response = await authorizedFetch(
      `${baseUrl()}${path}?${query}`,
      { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } },
      getToken,
      120_000,
    )
    const body = (await response.json().catch(() => null)) as (SchoolDocument & { error?: string }) | null
    if (response.status === 413) return { kind: 'error', error: 'FILE_TOO_LARGE' }
    if (!response.ok) return { kind: 'error', error: body?.error ?? `HTTP_${response.status}` }
    return { kind: 'ok', data: body as SchoolDocument }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export function verifyDocument(
  getToken: TokenGetter,
  id: string,
  body: { status: VerificationStatus; note?: string },
): Promise<SettingsResult<SchoolDocument>> {
  return settingsRequest(`/documents/${encodeURIComponent(id)}/verify`, { method: 'POST', body: JSON.stringify(body) }, getToken)
}

export function archiveDocument(getToken: TokenGetter, id: string, reason: string): Promise<SettingsResult<null>> {
  return settingsRequest(`/documents/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ reason }) }, getToken)
}

/** A signed URL to the file, valid for a few minutes. */
export async function documentFileUrl(
  getToken: TokenGetter,
  id: string,
  download = false,
): Promise<SettingsResult<string>> {
  const result = await settingsRequest<{ token: string }>(
    `/documents/${encodeURIComponent(id)}/link`,
    { method: 'POST', body: JSON.stringify({ download }) },
    getToken,
  )
  if (result.kind !== 'ok') return result
  return { kind: 'ok', data: `${baseUrl()}/documents/file?token=${encodeURIComponent(result.data.token)}` }
}
