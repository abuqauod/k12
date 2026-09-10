import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { Guardian, StudentDoc } from '../db.js'
import { authenticate, requireActiveSubscription, requireRole } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { createInitialEnrollment, resolveAcademicYearId } from '../enrollments/service.js'

/**
 * The student roster. A student's *demographics, guardians and transport*
 * are edited here; where the student sits (branch / class / academic year)
 * is an enrollment concern and moves through `enrollments/routes.ts`
 * (transfer / withdraw). `branchId`, `classId`, `academicYearId` and
 * `studentGroup` on the document are a read cache of the active enrollment —
 * this route sets them only at creation, and only from the class, never
 * from a request body.
 */

const guardianSchema = z.object({
  /** Optional on input — kept if given (an edit), generated if not (a new
   * guardian). Lets the client round-trip a guardian without losing its id. */
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(200),
  relationship: z.string().min(1).max(50),
  phone: z.string().min(5).max(30),
  secondaryPhone: z.string().max(30).nullable().default(null),
  email: z.string().email().nullable().default(null),
  isPrimary: z.boolean().default(false),
  preferredLanguage: z.enum(['en', 'ar']).default('en'),
  notifyByEmail: z.boolean().default(true),
  notifyBySms: z.boolean().default(false),
  active: z.boolean().default(true),
})

const studentBody = z.object({
  studentNumber: z.string().min(1).max(50),
  givenName: z.string().min(1).max(100),
  familyName: z.string().min(1).max(100),
  givenNameAr: z.string().max(100).nullable().default(null),
  familyNameAr: z.string().max(100).nullable().default(null),
  dob: z.string().date().nullable().default(null),
  gender: z.enum(['male', 'female']).nullable().default(null),
  /** The homeroom the student starts in. Their branch and `studentGroup`
   * label follow from it; changing it later is a transfer, not a PATCH. */
  classId: z.string().min(1),
  admissionDate: z.string().date().nullable().default(null),
  address: z.string().max(500).nullable().default(null),
  medicalNotes: z.string().max(2000).nullable().default(null),
  guardians: z.array(guardianSchema).max(10).default([]),
  stopId: z.string().default(''),
  transportMode: z.enum(['TWO_WAY', 'MORNING', 'EVENING', 'NONE']).default('NONE'),
  primaryPhone: z.string().max(30).default(''),
  secondaryPhone: z.string().max(30).default(''),
})

/** PATCH cannot move a student — `classId` is intentionally absent. */
const updateStudentBody = studentBody.omit({ classId: true, studentNumber: true }).partial()

const listQuery = z.object({
  branchId: z.string().optional(),
  classId: z.string().optional(),
  studentGroup: z.string().optional(),
  academicYearId: z.string().optional(),
  status: z.enum(['enrolled', 'graduated', 'withdrawn', 'inquiry']).optional(),
  search: z.string().max(200).optional(),
})

function atMostOnePrimary(guardians: { isPrimary: boolean }[]): boolean {
  return guardians.filter((g) => g.isPrimary).length <= 1
}

/** Assign a stable id to any guardian that arrived without one. */
function withGuardianIds(
  guardians: z.infer<typeof guardianSchema>[],
): Guardian[] {
  return guardians.map((g) => ({ ...g, id: g.id ?? randomUUID() }))
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
    academicYearId: doc.academicYearId,
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
    const { branchId, classId, studentGroup, academicYearId, status, search } = parsed.data

    const filter: Filter<StudentDoc> = {}
    if (branchId) filter.branchId = branchId
    if (classId) filter.classId = classId
    if (studentGroup) filter.studentGroup = studentGroup
    if (academicYearId) filter.academicYearId = academicYearId
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
    const guardians = withGuardianIds(parsed.data.guardians)
    if (!atMostOnePrimary(guardians)) {
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
        const academicYearId = await resolveAcademicYearId(ctx, klass.academicYearId)
        if (!academicYearId) return 'no_year' as const

        const _id = randomUUID()
        const { classId: _c, guardians: _g, ...rest } = parsed.data
        await ctx.students.insertOne({
          _id,
          ...rest,
          guardians,
          // Cache of the enrollment created just below.
          branchId: klass.branchId,
          classId: klass._id,
          academicYearId,
          studentGroup: `${klass.gradeLevel} ${klass.name}`.trim(),
          status: 'enrolled',
          createdAt: now,
          updatedAt: now,
        })
        const enrolled = await createInitialEnrollment(ctx, tenantId, {
          studentId: _id,
          classId: klass._id,
          startDate: parsed.data.admissionDate ?? undefined,
          actorId: request.auth!.sub,
        })
        if (!enrolled.ok) return enrolled.error
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'student.create',
          entity: 'student',
          entityId: _id,
          before: null,
          after: { studentNumber: parsed.data.studentNumber, classId: klass._id },
        })
        return _id
      })
      if (result === 'unknown_class') return reply.code(404).send({ error: 'UNKNOWN_CLASS' })
      if (result === 'number_taken') return reply.code(409).send({ error: 'STUDENT_NUMBER_TAKEN' })
      if (result === 'no_year') return reply.code(409).send({ error: 'NO_ACADEMIC_YEAR' })
      if (result === 'ALREADY_ENROLLED' || result === 'NO_ACADEMIC_YEAR' || result === 'UNKNOWN_CLASS') {
        return reply.code(409).send({ error: result })
      }
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
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })

    const guardians = parsed.data.guardians ? withGuardianIds(parsed.data.guardians) : undefined
    if (guardians && !atMostOnePrimary(guardians)) {
      return reply.code(400).send({ error: 'MULTIPLE_PRIMARY_GUARDIANS' })
    }

    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.students.findOne({ _id: id })
      if (!before) return null
      const { guardians: _drop, ...scalar } = parsed.data
      const updated = await ctx.students.findOneAndUpdate(
        { _id: id },
        { $set: { ...scalar, ...(guardians ? { guardians } : {}), updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      if (updated && guardians) {
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'guardians.update',
          entity: 'student',
          entityId: id,
          before: before.guardians,
          after: guardians,
        })
      }
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(result))
  })
}
