import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { MongoServerError } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { LookupDoc } from '../db.js'
import { authenticate, requireActiveSubscription, requirePermission } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { ensureDefaults, isLookupKind } from './lookups.js'

/**
 * Settings lists (SAMS 1.11). Everyone signed in can read them (forms need
 * the options); only `settings.manage` changes them — they apply to the
 * whole school, so a branch admin doesn't hold it. Entries are never
 * deleted: deactivating hides a code from new records while every record
 * that already stores it keeps resolving.
 */

const createBody = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  label: z.string().trim().min(1).max(120),
  labelAr: z.string().trim().max(120).nullable().default(null),
  order: z.number().int().min(0).max(999).optional(),
})

const updateBody = z
  .object({
    label: z.string().trim().min(1).max(120),
    labelAr: z.string().trim().max(120).nullable(),
    active: z.boolean(),
    order: z.number().int().min(0).max(999),
  })
  .partial()
  .strict()

function toResponse(doc: LookupDoc) {
  return {
    code: doc.code,
    label: doc.label,
    labelAr: doc.labelAr,
    active: doc.active,
    order: doc.order,
    builtIn: doc.builtIn,
  }
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('settings.read')] }
  const manageGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('settings.manage')] }

  app.get('/settings/lookups/:kind', readGuard, async (request, reply) => {
    const { kind } = request.params as { kind: string }
    if (!isLookupKind(kind)) return reply.code(404).send({ error: 'UNKNOWN_LOOKUP_KIND' })
    const includeInactive = (request.query as { includeInactive?: string }).includeInactive === '1'
    const tenantId = request.auth!.tenantId!
    await ensureDefaults(tenantId, kind)
    const rows = await withTenant(tenantId, (ctx) =>
      ctx.lookups
        .find({ kind, ...(includeInactive ? {} : { active: true }) })
        .sort({ order: 1, code: 1 })
        .toArray(),
    )
    return reply.send({ kind, items: rows.map(toResponse) })
  })

  app.post('/settings/lookups/:kind', manageGuard, async (request, reply) => {
    const { kind } = request.params as { kind: string }
    if (!isLookupKind(kind)) return reply.code(404).send({ error: 'UNKNOWN_LOOKUP_KIND' })
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    await ensureDefaults(tenantId, kind)
    try {
      const created = await withTenant(tenantId, async (ctx) => {
        const now = new Date()
        const order = parsed.data.order ?? (await ctx.lookups.countDocuments({ kind }))
        const _id = randomUUID()
        await ctx.lookups.insertOne({
          _id,
          kind,
          code: parsed.data.code,
          label: parsed.data.label,
          labelAr: parsed.data.labelAr,
          active: true,
          order,
          builtIn: false,
          createdAt: now,
          updatedAt: now,
        })
        const doc = (await ctx.lookups.findOne({ _id }))!
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'lookup.create',
          entity: 'lookup',
          entityId: `${kind}:${doc.code}`,
          after: doc,
        })
        return doc
      })
      return reply.code(201).send(toResponse(created))
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        return reply.code(409).send({ error: 'LOOKUP_CODE_TAKEN' })
      }
      throw error
    }
  })

  app.patch('/settings/lookups/:kind/:code', manageGuard, async (request, reply) => {
    const { kind, code } = request.params as { kind: string; code: string }
    if (!isLookupKind(kind)) return reply.code(404).send({ error: 'UNKNOWN_LOOKUP_KIND' })
    const parsed = updateBody.safeParse(request.body)
    if (!parsed.success || Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    await ensureDefaults(tenantId, kind)
    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.lookups.findOne({ kind, code })
      if (!before) return { error: 'NOT_FOUND' as const }
      // A list must keep at least one active option (e.g. payment methods).
      if (parsed.data.active === false && before.active) {
        const active = await ctx.lookups.countDocuments({ kind, active: true })
        if (active <= 1) return { error: 'LAST_ACTIVE_LOOKUP' as const }
      }
      const after = await ctx.lookups.findOneAndUpdate(
        { kind, code },
        { $set: { ...parsed.data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'lookup.update',
        entity: 'lookup',
        entityId: `${kind}:${code}`,
        before,
        after,
      })
      return { doc: after! }
    })
    if ('error' in result) {
      return reply.code(result.error === 'NOT_FOUND' ? 404 : 409).send({ error: result.error })
    }
    return reply.send(toResponse(result.doc))
  })
}
