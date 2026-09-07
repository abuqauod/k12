import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { TenantContext } from '../db.js'
import { authenticate, requireActiveSubscription, requireRole } from '../auth/guard.js'

/**
 * Shape check only — the timetable document itself is the client's domain model
 * and is stored as an opaque blob. The server deliberately does not validate
 * every lesson: the solver owns those rules, and a server that half-understood
 * them would need redeploying for every domain change.
 */
const problemSchema = z
  .object({
    lessons: z.array(z.unknown()),
    timeslots: z.array(z.unknown()),
  })
  .passthrough()

const putBody = z.object({
  baseRevision: z.number().int().nonnegative(),
  problem: problemSchema,
})

const keyParam = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'key must be url-safe')

export function registerDatasetRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: [authenticate, requireActiveSubscription] }

  app.get('/datasets/:key', guarded, async (request, reply) => {
    const key = keyParam.safeParse((request.params as { key: string }).key)
    if (!key.success) return reply.code(400).send({ error: 'INVALID_KEY' })
    const tenantId = request.auth!.tenantId

    const row = await withTenant(tenantId, (ctx) => ctx.datasets.findOne({ key: key.data }))

    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send({
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
      problem: row.problem,
    })
  })

  /**
   * Optimistic concurrency: the update only lands if the document is still at
   * `baseRevision` — `findOneAndUpdate`'s filter makes that check-and-write
   * atomic without an explicit lock. Losing the race is a 409 carrying the
   * server's current copy, so the client can merge or take theirs — it is a
   * normal outcome of two people editing, not an error.
   */
  app.put(
    '/datasets/:key',
    { preHandler: [authenticate, requireActiveSubscription, requireRole('scheduler')] },
    async (request, reply) => {
      const key = keyParam.safeParse((request.params as { key: string }).key)
      if (!key.success) return reply.code(400).send({ error: 'INVALID_KEY' })

      const parsed = putBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

      const { baseRevision, problem } = parsed.data
      const tenantId = request.auth!.tenantId
      const userId = request.auth!.sub

      return withTenant(tenantId, async (ctx) => {
        const existing = await ctx.datasets.findOne({ key: key.data })

        // First push for this key creates the document.
        if (!existing) {
          const updatedAt = new Date()
          await ctx.datasets.insertOne({
            _id: `${tenantId}:${key.data}`,
            key: key.data,
            revision: 1,
            problem,
            updatedAt,
            updatedBy: userId,
          })
          await recordVersion(ctx, tenantId, key.data, 1, problem, userId)
          await audit(ctx, userId, 'dataset.create', key.data, { revision: 1 })
          return reply.code(201).send({ revision: 1, updatedAt: updatedAt.toISOString() })
        }

        if (existing.revision !== baseRevision) {
          return reply.code(409).send({
            error: 'REVISION_CONFLICT',
            revision: existing.revision,
            updatedAt: existing.updatedAt.toISOString(),
            problem: existing.problem,
          })
        }

        const next = existing.revision + 1
        const updatedAt = new Date()
        const result = await ctx.datasets.findOneAndUpdate(
          { key: key.data, revision: baseRevision },
          { $set: { revision: next, problem, updatedAt, updatedBy: userId } },
          { returnDocument: 'after' },
        )

        // Someone else's write landed between the check above and this one —
        // same race, same response, just caught one step later.
        if (!result) {
          const current = await ctx.datasets.findOne({ key: key.data })
          return reply.code(409).send({
            error: 'REVISION_CONFLICT',
            revision: current!.revision,
            updatedAt: current!.updatedAt.toISOString(),
            problem: current!.problem,
          })
        }

        await recordVersion(ctx, tenantId, key.data, next, problem, userId)
        await audit(ctx, userId, 'dataset.update', key.data, { revision: next })

        return reply.send({ revision: next, updatedAt: updatedAt.toISOString() })
      })
    },
  )

  /** Version history — "restore last term's timetable" is a read, not a backup. */
  app.get('/datasets/:key/versions', guarded, async (request, reply) => {
    const key = keyParam.safeParse((request.params as { key: string }).key)
    if (!key.success) return reply.code(400).send({ error: 'INVALID_KEY' })
    const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 20), 100)

    const rows = await withTenant(request.auth!.tenantId, (ctx) =>
      ctx.datasetVersions
        .find({ key: key.data })
        .sort({ revision: -1 })
        .limit(limit)
        .toArray(),
    )

    return reply.send({
      versions: rows.map((row) => ({
        revision: row.revision,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdBy,
      })),
    })
  })

  app.get('/datasets/:key/versions/:revision', guarded, async (request, reply) => {
    const params = request.params as { key: string; revision: string }
    const key = keyParam.safeParse(params.key)
    const revision = Number(params.revision)
    if (!key.success || !Number.isInteger(revision)) {
      return reply.code(400).send({ error: 'INVALID_KEY' })
    }

    const row = await withTenant(request.auth!.tenantId, (ctx) =>
      ctx.datasetVersions.findOne({ key: key.data, revision }),
    )

    if (!row) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send({
      revision,
      createdAt: row.createdAt.toISOString(),
      problem: row.problem,
    })
  })
}

async function recordVersion(
  ctx: TenantContext,
  tenantId: string,
  key: string,
  revision: number,
  problem: unknown,
  userId: string,
): Promise<void> {
  try {
    await ctx.datasetVersions.insertOne({
      _id: `${tenantId}:${key}:${revision}`,
      key,
      revision,
      problem,
      createdAt: new Date(),
      createdBy: userId,
    })
  } catch (error) {
    // Duplicate key = this exact version was already recorded (matches the
    // old `on conflict do nothing`) — safe to ignore, anything else is real.
    if (!isDuplicateKeyError(error)) throw error
  }
}

async function audit(
  ctx: TenantContext,
  actorId: string,
  action: string,
  entityId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await ctx.auditLog.insertOne({
    _id: randomUUID(),
    actorId,
    action,
    entity: 'dataset',
    entityId,
    meta,
    createdAt: new Date(),
  })
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000
}
