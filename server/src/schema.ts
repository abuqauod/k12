import type { Db } from 'mongodb'

/**
 * MongoDB has no schema to migrate — this creates the indexes the app
 * depends on. `createIndex` is idempotent (re-running is a no-op), so this
 * is safe to run every deploy, unlike the old .sql migrations it replaces.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection('tenants').createIndex({ slug: 1 }, { unique: true })

  await db.collection('users').createIndex({ email: 1 }, { unique: true })

  await db.collection('memberships').createIndex({ userId: 1 })
  await db.collection('memberships').createIndex({ tenantId: 1, userId: 1 }, { unique: true })

  await db.collection('refreshTokens').createIndex({ tokenHash: 1 }, { unique: true })
  await db.collection('refreshTokens').createIndex({ userId: 1 })
  // Atlas free tier caps storage, not TTL indexes — this lets expired,
  // already-useless refresh tokens age out on their own.
  await db.collection('refreshTokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })

  // `datasets` and `datasetVersions` are looked up by _id (which already
  // encodes tenantId+key, and tenantId+key+revision) for the hot paths, so
  // those don't need a secondary index. This one serves the version-history
  // listing, which sorts by revision within a (tenant, key).
  await db.collection('datasetVersions').createIndex({ tenantId: 1, key: 1, revision: -1 })

  await db.collection('auditLog').createIndex({ tenantId: 1, createdAt: -1 })
}
