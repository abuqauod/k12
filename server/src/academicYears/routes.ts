import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { AcademicYearDoc } from '../db.js'
import { authenticate, requireActiveSubscription, requireRole } from '../auth/guard.js'

/**
 * A school year and its terms — what attendance, and later fees/exams, are
 * actually measured against. Deliberately simple for v1: a year has terms,
 * exactly one year is ever "current", nothing else references this yet
 * beyond that flag.
 */

const termSchema = z.object({
  name: z.string().min(1).max(100),
  startDate: z.string().date(),
  endDate: z.string().date(),
})

const createYearBody = z.object({
  name: z.string().min(1).max(100),
  startDate: z.string().date(),
  endDate: z.string().date(),
  terms: z.array(termSchema).max(12).default([]),
})

function toResponse(doc: AcademicYearDoc) {
  return {
    id: doc._id,
    name: doc.name,
    startDate: doc.startDate,
    endDate: doc.endDate,
    terms: doc.terms,
    current: doc.current,
  }
}

export function registerAcademicYearRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription] }
  const writeGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('scheduler')] }

  app.get('/academic-years', readGuard, async (request, reply) => {
    const years = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.academicYears.find().sort({ startDate: -1 }).toArray(),
    )
    return reply.send({ years: years.map(toResponse) })
  })

  app.post('/academic-years', writeGuard, async (request, reply) => {
    const parsed = createYearBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const tenantId = request.auth!.tenantId!
    const _id = randomUUID()
    await withTenant(tenantId, async (ctx) => {
      const terms = parsed.data.terms.map((t) => ({ id: randomUUID(), ...t }))
      // The first year a tenant ever creates becomes current by default —
      // otherwise attendance would have nowhere to file itself against.
      const anyExisting = await ctx.academicYears.findOne({})
      await ctx.academicYears.insertOne({
        _id,
        name: parsed.data.name,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        terms,
        current: !anyExisting,
        createdAt: new Date(),
      })
    })
    return reply.code(201).send({ id: _id })
  })

  /** Makes this the one current year, unsetting the flag on every other. */
  app.post('/academic-years/:id/set-current', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, async (ctx) => {
      const target = await ctx.academicYears.findOne({ _id: id })
      if (!target) return null
      // TenantScope has no updateMany (see db.ts) — fine here, since there's
      // realistically only ever 0-1 other "current" years to unset, all
      // inside the same transaction as the target's own update below.
      const others = await ctx.academicYears.find({ current: true }).toArray()
      for (const year of others) {
        if (year._id !== id) await ctx.academicYears.findOneAndUpdate({ _id: year._id }, { $set: { current: false } })
      }
      return ctx.academicYears.findOneAndUpdate({ _id: id }, { $set: { current: true } }, { returnDocument: 'after' })
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(result))
  })
}
