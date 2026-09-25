import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import { readReason, setAuditReason } from '../requestContext.js'
import type { EmergencyContact, Guardian, StudentDoc, TenantContext } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerCanUseBranch,
  callerHasPermission,
  requireActiveSubscription,
  requirePermission,
} from '../auth/guard.js'
import { activeCodes, ensureDefaults } from '../settings/lookups.js'
import { computeCompleteness, type Completeness } from './completeness.js'
import type { PermissionScope } from '../auth/scopes.js'
import { recordAudit } from '../audit.js'
import { verify } from '@node-rs/argon2'
import { withoutTenant } from '../db.js'
import { clearLoginFailures, isLockedOut, recordLoginFailure } from '../auth/rateLimit.js'
import { createInitialEnrollment, resolveAcademicYearId } from '../enrollments/service.js'
import { gridFsStore } from '../documents/store.js'

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

const emergencyContactSchema = z.object({
  /** Kept when given (an edit), generated when not — same as guardians. */
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200),
  relationship: z.string().trim().min(1).max(50),
  phone: z.string().trim().min(5).max(30),
  alternatePhone: z.string().trim().max(30).nullable().default(null),
  notes: z.string().trim().max(300).nullable().default(null),
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
  // SAMS 2.2 profile
  preferredName: z.string().trim().max(100).nullable().default(null),
  nationality: z.string().trim().max(100).nullable().default(null),
  nationalId: z.string().trim().max(50).nullable().default(null),
  admissionSource: z.string().max(64).nullable().default(null),
  previousSchool: z.string().trim().max(200).nullable().default(null),
  emergencyContacts: z.array(emergencyContactSchema).max(5).default([]),
  custodyNotes: z.string().trim().max(2000).nullable().default(null),
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
  /** Only enrolled students whose record is incomplete (SAMS 2.2). */
  incomplete: z.enum(['1']).optional(),
})

function atMostOnePrimary(guardians: { isPrimary: boolean }[]): boolean {
  return guardians.filter((g) => g.isPrimary).length <= 1
}

function withContactIds(contacts: z.infer<typeof emergencyContactSchema>[]): EmergencyContact[] {
  return contacts.map((c) => ({ ...c, id: c.id ?? randomUUID() }))
}

/** Checks a submitted admission source against the school's active list. */
async function admissionSourceOk(ctx: TenantContext, code: string | null | undefined): Promise<boolean> {
  if (!code) return true
  return (await activeCodes(ctx, 'admissionSource')).has(code)
}

/** Assign a stable id to any guardian that arrived without one. */
function withGuardianIds(
  guardians: z.infer<typeof guardianSchema>[],
): Guardian[] {
  return guardians.map((g) => ({ ...g, id: g.id ?? randomUUID() }))
}

interface ResponseExtras {
  /** Caller holds `students.custody`; otherwise custody notes are withheld. */
  custody: boolean
  completeness?: Completeness
  photoDocumentId?: string | null
}

function toResponse(doc: StudentDoc, extras: ResponseExtras) {
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
    preferredName: doc.preferredName ?? null,
    nationality: doc.nationality ?? null,
    nationalId: doc.nationalId ?? null,
    admissionSource: doc.admissionSource ?? null,
    previousSchool: doc.previousSchool ?? null,
    emergencyContacts: doc.emergencyContacts ?? [],
    // Absent (not null) without the scope, so a client can tell "none
    // recorded" from "not yours to see".
    ...(extras.custody ? { custodyNotes: doc.custodyNotes ?? null } : {}),
    ...(extras.completeness ? { completeness: extras.completeness } : {}),
    ...(extras.photoDocumentId !== undefined ? { photoDocumentId: extras.photoDocumentId } : {}),
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
    const { branchId, classId, studentGroup, academicYearId, status, search, incomplete } = parsed.data

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
      filter.$or = [
        { givenName: pattern },
        { familyName: pattern },
        { preferredName: pattern },
        { studentNumber: pattern },
        { nationalId: pattern },
      ]
    }
    if (incomplete) filter.status = 'enrolled'

    const custody = await callerHasPermission(request, 'students.custody')
    const { students, completeness } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const students = await ctx.students.find(filter).sort({ familyName: 1, givenName: 1 }).toArray()
      return { students, completeness: await computeCompleteness(ctx, students) }
    })
    return reply.send({
      students: students
        .filter((s) => !incomplete || !completeness.get(s._id)?.complete)
        .map((s) => toResponse(s, { custody, completeness: completeness.get(s._id) })),
    })
  })

  app.get('/students/:id', readGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const access = await requireStudentBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const custody = await callerHasPermission(request, 'students.custody')
    const extras = await withTenant(tenantId, async (ctx) => {
      const completeness = (await computeCompleteness(ctx, [access.student])).get(id)
      const photo = await ctx.documents
        .find({ ownerType: 'student', ownerId: id, categoryCode: 'photo', isCurrent: true, archivedAt: null })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray()
      return { completeness, photoDocumentId: photo[0]?._id ?? null }
    })
    return reply.send(toResponse(access.student, { custody, ...extras }))
  })

  /**
   * The student's family (SAMS 2.2): parents linked through active
   * `parentStudentLinks`, with the link's flags. Needs `parents.read` on
   * top of the student's own access.
   */
  app.get('/students/:id/family', readGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    if (!(await callerHasPermission(request, 'parents.read'))) {
      return reply.code(403).send({ error: 'FORBIDDEN', required: 'parents.read' })
    }
    const access = await requireStudentBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const family = await withTenant(tenantId, async (ctx) => {
      const links = await ctx.parentStudentLinks.find({ studentId: id, active: true }).toArray()
      const parents = await ctx.parents.find({ _id: { $in: links.map((l) => l.parentId) } }).toArray()
      const byId = new Map(parents.map((p) => [p._id, p]))
      return links.flatMap((link) => {
        const parent = byId.get(link.parentId)
        if (!parent) return []
        return [
          {
            linkId: link._id,
            parentId: parent._id,
            fullName: parent.fullName,
            fullNameAr: parent.fullNameAr,
            primaryPhone: parent.primaryPhone,
            email: parent.email,
            status: parent.status,
            relationshipType: link.relationshipType,
            primaryContact: link.primaryContact,
            emergencyContact: link.emergencyContact,
            authorizedPickup: link.authorizedPickup,
            financialResponsibility: link.financialResponsibility,
          },
        ]
      })
    })
    return reply.send({ family })
  })

  app.post('/students', scoped('students.create'), async (request, reply) => {
    const parsed = studentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const guardians = withGuardianIds(parsed.data.guardians)
    if (!atMostOnePrimary(guardians)) {
      return reply.code(400).send({ error: 'MULTIPLE_PRIMARY_GUARDIANS' })
    }

    const tenantId = request.auth!.tenantId!
    if (parsed.data.custodyNotes && !(await callerHasPermission(request, 'students.custody'))) {
      return reply.code(403).send({ error: 'FORBIDDEN', required: 'students.custody' })
    }
    if (parsed.data.admissionSource) await ensureDefaults(tenantId, 'admissionSource')
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
        if (!(await admissionSourceOk(ctx, parsed.data.admissionSource))) return 'bad_source' as const
        const academicYearId = await resolveAcademicYearId(ctx, klass.academicYearId)
        if (!academicYearId) return 'no_year' as const

        const _id = randomUUID()
        const { classId: _c, guardians: _g, emergencyContacts, ...rest } = parsed.data
        await ctx.students.insertOne({
          _id,
          ...rest,
          guardians,
          emergencyContacts: withContactIds(emergencyContacts),
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
      if (result === 'bad_source') return reply.code(400).send({ error: 'INVALID_ADMISSION_SOURCE' })
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
    const custody = await callerHasPermission(request, 'students.custody')
    if ('custodyNotes' in parsed.data && !custody) {
      return reply.code(403).send({ error: 'FORBIDDEN', required: 'students.custody' })
    }
    const access = await requireStudentBranchAccess(request, id, tenantId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    if (parsed.data.admissionSource) await ensureDefaults(tenantId, 'admissionSource')

    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.students.findOne({ _id: id })
      if (!before) return null
      if (!(await admissionSourceOk(ctx, parsed.data.admissionSource))) return 'bad_source' as const
      const { guardians: _drop, emergencyContacts: contactsIn, ...scalar } = parsed.data
      const emergencyContacts = contactsIn ? withContactIds(contactsIn) : undefined
      const updated = await ctx.students.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            ...scalar,
            ...(guardians ? { guardians } : {}),
            ...(emergencyContacts ? { emergencyContacts } : {}),
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' },
      )
      // Only the fields this request changed, before and after (SAMS 1.12).
      // Custody notes are sensitive: the log records that they changed,
      // never their text (audit readers need not hold students.custody).
      const shown = (k: string, v: unknown) => (k === 'custodyNotes' ? (v ? '[redacted]' : null) : (v ?? null))
      const changed = Object.keys(scalar) as (keyof typeof scalar)[]
      if (updated && changed.length > 0) {
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'student.update',
          entity: 'student',
          entityId: id,
          branchId: before.branchId,
          before: Object.fromEntries(changed.map((k) => [k, shown(k, before[k as keyof typeof before])])),
          after: Object.fromEntries(changed.map((k) => [k, shown(k, scalar[k])])),
        })
      }
      if (updated && emergencyContacts) {
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'emergencyContacts.update',
          entity: 'student',
          entityId: id,
          branchId: before.branchId,
          before: before.emergencyContacts ?? [],
          after: emergencyContacts,
        })
      }
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
      if (!updated) return null
      const completeness = (await computeCompleteness(ctx, [updated])).get(id)
      return { updated, completeness }
    })
    if (result === 'bad_source') return reply.code(400).send({ error: 'INVALID_ADMISSION_SOURCE' })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(result.updated, { custody, completeness: result.completeness }))
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
   * The student's enrollments, attendance, parent links and documents go
   * with them; the audit row keeps a full snapshot of what was removed
   * (document metadata only; the files themselves are deleted).
   */
  app.delete('/students/:id', scoped('students.delete'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = z.object({ password: z.string().min(1).max(200) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'PASSWORD_REQUIRED' })
    const reason = readReason(request.body)
    if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' })
    setAuditReason(reason)
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
      const documents = await ctx.documents.find({ ownerType: 'student', ownerId: id }).toArray()
      await ctx.documents.deleteMany({ ownerType: 'student', ownerId: id })
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
        before: {
          student: before,
          enrollments,
          parentLinks: links,
          attendanceRecords: attendance,
          documents: documents.map(({ fileId: _f, ...meta }) => meta),
        },
        after: null,
      })
      return { fileIds: documents.map((d) => d.fileId) }
    })
    if (result === 'HAS_FINANCIAL_HISTORY') return reply.code(409).send({ error: result })
    if (result === 'NOT_FOUND') return reply.code(404).send({ error: result })
    // After the commit: GridFS can't join the transaction. A failure here
    // leaves an unreferenced file, never a reference to a missing one.
    for (const fileId of result.fileIds) {
      await gridFsStore.remove(tenantId, fileId).catch((error) => request.log.warn(error, 'document file not removed'))
    }
    return reply.code(204).send()
  })
}
