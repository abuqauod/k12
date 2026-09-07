import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import { authenticate, requireRole } from '../auth/guard.js'
import { generateApiKey } from './hash.js'

/**
 * Machine-to-machine access for one school: a script pushing/pulling its
 * dataset without a human session. A key acts with one fixed role for every
 * request — see `authenticate` in auth/guard.ts for the other half of this
 * (an `X-Api-Key` header resolves straight to `request.auth`, same shape a
 * user's JWT produces, so dataset routes don't need to know the difference).
 */

const createBody = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'scheduler', 'viewer']),
})

export function registerApiKeyRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: [authenticate, requireRole('admin')] }

  app.get('/api-keys', guarded, async (request, reply) => {
    const tenantId = request.auth!.tenantId!
    const keys = await withTenant(tenantId, (ctx) => ctx.apiKeys.find().toArray())
    return reply.send({
      keys: keys.map((k) => ({
        id: k._id,
        name: k.name,
        preview: k.keyPreview,
        role: k.role,
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        revoked: k.revokedAt !== null,
      })),
    })
  })

  /** The raw key is returned exactly once, here — only its hash is ever stored. */
  app.post('/api-keys', guarded, async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const tenantId = request.auth!.tenantId!
    const generated = generateApiKey()
    const id = randomUUID()
    await withTenant(tenantId, (ctx) =>
      ctx.apiKeys.insertOne({
        _id: id,
        name: parsed.data.name,
        keyHash: generated.hash,
        keyPreview: generated.preview,
        role: parsed.data.role,
        createdAt: new Date(),
        createdBy: request.auth!.sub,
        lastUsedAt: null,
        revokedAt: null,
      }),
    )
    return reply.code(201).send({ id, key: generated.key, preview: generated.preview })
  })

  app.delete('/api-keys/:id', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, (ctx) =>
      ctx.apiKeys.findOneAndUpdate({ _id: id }, { $set: { revokedAt: new Date() } }),
    )
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.code(204).send()
  })
}
