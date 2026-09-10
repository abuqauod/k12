import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { BranchDoc } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerCanUseBranch,
  requireActiveSubscription,
  requireRole,
} from '../auth/guard.js'

/**
 * Branches = campuses of one school. Every tenant has at least one (backfilled
 * as "Main" — see migrate.ts). Reads are filtered to the branches the caller
 * is assigned to; a tenant-wide admin (branchIds = null) sees all of them.
 * Only an admin can create or edit one.
 */

const codeRule = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9-]+$/, 'code must be lowercase letters, digits and dashes')

const createBody = z.object({
  name: z.string().min(1).max(120),
  code: codeRule,
  address: z.string().max(500).nullable().default(null),
  timezone: z.string().min(1).max(64).default('Asia/Amman'),
})

const updateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  address: z.string().max(500).nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
  active: z.boolean().optional(),
})

function toResponse(doc: BranchDoc) {
  return {
    id: doc._id,
    name: doc.name,
    code: doc.code,
    address: doc.address,
    timezone: doc.timezone,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

export function registerBranchRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription] }
  const writeGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('admin')] }

  app.get('/branches', readGuard, async (request, reply) => {
    const allowed = await callerBranchIds(request)
    const branches = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.branches.find().sort({ name: 1 }).toArray(),
    )
    const visible = allowed === null ? branches : branches.filter((b) => allowed.includes(b._id))
    return reply.send({ branches: visible.map(toResponse) })
  })

  app.post('/branches', writeGuard, async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const tenantId = request.auth!.tenantId!
    const now = new Date()
    const created = await withTenant(tenantId, async (ctx) => {
      const clash = await ctx.branches.findOne({ code: parsed.data.code })
      if (clash) return null
      const _id = randomUUID()
      await ctx.branches.insertOne({ _id, ...parsed.data, active: true, createdAt: now, updatedAt: now })
      return { _id, ...parsed.data, active: true, createdAt: now, updatedAt: now } as BranchDoc
    })
    if (!created) return reply.code(409).send({ error: 'BRANCH_CODE_TAKEN' })
    return reply.code(201).send(toResponse(created))
  })

  app.patch('/branches/:id', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })
    if (!(await callerCanUseBranch(request, id))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })

    const updated = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.branches.findOneAndUpdate(
        { _id: id },
        { $set: { ...parsed.data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      ),
    )
    if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(updated))
  })
}
