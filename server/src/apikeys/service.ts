import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import type { ApiKeyDoc } from '../db.js'
import { generateApiKey } from './hash.js'

/**
 * Shared by the self-service API (`/api-keys`, tenantId from the caller's
 * own JWT) and the platform-admin API (`/admin/tenants/:id/api-keys`,
 * tenantId from the URL) — both are the same operation on the same tenant,
 * just reached by a different route, so there is one implementation rather
 * than two that could drift.
 */

export interface ApiKeySummary {
  id: string
  name: string
  preview: string
  role: ApiKeyDoc['role']
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
}

export async function listApiKeys(tenantId: string): Promise<ApiKeySummary[]> {
  const keys = await withTenant(tenantId, (ctx) => ctx.apiKeys.find().toArray())
  return keys.map((k) => ({
    id: k._id,
    name: k.name,
    preview: k.keyPreview,
    role: k.role,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revoked: k.revokedAt !== null,
  }))
}

export async function createApiKey(
  tenantId: string,
  name: string,
  role: ApiKeyDoc['role'],
  createdBy: string,
): Promise<{ id: string; key: string; preview: string }> {
  const generated = generateApiKey()
  const id = randomUUID()
  await withTenant(tenantId, (ctx) =>
    ctx.apiKeys.insertOne({
      _id: id,
      name,
      keyHash: generated.hash,
      keyPreview: generated.preview,
      role,
      createdAt: new Date(),
      createdBy,
      lastUsedAt: null,
      revokedAt: null,
    }),
  )
  return { id, key: generated.key, preview: generated.preview }
}

/** Returns false if no key with that id exists in the tenant. */
export async function revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
  const result = await withTenant(tenantId, (ctx) =>
    ctx.apiKeys.findOneAndUpdate({ _id: keyId }, { $set: { revokedAt: new Date() } }),
  )
  return result !== null
}
