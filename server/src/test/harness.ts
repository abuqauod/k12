// Shared fixture for the server's integration tests (`npm test`).
//
// Every test file gets its own freshly created tenant — two branches, one
// member per role, plus a scheduler confined to branch A — so files never
// see each other's data and nothing needs dropping between runs. Requests go
// through `app.inject`, i.e. the real route table, guards and database.
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { config } from '../config.js'
import { buildServer } from '../server.js'
import { closeClient, withoutTenant } from '../db.js'
import { ensureIndexes } from '../schema.js'
import { signAccessToken, type Role } from '../auth/tokens.js'

export const ROLES: readonly Role[] = ['viewer', 'scheduler', 'admin', 'owner']

export interface Fixture {
  app: FastifyInstance
  tenantId: string
  branchA: string
  branchB: string
  /** One tenant-wide member per role. */
  tokens: Record<Role, string>
  /** A scheduler whose membership is confined to branch A. */
  scopedToken: string
  close: () => Promise<void>
}

async function member(
  tenantId: string,
  role: Role,
  branchIds: string[] | null,
): Promise<string> {
  const userId = randomUUID()
  const email = `${role}-${userId.slice(0, 8)}@test.local`
  const now = new Date()
  await withoutTenant(async (db) => {
    await db.users.insertOne({
      _id: userId,
      email,
      passwordHash: null,
      displayName: role,
      displayNameAr: null,
      active: true,
      emailVerified: true,
      platformAdmin: false,
      createdAt: now,
      lastLoginAt: null,
    })
    await db.memberships.insertOne({
      _id: `${tenantId}:${userId}`,
      tenantId,
      userId,
      role,
      branchIds,
      createdAt: now,
    })
  })
  return signAccessToken({ sub: userId, email, tenantId, role })
}

export async function createFixture(): Promise<Fixture> {
  const mongo = new MongoClient(config.databaseUrl)
  await ensureIndexes(mongo.db())
  await mongo.close()

  const tenantId = randomUUID()
  const branchA = randomUUID()
  const branchB = randomUUID()
  const now = new Date()
  await withoutTenant(async (db) => {
    await db.tenants.insertOne({
      _id: tenantId,
      slug: `t-${tenantId.slice(0, 8)}`,
      name: 'Test School',
      plan: 'test',
      status: 'active',
      seats: 100,
      validUntil: null,
      graceDays: 0,
      createdAt: now,
      updatedAt: now,
    })
    for (const [id, code] of [
      [branchA, 'a'],
      [branchB, 'b'],
    ] as const) {
      await db.branches.insertOne({
        _id: id,
        tenantId,
        name: `Branch ${code.toUpperCase()}`,
        code: `${code}-${id.slice(0, 6)}`,
        address: null,
        timezone: 'Asia/Amman',
        active: true,
        createdAt: now,
        updatedAt: now,
      })
    }
  })

  const tokens = {} as Record<Role, string>
  for (const role of ROLES) tokens[role] = await member(tenantId, role, null)
  const scopedToken = await member(tenantId, 'scheduler', [branchA])

  const app = buildServer()
  await app.ready()
  return {
    app,
    tenantId,
    branchA,
    branchB,
    tokens,
    scopedToken,
    close: async () => {
      await app.close()
      await closeClient()
    },
  }
}

export async function call(
  app: FastifyInstance,
  token: string,
  method: InjectOptions['method'],
  url: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url: config.routePrefix + url,
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { payload: body as object }),
  })
  let json: { error?: string } = {}
  try {
    json = res.json()
  } catch {
    // non-JSON body (e.g. CSV) — status alone is what matters
  }
  return { status: res.statusCode, error: json.error, body: json }
}
