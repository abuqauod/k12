import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { Guardian, StudentDoc } from '../db.js'
import { authenticate, requireActiveSubscription, requireRole } from '../auth/guard.js'

/**
 * A school's actual student roster — real per-student documents with a
 * real CRUD API, replacing the transport-only roster that used to live
 * under the generic /datasets/:key blob sync (key "students"). Attendance
 * (attendance/routes.ts) references these by `_id`, and needs the kind of
 * server-side filtering and per-record writes a single JSON blob can't give.
 *
 * Field names match the existing client-side vocabulary (`givenName`,
 * `studentGroup`, `studentNumber`, `stopId`, `transportMode`) — see the
 * comment on `StudentDoc` in db.ts.
 */

const guardianSchema = z.object({
  name: z.string().min(1).max(200),
  relationship: z.string().min(1).max(50),
  phone: z.string().min(5).max(30),
  secondaryPhone: z.string().max(30).nullable().default(null),
  email: z.string().email().nullable().default(null),
  isPrimary: z.boolean().default(false),
})

const studentBody = z.object({
  studentNumber: z.string().min(1).max(50),
  givenName: z.string().min(1).max(100),
  familyName: z.string().min(1).max(100),
  givenNameAr: z.string().max(100).nullable().default(null),
  familyNameAr: z.string().max(100).nullable().default(null),
  dob: z.string().date().nullable().default(null),
  gender: z.enum(['male', 'female']).nullable().default(null),
  /** The homeroom this student sits in. `branchId` and the `studentGroup`
   * label are both derived from it server-side, never taken from the client,
   * so the three can't drift apart. */
  classId: z.string().min(1),
  status: z.enum(['enrolled', 'graduated', 'withdrawn', 'inquiry']).default('enrolled'),
  admissionDate: z.string().date().nullable().default(null),
  address: z.string().max(500).nullable().default(null),
  medicalNotes: z.string().max(2000).nullable().default(null),
  // At most one guardian should be primary — not enforced by the schema
  // itself (zod can't easily express "at most one true" as a type-level
  // rule), checked in the handler instead.
  guardians: z.array(guardianSchema).max(6).default([]),
  stopId: z.string().default(''),
  transportMode: z.enum(['TWO_WAY', 'MORNING', 'EVENING', 'NONE']).default('NONE'),
  primaryPhone: z.string().max(30).default(''),
  secondaryPhone: z.string().max(30).default(''),
})

const updateStudentBody = studentBody.partial()

const listQuery = z.object({
  branchId: z.string().optional(),
  classId: z.string().optional(),
  studentGroup: z.string().optional(),
  status: z.enum(['enrolled', 'graduated', 'withdrawn', 'inquiry']).optional(),
  search: z.string().max(200).optional(),
})

function atMostOnePrimary(guardians: Guardian[]): boolean {
  return guardians.filter((g) => g.isPrimary).length <= 1
}

function toResponse(doc: StudentDoc) {
  return {
    id: doc._id,
    studentNumber: doc.studentNumber,
    givenName: doc.givenName,
    familyName: doc.familyName,
    givenNameAr: doc.givenNameAr,
    familyNameAr: doc.familyNameAr,
    dob: doc.dob,
    gender: doc.gender,
    branchId: doc.branchId,
    classId: doc.classId,
    studentGroup: doc.studentGroup,
    status: doc.status,
    admissionDate: doc.admissionDate,
    address: doc.address,
    medicalNotes: doc.medicalNotes,
    guardians: doc.guardians,
    stopId: doc.stopId,
    transportMode: doc.transportMode,
    primaryPhone: doc.primaryPhone,
    secondaryPhone: doc.secondaryPhone,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

export function registerStudentRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription] }
  const writeGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('scheduler')] }

  app.get('/students', readGuard, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { branchId, classId, studentGroup, status, search } = parsed.data

    const filter: Filter<StudentDoc> = {}
    if (branchId) filter.branchId = branchId
    if (classId) filter.classId = classId
    if (studentGroup) filter.studentGroup = studentGroup
    if (status) filter.status = status
    if (search) {
      const pattern = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
      filter.$or = [{ givenName: pattern }, { familyName: pattern }, { studentNumber: pattern }]
    }

    const students = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.students.find(filter).sort({ familyName: 1, givenName: 1 }).toArray(),
    )
    return reply.send({ students: students.map(toResponse) })
  })

  app.get('/students/:id', readGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const student = await withTenant(request.auth!.tenantId!, (ctx) => ctx.students.findOne({ _id: id }))
    if (!student) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(student))
  })

  app.post('/students', writeGuard, async (request, reply) => {
    const parsed = studentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!atMostOnePrimary(parsed.data.guardians)) {
      return reply.code(400).send({ error: 'MULTIPLE_PRIMARY_GUARDIANS' })
    }

    const tenantId = request.auth!.tenantId!
    const now = new Date()
    try {
      const result = await withTenant(tenantId, async (ctx) => {
        const klass = await ctx.classes.findOne({ _id: parsed.data.classId })
        if (!klass) return 'unknown_class' as const
        const existing = await ctx.students.findOne({ studentNumber: parsed.data.studentNumber })
        if (existing) return 'number_taken' as const
        const _id = randomUUID()
        // branchId and the studentGroup label come from the class, never the client.
        await ctx.students.insertOne({
          _id,
          ...parsed.data,
          branchId: klass.branchId,
          studentGroup: `${klass.gradeLevel} ${klass.name}`.trim(),
          createdAt: now,
          updatedAt: now,
        })
        return _id
      })
      if (result === 'unknown_class') return reply.code(404).send({ error: 'UNKNOWN_CLASS' })
      if (result === 'number_taken') return reply.code(409).send({ error: 'STUDENT_NUMBER_TAKEN' })
      return reply.code(201).send({ id: result })
    } catch (error) {
      request.log.error(error, 'failed to create student')
      return reply.code(500).send({ error: 'INTERNAL' })
    }
  })

  app.patch('/students/:id', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateStudentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (parsed.data.guardians && !atMostOnePrimary(parsed.data.guardians)) {
      return reply.code(400).send({ error: 'MULTIPLE_PRIMARY_GUARDIANS' })
    }
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })

    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, async (ctx) => {
      // Moving a student to another class re-derives branch + label with them.
      let derived: { branchId: string; studentGroup: string } | null = null
      if (parsed.data.classId) {
        const klass = await ctx.classes.findOne({ _id: parsed.data.classId })
        if (!klass) return 'unknown_class' as const
        derived = { branchId: klass.branchId, studentGroup: `${klass.gradeLevel} ${klass.name}`.trim() }
      }
      return ctx.students.findOneAndUpdate(
        { _id: id },
        { $set: { ...parsed.data, ...(derived ?? {}), updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
    })
    if (result === 'unknown_class') return reply.code(404).send({ error: 'UNKNOWN_CLASS' })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(result))
  })
}
