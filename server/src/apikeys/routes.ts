import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../auth/guard.js'
import { createApiKey, listApiKeys, revokeApiKey } from './service.js'

/**
 * Machine-to-machine access for one school: a script pushing/pulling its
 * dataset without a human session. A key acts with one fixed role for every
 * request — see `authenticate` in auth/guard.ts for the other half of this
 * (an `X-Api-Key` header resolves straight to `request.auth`, same shape a
 * user's JWT produces, so dataset routes don't need to know the difference).
 *
 * This is the self-service surface — a tenant's own admin managing their
 * school's keys. The platform-admin equivalent (`admin/routes.ts`) calls
 * the same `service.ts` functions with a tenant id from the URL instead of
 * the caller's own JWT.
 */

const createBody = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(['admin', 'scheduler', 'viewer']),
})

export function registerApiKeyRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: [authenticate, requireRole('admin')] }

  app.get('/api-keys', guarded, async (request, reply) => {
    const keys = await listApiKeys(request.auth!.tenantId!)
    return reply.send({ keys })
  })

  /** The raw key is returned exactly once, here — only its hash is ever stored. */
  app.post('/api-keys', guarded, async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const created = await createApiKey(
      request.auth!.tenantId!,
      parsed.data.name,
      parsed.data.role,
      request.auth!.sub,
    )
    return reply.code(201).send(created)
  })

  app.delete('/api-keys/:id', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const found = await revokeApiKey(request.auth!.tenantId!, id)
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.code(204).send()
  })
}
