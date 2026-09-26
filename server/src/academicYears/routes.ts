import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import { recordAudit } from '../audit.js'
import type { AcademicYearDoc } from '../db.js'
import { authenticate, requireActiveSubscription, requirePermission } from '../auth/guard.js'

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

/** SAMS 11.2: a year's terms, edited after the year exists. A kept term
 * sends its `id`; a new one has none. */
const termsBody = z
  .object({ terms: z.array(termSchema.extend({ id: z.string().min(1).optional() })).max(12) })
  .strict()

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
  const readGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('academicYears.read')] }
  const writeGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('academicYears.write')] }

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
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'academicYear.create',
        entity: 'academicYear',
        entityId: _id,
        after: { name: parsed.data.name, startDate: parsed.data.startDate, endDate: parsed.data.endDate },
      })
    })
    return reply.code(201).send({ id: _id })
  })

  /** SAMS 11.2: sets a year's terms — inside the year, in order, not
   * overlapping. A term an assessment plan or marks use can't be removed. */
  app.put('/academic-years/:id/terms', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = termsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const out = await withTenant(tenantId, async (ctx) => {
      const year = await ctx.academicYears.findOne({ _id: id })
      if (!year) return { error: 'NOT_FOUND', status: 404 }
      const terms = parsed.data.terms.map((t) => ({ id: t.id ?? randomUUID(), name: t.name, startDate: t.startDate, endDate: t.endDate }))
      const known = new Set(year.terms.map((t) => t.id))
      if (terms.some((t) => parsed.data.terms.find((x) => x.id === t.id) && !known.has(t.id))) return { error: 'UNKNOWN_TERM', status: 400 }
      const sorted = [...terms].sort((a, b) => a.startDate.localeCompare(b.startDate))
      for (const [i, t] of sorted.entries()) {
        if (t.endDate < t.startDate) return { error: 'TERM_ENDS_BEFORE_START', status: 400 }
        if (t.startDate < year.startDate || t.endDate > year.endDate) return { error: 'TERM_OUTSIDE_YEAR', status: 400 }
        if (i > 0 && t.startDate <= sorted[i - 1]!.endDate) return { error: 'TERMS_OVERLAP', status: 400 }
      }
      const removed = year.terms.filter((t) => !terms.some((x) => x.id === t.id)).map((t) => t.id)
      if (removed.length > 0) {
        const inPlan = await ctx.assessmentPlans.countDocuments({ academicYearId: id, 'terms.termId': { $in: removed } })
        const withMarks = await ctx.marks.countDocuments({ academicYearId: id, termId: { $in: removed } })
        if (inPlan + withMarks > 0) return { error: 'TERM_IN_USE', status: 409 }
      }
      const updated = await ctx.academicYears.findOneAndUpdate({ _id: id }, { $set: { terms: sorted } }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'academicYear.terms.set',
        entity: 'academicYear',
        entityId: id,
        before: { terms: year.terms },
        after: { terms: sorted },
      })
      return { year: updated! }
    })
    if ('error' in out) return reply.code(out.status as number).send({ error: out.error })
    return reply.send(toResponse(out.year))
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
      const updated = await ctx.academicYears.findOneAndUpdate({ _id: id }, { $set: { current: true } }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'academicYear.setCurrent',
        entity: 'academicYear',
        entityId: id,
        before: { current: others.map((y) => y._id) },
        after: { current: id },
      })
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(result))
  })
}
