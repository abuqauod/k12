import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { SchoolClassDoc } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerCanUseBranch,
  requireActiveSubscription,
  requireRole,
} from '../auth/guard.js'

/**
 * Homeroom classes, grouped by grade under a branch. The list carries a live
 * enrolled count so the UI can show "18 / 25" and flag an over-full class.
 * `studentGroup` on a student stays equal to `${gradeLevel} ${name}` (set
 * where the student is written — see students/routes.ts), so the timetable
 * solver keeps seeing the label it expects.
 */

const createBody = z.object({
  branchId: z.string().min(1),
  gradeLevel: z.string().min(1).max(60),
  name: z.string().min(1).max(60),
  capacity: z.number().int().min(1).max(200).default(30),
  homeroomTeacherId: z.string().min(1).nullable().default(null),
  academicYearId: z.string().min(1).nullable().default(null),
})

const bulkBody = z.object({
  branchId: z.string().min(1),
  gradeLevel: z.string().min(1).max(60),
  capacity: z.number().int().min(1).max(200).default(30),
  academicYearId: z.string().min(1).nullable().default(null),
  sections: z.array(z.string().min(1).max(60)).min(1).max(20),
})

const updateBody = z.object({
  gradeLevel: z.string().min(1).max(60).optional(),
  name: z.string().min(1).max(60).optional(),
  capacity: z.number().int().min(1).max(200).optional(),
  homeroomTeacherId: z.string().min(1).nullable().optional(),
  academicYearId: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
})

const listQuery = z.object({
  branchId: z.string().optional(),
  academicYearId: z.string().optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
})

function toResponse(doc: SchoolClassDoc, enrolled: number) {
  return {
    id: doc._id,
    branchId: doc.branchId,
    gradeLevel: doc.gradeLevel,
    name: doc.name,
    label: `${doc.gradeLevel} ${doc.name}`.trim(),
    capacity: doc.capacity,
    homeroomTeacherId: doc.homeroomTeacherId,
    academicYearId: doc.academicYearId,
    active: doc.active,
    enrolled,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

export function registerClassRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription] }
  const writeGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('admin')] }

  app.get('/classes', readGuard, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })

    const allowed = await callerBranchIds(request)
    if (parsed.data.branchId && allowed !== null && !allowed.includes(parsed.data.branchId)) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const filter: Filter<SchoolClassDoc> = {}
    if (parsed.data.branchId) filter.branchId = parsed.data.branchId
    else if (allowed !== null) filter.branchId = { $in: allowed }
    if (parsed.data.academicYearId) filter.academicYearId = parsed.data.academicYearId
    if (parsed.data.includeInactive !== 'true') filter.active = true

    const { classes, students } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const classes = await ctx.classes.find(filter).sort({ gradeLevel: 1, name: 1 }).toArray()
      const students = await ctx.students
        .find({ status: 'enrolled', classId: { $in: classes.map((c) => c._id) } })
        .toArray()
      return { classes, students }
    })

    const counts = new Map<string, number>()
    for (const s of students) counts.set(s.classId, (counts.get(s.classId) ?? 0) + 1)
    return reply.send({ classes: classes.map((c) => toResponse(c, counts.get(c._id) ?? 0)) })
  })

  app.post('/classes', writeGuard, async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const tenantId = request.auth!.tenantId!
    const now = new Date()
    const created = await withTenant(tenantId, async (ctx) => {
      const branch = await ctx.branches.findOne({ _id: parsed.data.branchId })
      if (!branch) return { error: 'UNKNOWN_BRANCH' as const }
      const clash = await ctx.classes.findOne({
        branchId: parsed.data.branchId,
        gradeLevel: parsed.data.gradeLevel,
        name: parsed.data.name,
      })
      if (clash) return { error: 'CLASS_EXISTS' as const }
      const _id = randomUUID()
      const doc: SchoolClassDoc = {
        _id,
        tenantId,
        ...parsed.data,
        active: true,
        createdAt: now,
        updatedAt: now,
      }
      await ctx.classes.insertOne(doc)
      return { doc }
    })
    if ('error' in created) {
      return reply.code(created.error === 'UNKNOWN_BRANCH' ? 404 : 409).send({ error: created.error })
    }
    return reply.code(201).send(toResponse(created.doc, 0))
  })

  app.post('/classes/bulk', writeGuard, async (request, reply) => {
    const parsed = bulkBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const tenantId = request.auth!.tenantId!
    const now = new Date()
    const result = await withTenant(tenantId, async (ctx) => {
      const branch = await ctx.branches.findOne({ _id: parsed.data.branchId })
      if (!branch) return null
      const existing = await ctx.classes
        .find({ branchId: parsed.data.branchId, gradeLevel: parsed.data.gradeLevel })
        .toArray()
      const have = new Set(existing.map((c) => c.name))
      const made: SchoolClassDoc[] = []
      for (const section of parsed.data.sections) {
        if (have.has(section)) continue
        const doc: SchoolClassDoc = {
          _id: randomUUID(),
          tenantId,
          branchId: parsed.data.branchId,
          gradeLevel: parsed.data.gradeLevel,
          name: section,
          capacity: parsed.data.capacity,
          homeroomTeacherId: null,
          academicYearId: parsed.data.academicYearId,
          active: true,
          createdAt: now,
          updatedAt: now,
        }
        await ctx.classes.insertOne(doc)
        made.push(doc)
      }
      return made
    })
    if (result === null) return reply.code(404).send({ error: 'UNKNOWN_BRANCH' })
    return reply.code(201).send({ created: result.map((c) => toResponse(c, 0)) })
  })

  app.patch('/classes/:id', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })

    const tenantId = request.auth!.tenantId!
    const outcome = await withTenant(tenantId, async (ctx) => {
      const current = await ctx.classes.findOne({ _id: id })
      if (!current) return { error: 'NOT_FOUND' as const }
      const nextGrade = parsed.data.gradeLevel ?? current.gradeLevel
      const nextName = parsed.data.name ?? current.name
      if (nextGrade !== current.gradeLevel || nextName !== current.name) {
        const clash = await ctx.classes.findOne({
          branchId: current.branchId,
          gradeLevel: nextGrade,
          name: nextName,
        })
        if (clash && clash._id !== id) return { error: 'CLASS_EXISTS' as const }
      }
      const updated = await ctx.classes.findOneAndUpdate(
        { _id: id },
        { $set: { ...parsed.data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      // Keep the denormalised label on students in step with a rename.
      if (updated && (nextGrade !== current.gradeLevel || nextName !== current.name)) {
        const label = `${nextGrade} ${nextName}`.trim()
        const roster = await ctx.students.find({ classId: id }).toArray()
        for (const s of roster) {
          await ctx.students.findOneAndUpdate({ _id: s._id }, { $set: { studentGroup: label } })
        }
      }
      const enrolled = await ctx.students.find({ classId: id, status: 'enrolled' }).toArray()
      return { doc: updated!, enrolled: enrolled.length }
    })
    if ('error' in outcome) {
      return reply.code(outcome.error === 'NOT_FOUND' ? 404 : 409).send({ error: outcome.error })
    }
    return reply.send(toResponse(outcome.doc, outcome.enrolled))
  })

  app.delete('/classes/:id', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const outcome = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const current = await ctx.classes.findOne({ _id: id })
      if (!current) return 'not_found' as const
      const used = await ctx.students.find({ classId: id }).toArray()
      if (used.length > 0) return 'in_use' as const
      await ctx.classes.deleteOne({ _id: id })
      return 'ok' as const
    })
    if (outcome === 'not_found') return reply.code(404).send({ error: 'NOT_FOUND' })
    if (outcome === 'in_use') return reply.code(409).send({ error: 'CLASS_HAS_STUDENTS' })
    return reply.code(204).send()
  })
}
