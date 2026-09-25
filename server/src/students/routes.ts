import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { Guardian, StudentDoc } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerCanUseBranch,
  requireActiveSubscription,
  requirePermission,
} from '../auth/guard.js'
import type { PermissionScope } from '../auth/scopes.js'
import { recordAudit } from '../audit.js'
import { verify } from '@node-rs/argon2'
import { withoutTenant } from '../db.js'
import { clearLoginFailures, isLockedOut, recordLoginFailure } from '../auth/rateLimit.js'
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
  lat: z.number().min(-90).max(90).nullable().default(null),
  lng: z.number().min(-180).max(180).nullable().default(null),
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
    lat: doc.lat,
    lng: doc.lng,
    primaryPhone: doc.primaryPhone,
    secondaryPhone: doc.secondaryPhone,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

/** Every read/write below is branch-scoped via `callerCanUseBranch` — a
 * membership confined to specific branches (`MembershipDoc.branchIds`)
 * used to be able to read and write every student tenant-wide through this
 * module regardless of that confinement, since nothing here ever checked
 * it. Same idiom `classes/routes.ts`/`finance/routes.ts` already use. */
async function requireStudentBranchAccess(
  request: Parameters<typeof callerCanUseBranch>[0],
  id: string,
  tenantId: string,
) {
  const student = await withTenant(tenantId, (ctx) => ctx.students.findOne({ _id: id }))
  if (!student) return { ok: false as const, status: 404, error: 'NOT_FOUND' }
  if (!(await callerCanUseBranch(request, student.branchId))) {
    return { ok: false as const, status: 403, error: 'BRANCH_FORBIDDEN' }
  }
  return { ok: true as const, student }
}

export function registerStudentRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('students.read')] }
  const scoped = (scope: PermissionScope) => ({
    preHandler: [authenticate, requireActiveSubscription, requirePermission(scope)],
  })

  app.get('/students', readGuard, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { branchId, classId, studentGroup, academicYearId, status, search } = parsed.data

    const allowed = await callerBranchIds(request)
    if (branchId && allowed !== null && !allowed.includes(branchId)) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const filter: Filter<StudentDoc> = {}
    if (branchId) filter.branchId = branchId
    else if (allowed !== null) filter.branchId = { $in: allowed }
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
    const access = await requireStudentBranchAccess(request, id, request.auth!.tenantId!)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    return reply.send(toResponse(access.student))
  })

  app.post('/students', scoped('students.create'), async (request, reply) => {
    const parsed = studentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const guardians = withGuardianIds(parsed.data.guardians)
    if (!atMostOnePrimary(guardians)) {
      return reply.code(400).send({ error: 'MULTIPLE_PRIMARY_GUARDIANS' })
    }

    const tenantId = request.auth!.tenantId!
    // The new student's branch follows from the class, not known until it's
    // resolved — pre-fetched here, before the write transaction, same
    // reasoning as the branch check itself: a check that ran after the
    // insert committed would only gate the HTTP response, not the write.
    const targetClass = await withTenant(tenantId, (ctx) =>
      ctx.classes.findOne({ _id: parsed.data.classId }),
    )
    if (targetClass && !(await callerCanUseBranch(request, targetClass.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

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
          branchId: klass.branchId,
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

  app.patch('/students/:id', scoped('students.update'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateStudentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })

    const guardians = parsed.data.guardians ? withGuardianIds(parsed.data.guardians) : undefined
    if (guardians && !atMostOnePrimary(guardians)) {
      return reply.code(400).send({ error: 'MULTIPLE_PRIMARY_GUARDIANS' })
    }

    const tenantId = request.auth!.tenantId!
    const access = await requireStudentBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })

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
          branchId: before.branchId,
          before: before.guardians,
          after: guardians,
        })
      }
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(result))
  })

  /**
   * Permanent delete — for a record that should never have existed (a
   * duplicate, a typo'd intake). A real departure is a withdrawal, which
   * keeps history. Guarded three ways:
   *  - `students.delete` (admin-level) plus the student's branch;
   *  - the caller re-enters their own password (rate-limited like login,
   *    so a stolen session cannot guess it; API keys can never delete);
   *  - a student with any invoice or payment is refused — financial
   *    history is never destroyed (SAMS spec §24); withdraw them instead.
   * The student's enrollments, attendance and parent links go with them;
   * the audit row keeps a full snapshot of what was removed.
   */
  app.delete('/students/:id', scoped('students.delete'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ password: z.string().min(1).max(200) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'PASSWORD_REQUIRED' })
    const auth = request.auth!
    if (auth.sub.startsWith('apikey:')) return reply.code(403).send({ error: 'FORBIDDEN' })

    if (await isLockedOut(auth.email)) return reply.code(429).send({ error: 'TOO_MANY_ATTEMPTS' })
    const user = await withoutTenant((db) => db.users.findOne({ _id: auth.sub }))
    const passwordOk = user?.passwordHash
      ? await verify(user.passwordHash, parsed.data.password).catch(() => false)
      : false
    if (!passwordOk) {
      await recordLoginFailure(auth.email)
      return reply.code(403).send({ error: 'INVALID_PASSWORD' })
    }
    await clearLoginFailures(auth.email)

    const tenantId = auth.tenantId!
    const student = await withTenant(tenantId, (ctx) => ctx.students.findOne({ _id: id }))
    if (!student) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, student.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const result = await withTenant(tenantId, async (ctx) => {
      const hasFinance =
        (await ctx.invoices.countDocuments({ studentId: id })) > 0 ||
        (await ctx.payments.countDocuments({ studentId: id })) > 0
      if (hasFinance) return 'HAS_FINANCIAL_HISTORY' as const
      const before = await ctx.students.findOne({ _id: id })
      if (!before) return 'NOT_FOUND' as const
      const enrollments = await ctx.enrollments.find({ studentId: id }).toArray()
      const links = await ctx.parentStudentLinks.find({ studentId: id }).toArray()
      const attendance = await ctx.attendance.countDocuments({ studentId: id })
      await ctx.enrollments.deleteMany({ studentId: id })
      await ctx.attendance.deleteMany({ studentId: id })
      await ctx.attendanceCorrections.deleteMany({ studentId: id })
      await ctx.parentStudentLinks.deleteMany({ studentId: id })
      await ctx.students.deleteOne({ _id: id })
      await recordAudit(ctx.auditLog, {
        actorId: auth.sub,
        action: 'student.delete',
        entity: 'student',
        entityId: id,
        branchId: before.branchId,
        before: { student: before, enrollments, parentLinks: links, attendanceRecords: attendance },
        after: null,
      })
      return 'ok' as const
    })
    if (result === 'HAS_FINANCIAL_HISTORY') return reply.code(409).send({ error: result })
    if (result === 'NOT_FOUND') return reply.code(404).send({ error: result })
    return reply.code(204).send()
  })
}
