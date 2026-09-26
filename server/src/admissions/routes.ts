import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { ApplicationDoc } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerCanUseBranch,
  callerHasPermission,
  requireActiveSubscription,
  requirePermission,
} from '../auth/guard.js'
import type { PermissionScope } from '../auth/scopes.js'
import { recordAudit } from '../audit.js'
import { readReason, setAuditReason } from '../requestContext.js'
import { activeCodes, ensureDefaults } from '../settings/lookups.js'
import './approvals.js'
import {
  ConvertAbort,
  DEFAULT_REQUIRED_DOCUMENTS,
  EDITABLE,
  checklist,
  convertApplication,
  nextApplicationNumber,
} from './service.js'

/**
 * Admissions (SAMS 2.5). Reading needs admissions.read; creating, editing,
 * moving an application along and converting it need admissions.manage;
 * the accept / reject / waitlist decision is an approval request
 * (`POST /approvals`, type `admissions.decision`, see ./approvals.ts).
 * Every application belongs to one branch and is only visible there.
 */

const guardianSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  fullName: z.string().trim().min(1).max(200),
  relationship: z.string().trim().min(1).max(50),
  phone: z.string().trim().min(5).max(30),
  email: z.string().trim().email().nullable().default(null),
  preferredLanguage: z.enum(['en', 'ar']).default('en'),
  primaryContact: z.boolean().default(false),
  existingParentId: z.string().min(1).max(64).nullable().default(null),
})

const applicantSchema = z.object({
  givenName: z.string().trim().min(1).max(100),
  familyName: z.string().trim().min(1).max(100),
  givenNameAr: z.string().trim().max(100).nullable().default(null),
  familyNameAr: z.string().trim().max(100).nullable().default(null),
  dob: z.string().date().nullable().default(null),
  gender: z.enum(['male', 'female']).nullable().default(null),
  nationality: z.string().trim().max(100).nullable().default(null),
  nationalId: z.string().trim().max(50).nullable().default(null),
  previousSchool: z.string().trim().max(200).nullable().default(null),
})

const createBody = z.object({
  branchId: z.string().min(1),
  academicYearId: z.string().min(1),
  gradeLevel: z.string().trim().min(1).max(50),
  applicant: applicantSchema,
  guardians: z.array(guardianSchema).max(4).default([]),
  source: z.string().max(64).nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
  requiredDocuments: z.array(z.string().min(1).max(64)).max(20).optional(),
})

/** The branch is fixed once created (it scopes who can see it). */
const updateBody = createBody.omit({ branchId: true }).partial()

const listQuery = z.object({
  status: z
    .enum(['draft', 'submitted', 'under_review', 'accepted', 'rejected', 'waitlisted', 'converted', 'withdrawn'])
    .optional(),
  branchId: z.string().optional(),
  academicYearId: z.string().optional(),
  search: z.string().max(200).optional(),
})

const convertBody = z.object({
  classId: z.string().min(1),
  studentNumber: z.string().trim().min(1).max(50),
  startDate: z.string().date(),
})

const ERROR_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  UNKNOWN_CLASS: 404,
  UNKNOWN_PARENT: 404,
}

function atMostOnePrimary(guardians: { primaryContact: boolean }[]) {
  return guardians.filter((g) => g.primaryContact).length <= 1
}

function toResponse(doc: ApplicationDoc) {
  return {
    id: doc._id,
    applicationNumber: doc.applicationNumber,
    branchId: doc.branchId,
    academicYearId: doc.academicYearId,
    gradeLevel: doc.gradeLevel,
    applicant: doc.applicant,
    guardians: doc.guardians,
    source: doc.source,
    notes: doc.notes,
    requiredDocuments: doc.requiredDocuments,
    status: doc.status,
    decision: doc.decision
      ? { ...doc.decision, decidedAt: doc.decision.decidedAt.toISOString() }
      : null,
    submittedAt: doc.submittedAt?.toISOString() ?? null,
    convertedStudentId: doc.convertedStudentId,
    convertedAt: doc.convertedAt?.toISOString() ?? null,
    withdrawnReason: doc.withdrawnReason,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function registerAdmissionRoutes(app: FastifyInstance): void {
  const scoped = (scope: PermissionScope) => ({
    preHandler: [authenticate, requireActiveSubscription, requirePermission(scope)],
  })

  /** Loads an application the caller may see. */
  const load = async (request: FastifyRequest, id: string) => {
    const doc = await withTenant(request.auth!.tenantId!, (ctx) => ctx.applications.findOne({ _id: id }))
    if (!doc) return { ok: false as const, status: 404, error: 'NOT_FOUND' }
    if (!(await callerCanUseBranch(request, doc.branchId))) {
      return { ok: false as const, status: 403, error: 'BRANCH_FORBIDDEN' }
    }
    return { ok: true as const, doc }
  }

  /** Validates codes against the settings lists. */
  const validCodes = async (tenantId: string, body: { source?: string | null; requiredDocuments?: string[] }) => {
    if (body.source) await ensureDefaults(tenantId, 'admissionSource')
    if (body.requiredDocuments) await ensureDefaults(tenantId, 'documentCategory')
    return withTenant(tenantId, async (ctx) => {
      if (body.source && !(await activeCodes(ctx, 'admissionSource')).has(body.source)) return 'INVALID_SOURCE'
      if (body.requiredDocuments) {
        const categories = await activeCodes(ctx, 'documentCategory')
        if (body.requiredDocuments.some((c) => !categories.has(c))) return 'INVALID_DOCUMENT_CATEGORY'
      }
      return null
    })
  }

  app.get('/admissions/applications', scoped('admissions.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { status, branchId, academicYearId, search } = parsed.data
    const allowed = await callerBranchIds(request)
    if (branchId && allowed !== null && !allowed.includes(branchId)) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    const filter: Filter<ApplicationDoc> = {}
    if (branchId) filter.branchId = branchId
    else if (allowed !== null) filter.branchId = { $in: allowed }
    if (status) filter.status = status
    if (academicYearId) filter.academicYearId = academicYearId
    if (search) {
      const pattern = { $regex: escapeRegex(search), $options: 'i' }
      filter.$or = [
        { applicationNumber: pattern },
        { 'applicant.givenName': pattern },
        { 'applicant.familyName': pattern },
        { 'guardians.fullName': pattern },
        { 'guardians.phone': pattern },
      ]
    }
    const docs = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.applications.find(filter).sort({ createdAt: -1 }).limit(500).toArray(),
    )
    return reply.send({ applications: docs.map(toResponse) })
  })

  app.get('/admissions/applications/:id', scoped('admissions.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const found = await load(request, id)
    if (!found.ok) return reply.code(found.status).send({ error: found.error })
    const items = await withTenant(request.auth!.tenantId!, (ctx) => checklist(ctx, found.doc))
    return reply.send({ ...toResponse(found.doc), checklist: items })
  })

  app.post('/admissions/applications', scoped('admissions.manage'), async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const body = parsed.data
    if (!atMostOnePrimary(body.guardians)) return reply.code(400).send({ error: 'MULTIPLE_PRIMARY_CONTACTS' })
    if (!(await callerCanUseBranch(request, body.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const tenantId = request.auth!.tenantId!
    const invalid = await validCodes(tenantId, body)
    if (invalid) return reply.code(400).send({ error: invalid })

    const result = await withTenant(tenantId, async (ctx) => {
      if (!(await ctx.branches.findOne({ _id: body.branchId }))) return 'UNKNOWN_BRANCH' as const
      if (!(await ctx.academicYears.findOne({ _id: body.academicYearId }))) return 'UNKNOWN_ACADEMIC_YEAR' as const
      const now = new Date()
      const doc: ApplicationDoc = {
        _id: randomUUID(),
        tenantId,
        applicationNumber: await nextApplicationNumber(ctx, tenantId),
        branchId: body.branchId,
        academicYearId: body.academicYearId,
        gradeLevel: body.gradeLevel,
        applicant: body.applicant,
        guardians: body.guardians.map((g) => ({ ...g, id: g.id ?? randomUUID() })),
        source: body.source,
        notes: body.notes,
        requiredDocuments: body.requiredDocuments ?? DEFAULT_REQUIRED_DOCUMENTS,
        status: 'draft',
        decision: null,
        submittedAt: null,
        convertedStudentId: null,
        convertedAt: null,
        withdrawnReason: null,
        createdBy: request.auth!.sub,
        createdAt: now,
        updatedAt: now,
      }
      await ctx.applications.insertOne(doc)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'application.create',
        entity: 'application',
        entityId: doc._id,
        branchId: doc.branchId,
        before: null,
        after: { applicationNumber: doc.applicationNumber, gradeLevel: doc.gradeLevel },
      })
      return doc
    })
    if (typeof result === 'string') return reply.code(404).send({ error: result })
    return reply.code(201).send(toResponse(result))
  })

  app.patch('/admissions/applications/:id', scoped('admissions.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const body = parsed.data
    if (Object.keys(body).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })
    if (body.guardians && !atMostOnePrimary(body.guardians)) {
      return reply.code(400).send({ error: 'MULTIPLE_PRIMARY_CONTACTS' })
    }
    const found = await load(request, id)
    if (!found.ok) return reply.code(found.status).send({ error: found.error })
    if (!EDITABLE.has(found.doc.status)) return reply.code(409).send({ error: 'NOT_EDITABLE' })
    const tenantId = request.auth!.tenantId!
    const invalid = await validCodes(tenantId, body)
    if (invalid) return reply.code(400).send({ error: invalid })

    const updated = await withTenant(tenantId, async (ctx) => {
      const set: Partial<ApplicationDoc> = { ...body, updatedAt: new Date() } as Partial<ApplicationDoc>
      if (body.guardians) set.guardians = body.guardians.map((g) => ({ ...g, id: g.id ?? randomUUID() }))
      const after = await ctx.applications.findOneAndUpdate(
        { _id: id, status: found.doc.status },
        { $set: set },
        { returnDocument: 'after' },
      )
      if (after) {
        const changed = Object.keys(body)
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'application.update',
          entity: 'application',
          entityId: id,
          branchId: found.doc.branchId,
          before: Object.fromEntries(changed.map((k) => [k, found.doc[k as keyof ApplicationDoc] ?? null])),
          after: Object.fromEntries(changed.map((k) => [k, (after as Record<string, unknown>)[k] ?? null])),
        })
      }
      return after
    })
    if (!updated) return reply.code(409).send({ error: 'STALE_UPDATE' })
    return reply.send(toResponse(updated))
  })

  /** Moves an application one step: submit (draft → submitted) or review
   * (submitted / waitlisted → under_review). */
  const step = (action: 'submit' | 'review', from: ApplicationDoc['status'][], to: ApplicationDoc['status']) =>
    app.post(`/admissions/applications/:id/${action}`, scoped('admissions.manage'), async (request, reply) => {
      const { id } = request.params as { id: string }
      const found = await load(request, id)
      if (!found.ok) return reply.code(found.status).send({ error: found.error })
      if (!from.includes(found.doc.status)) return reply.code(409).send({ error: 'WRONG_STATUS', status: found.doc.status })
      if (action === 'submit' && found.doc.guardians.length === 0) {
        return reply.code(400).send({ error: 'GUARDIAN_REQUIRED' })
      }
      const updated = await withTenant(request.auth!.tenantId!, async (ctx) => {
        const now = new Date()
        const after = await ctx.applications.findOneAndUpdate(
          { _id: id, status: found.doc.status },
          { $set: { status: to, updatedAt: now, ...(action === 'submit' ? { submittedAt: now } : {}) } },
          { returnDocument: 'after' },
        )
        if (after) {
          await recordAudit(ctx.auditLog, {
            actorId: request.auth!.sub,
            action: `application.${action}`,
            entity: 'application',
            entityId: id,
            branchId: found.doc.branchId,
            before: { status: found.doc.status },
            after: { status: to },
          })
        }
        return after
      })
      if (!updated) return reply.code(409).send({ error: 'STALE_UPDATE' })
      return reply.send(toResponse(updated))
    })
  step('submit', ['draft'], 'submitted')
  step('review', ['submitted', 'waitlisted'], 'under_review')

  /** The family withdraws the application. Needs a reason; kept, not deleted. */
  app.post('/admissions/applications/:id/withdraw', scoped('admissions.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const reason = readReason(request.body)
    if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' })
    setAuditReason(reason)
    const found = await load(request, id)
    if (!found.ok) return reply.code(found.status).send({ error: found.error })
    if (['converted', 'withdrawn', 'rejected'].includes(found.doc.status)) {
      return reply.code(409).send({ error: 'WRONG_STATUS', status: found.doc.status })
    }
    const updated = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const after = await ctx.applications.findOneAndUpdate(
        { _id: id, status: found.doc.status },
        { $set: { status: 'withdrawn', withdrawnReason: reason, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      if (after) {
        // An open decision request no longer applies.
        await ctx.approvalRequests.updateMany(
          { type: 'admissions.decision', entityId: id, status: 'pending' },
          { $set: { status: 'cancelled', updatedAt: new Date() }, $inc: { version: 1 } },
        )
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'application.withdraw',
          entity: 'application',
          entityId: id,
          branchId: found.doc.branchId,
          before: { status: found.doc.status },
          after: { status: 'withdrawn' },
        })
      }
      return after
    })
    if (!updated) return reply.code(409).send({ error: 'STALE_UPDATE' })
    return reply.send(toResponse(updated))
  })

  app.post('/admissions/applications/:id/convert', scoped('admissions.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = convertBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const found = await load(request, id)
    if (!found.ok) return reply.code(found.status).send({ error: found.error })
    // Conversion writes a student and parents: it also needs those scopes.
    for (const scope of ['students.create', 'parents.write'] as const) {
      if (!(await callerHasPermission(request, scope))) {
        return reply.code(403).send({ error: 'FORBIDDEN', required: scope })
      }
    }
    try {
      const result = await withTenant(request.auth!.tenantId!, (ctx) =>
        convertApplication(ctx, request.auth!.tenantId!, {
          applicationId: id,
          ...parsed.data,
          actorId: request.auth!.sub,
        }),
      )
      if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 409).send({ error: result.error })
      return reply.code(201).send(result)
    } catch (error) {
      if (error instanceof ConvertAbort) return reply.code(ERROR_STATUS[error.code] ?? 409).send({ error: error.code })
      throw error
    }
  })
}

