import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { ParentDoc, ParentStudentLinkDoc } from '../db.js'
import { authenticate, requireActiveSubscription, requireRole, roleAtLeast } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { composeLinkedStudents, createLink, findDuplicateCandidates, linkedStudentCounts } from './service.js'
import type { DuplicateCandidate } from './service.js'

/**
 * Parent/guardian records — the real Parent Management feature (see db.ts's
 * parents section and parents/service.ts's file comment for how this
 * relates to StudentDoc.guardians, which this module never touches).
 *
 * Role mapping (a deliberate approximation onto the existing 4-role gate,
 * not a granular permission table — see the PR description for why):
 *   read                                          -> viewer+
 *   create / edit profile fields                  -> scheduler+
 *   edit financialResponsibility / portalAccess    -> admin+ (inline check)
 *   archive / reactivate / deactivate a link       -> admin+
 */

const parentBody = z.object({
  fullName: z.string().min(1).max(200),
  fullNameAr: z.string().max(200).nullable().default(null),
  nationalId: z.string().max(50).nullable().default(null),
  primaryPhone: z.string().min(5).max(30),
  alternativePhone: z.string().max(30).nullable().default(null),
  email: z.string().email().nullable().default(null),
  address: z.string().max(500).nullable().default(null),
  city: z.string().max(120).nullable().default(null),
  preferredContactMethod: z.enum(['phone', 'email', 'sms', 'whatsapp']).default('phone'),
  occupation: z.string().max(150).nullable().default(null),
  employer: z.string().max(150).nullable().default(null),
  emergencyContactName: z.string().max(200).nullable().default(null),
  emergencyContactPhone: z.string().max(30).nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
  /** Only takes effect if the caller is admin+ — see the inline check below. */
  portalAccessEnabled: z.boolean().default(false),
})
const updateParentBody = parentBody.partial()

const linkBody = z.object({
  studentId: z.string().min(1),
  relationshipType: z.string().min(1).max(50),
  primaryContact: z.boolean().default(false),
  secondaryContact: z.boolean().default(false),
  emergencyContact: z.boolean().default(false),
  authorizedPickup: z.boolean().default(false),
  /** Only takes effect if true AND the caller is admin+ — see inline check. */
  financialResponsibility: z.boolean().default(false),
  communicationPermissions: z
    .object({ email: z.boolean(), sms: z.boolean() })
    .default({ email: true, sms: false }),
  /** Only takes effect if true AND the caller is admin+ — see inline check. */
  portalAccess: z.boolean().default(false),
})
const updateLinkBody = linkBody.omit({ studentId: true }).partial()

const listQuery = z.object({
  search: z.string().max(200).optional(),
  studentName: z.string().max(200).optional(),
  branchId: z.string().optional(),
  classId: z.string().optional(),
  gradeLevel: z.string().optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
})

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toResponse(doc: ParentDoc, linkedStudentCount = 0) {
  return {
    id: doc._id,
    fullName: doc.fullName,
    fullNameAr: doc.fullNameAr,
    nationalId: doc.nationalId,
    primaryPhone: doc.primaryPhone,
    alternativePhone: doc.alternativePhone,
    email: doc.email,
    address: doc.address,
    city: doc.city,
    preferredContactMethod: doc.preferredContactMethod,
    status: doc.status,
    occupation: doc.occupation,
    employer: doc.employer,
    emergencyContactName: doc.emergencyContactName,
    emergencyContactPhone: doc.emergencyContactPhone,
    notes: doc.notes,
    portalAccess: doc.portalAccess,
    linkedStudentCount,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    archivedAt: doc.archivedAt ? doc.archivedAt.toISOString() : null,
  }
}

function linkToResponse(doc: ParentStudentLinkDoc) {
  return {
    id: doc._id,
    parentId: doc.parentId,
    studentId: doc.studentId,
    relationshipType: doc.relationshipType,
    primaryContact: doc.primaryContact,
    secondaryContact: doc.secondaryContact,
    emergencyContact: doc.emergencyContact,
    authorizedPickup: doc.authorizedPickup,
    financialResponsibility: doc.financialResponsibility,
    communicationPermissions: doc.communicationPermissions,
    portalAccess: doc.portalAccess,
    active: doc.active,
  }
}

const ERROR_STATUS: Record<string, number> = {
  UNKNOWN_PARENT: 404,
  UNKNOWN_STUDENT: 404,
  UNKNOWN_LINK: 404,
  LINK_EXISTS: 409,
  LINK_INACTIVE_EXISTS: 409,
  FINANCIAL_FLAG_REQUIRES_ADMIN: 403,
  PORTAL_FLAG_REQUIRES_ADMIN: 403,
}

export function registerParentRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription] }
  const writeGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('scheduler')] }
  const adminGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('admin')] }

  app.get('/parents', readGuard, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { search, studentName, branchId, classId, gradeLevel, status } = parsed.data

    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, async (ctx) => {
      // A student-side filter narrows to a set of parentIds via their links
      // before the parent query runs at all.
      let restrictToParentIds: Set<string> | null = null
      if (studentName || branchId || classId || gradeLevel) {
        const studentFilter: Record<string, unknown> = {}
        if (branchId) studentFilter.branchId = branchId
        if (classId) studentFilter.classId = classId
        if (studentName) {
          const pattern = { $regex: escapeRegex(studentName), $options: 'i' }
          studentFilter.$or = [{ givenName: pattern }, { familyName: pattern }]
        }
        let students = await ctx.students.find(studentFilter).toArray()
        if (gradeLevel) {
          const classIds = (await ctx.classes.find({ gradeLevel }).toArray()).map((c) => c._id)
          const inGrade = new Set(classIds)
          students = students.filter((s) => inGrade.has(s.classId))
        }
        const studentIds = students.map((s) => s._id)
        const links =
          studentIds.length > 0
            ? await ctx.parentStudentLinks.find({ studentId: { $in: studentIds }, active: true }).toArray()
            : []
        restrictToParentIds = new Set(links.map((l) => l.parentId))
      }

      const filter: Filter<ParentDoc> = {}
      filter.status = status ?? { $ne: 'archived' }
      if (search) {
        const pattern = { $regex: escapeRegex(search), $options: 'i' }
        filter.$or = [
          { fullName: pattern },
          { fullNameAr: pattern },
          { primaryPhone: pattern },
          { alternativePhone: pattern },
          { nationalId: pattern },
        ]
      }
      if (restrictToParentIds) filter._id = { $in: [...restrictToParentIds] }

      const parents = await ctx.parents.find(filter).sort({ fullName: 1 }).toArray()
      const counts = await linkedStudentCounts(ctx, parents.map((p) => p._id))
      return { parents, counts }
    })

    return reply.send({
      parents: result.parents.map((p) => toResponse(p, result.counts.get(p._id) ?? 0)),
    })
  })

  app.get('/parents/:id', readGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, async (ctx) => {
      const parent = await ctx.parents.findOne({ _id: id })
      if (!parent) return null
      const students = await composeLinkedStudents(ctx, id)
      return { parent, students }
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send({
      ...toResponse(result.parent, result.students.filter((s) => s.linkActive).length),
      students: result.students,
    })
  })

  app.post('/parents', writeGuard, async (request, reply) => {
    const parsed = parentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (parsed.data.portalAccessEnabled && !roleAtLeast(request.auth?.role, 'admin')) {
      return reply.code(403).send({ error: 'PORTAL_FLAG_REQUIRES_ADMIN' })
    }

    const tenantId = request.auth!.tenantId!
    const now = new Date()
    const { portalAccessEnabled, ...rest } = parsed.data
    let warnings: DuplicateCandidate[] = []
    const created = await withTenant(tenantId, async (ctx) => {
      warnings = await findDuplicateCandidates(ctx, {
        nationalId: rest.nationalId,
        primaryPhone: rest.primaryPhone,
        email: rest.email,
      })
      const _id = randomUUID()
      const doc: ParentDoc = {
        _id,
        tenantId,
        ...rest,
        status: 'active',
        portalAccess: { enabled: portalAccessEnabled, userId: null },
        createdAt: now,
        updatedAt: now,
        createdBy: request.auth!.sub,
        archivedAt: null,
        archivedBy: null,
      }
      await ctx.parents.insertOne(doc)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'parent.create',
        entity: 'parent',
        entityId: _id,
        before: null,
        after: doc,
      })
      return doc
    })
    return reply.code(201).send({ parent: toResponse(created, 0), warnings })
  })

  app.patch('/parents/:id', writeGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateParentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })
    if (
      parsed.data.portalAccessEnabled !== undefined &&
      !roleAtLeast(request.auth?.role, 'admin')
    ) {
      return reply.code(403).send({ error: 'PORTAL_FLAG_REQUIRES_ADMIN' })
    }

    const tenantId = request.auth!.tenantId!
    const { portalAccessEnabled, ...scalar } = parsed.data
    let warnings: DuplicateCandidate[] = []
    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.parents.findOne({ _id: id })
      if (!before) return null
      if (scalar.nationalId !== undefined || scalar.primaryPhone !== undefined || scalar.email !== undefined) {
        warnings = await findDuplicateCandidates(
          ctx,
          {
            nationalId: scalar.nationalId !== undefined ? scalar.nationalId : before.nationalId,
            primaryPhone: scalar.primaryPhone ?? before.primaryPhone,
            email: scalar.email !== undefined ? scalar.email : before.email,
          },
          id,
        )
      }
      const update: Record<string, unknown> = { ...scalar, updatedAt: new Date() }
      if (portalAccessEnabled !== undefined) {
        update.portalAccess = { enabled: portalAccessEnabled, userId: before.portalAccess.userId }
      }
      const updated = await ctx.parents.findOneAndUpdate({ _id: id }, { $set: update }, { returnDocument: 'after' })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'parent.update',
        entity: 'parent',
        entityId: id,
        before,
        after: updated,
      })
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    const students = await withTenant(tenantId, (ctx) => composeLinkedStudents(ctx, id))
    return reply.send({
      ...toResponse(result, students.filter((s) => s.linkActive).length),
      warnings,
    })
  })

  app.post('/parents/:id/archive', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const now = new Date()
    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.parents.findOne({ _id: id })
      if (!before) return null
      const updated = await ctx.parents.findOneAndUpdate(
        { _id: id },
        { $set: { status: 'archived', archivedAt: now, archivedBy: request.auth!.sub, updatedAt: now } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'parent.archive',
        entity: 'parent',
        entityId: id,
        before,
        after: updated,
      })
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(result))
  })

  app.post('/parents/:id/reactivate', adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const now = new Date()
    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.parents.findOne({ _id: id })
      if (!before) return null
      const updated = await ctx.parents.findOneAndUpdate(
        { _id: id },
        { $set: { status: 'active', archivedAt: null, archivedBy: null, updatedAt: now } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'parent.reactivate',
        entity: 'parent',
        entityId: id,
        before,
        after: updated,
      })
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(toResponse(result))
  })

  app.post('/parents/:parentId/links', writeGuard, async (request, reply) => {
    const { parentId } = request.params as { parentId: string }
    const parsed = linkBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (
      (parsed.data.financialResponsibility || parsed.data.portalAccess) &&
      !roleAtLeast(request.auth?.role, 'admin')
    ) {
      return reply
        .code(403)
        .send({ error: parsed.data.financialResponsibility ? 'FINANCIAL_FLAG_REQUIRES_ADMIN' : 'PORTAL_FLAG_REQUIRES_ADMIN' })
    }

    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, (ctx) =>
      createLink(ctx, tenantId, { parentId, ...parsed.data, actorId: request.auth!.sub }),
    )
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.code(201).send(linkToResponse(result.link))
  })

  app.patch('/parents/:parentId/links/:linkId', writeGuard, async (request, reply) => {
    const { parentId, linkId } = request.params as { parentId: string; linkId: string }
    const parsed = updateLinkBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (Object.keys(parsed.data).length === 0) return reply.code(400).send({ error: 'EMPTY_UPDATE' })
    if (
      (parsed.data.financialResponsibility === true || parsed.data.portalAccess === true) &&
      !roleAtLeast(request.auth?.role, 'admin')
    ) {
      return reply
        .code(403)
        .send({ error: parsed.data.financialResponsibility ? 'FINANCIAL_FLAG_REQUIRES_ADMIN' : 'PORTAL_FLAG_REQUIRES_ADMIN' })
    }

    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.parentStudentLinks.findOne({ _id: linkId, parentId })
      if (!before) return null
      const updated = await ctx.parentStudentLinks.findOneAndUpdate(
        { _id: linkId, parentId },
        { $set: { ...parsed.data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'parentStudentLink.update',
        entity: 'parentStudentLink',
        entityId: linkId,
        before,
        after: updated,
      })
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'UNKNOWN_LINK' })
    return reply.send(linkToResponse(result))
  })

  app.post('/parents/:parentId/links/:linkId/deactivate', adminGuard, async (request, reply) => {
    const { parentId, linkId } = request.params as { parentId: string; linkId: string }
    const tenantId = request.auth!.tenantId!
    const result = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.parentStudentLinks.findOne({ _id: linkId, parentId })
      if (!before) return null
      const updated = await ctx.parentStudentLinks.findOneAndUpdate(
        { _id: linkId, parentId },
        { $set: { active: false, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'parentStudentLink.deactivate',
        entity: 'parentStudentLink',
        entityId: linkId,
        before,
        after: updated,
      })
      return updated
    })
    if (!result) return reply.code(404).send({ error: 'UNKNOWN_LINK' })
    return reply.send(linkToResponse(result))
  })
}
