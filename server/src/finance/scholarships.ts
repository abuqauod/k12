import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { ScholarshipDoc, TenantContext } from '../db.js'
import { callerBranchIds, callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { readReason, setAuditReason } from '../requestContext.js'
import { registerApprovalType } from '../approvals/registry.js'
import { insertRequest } from '../approvals/service.js'
import { activeEnrollment } from '../enrollments/service.js'
import { invoicePaidTotals, scholarshipAdjustment, setAdjustments } from './service.js'
import {
  branchFilter,
  describeValue,
  FinanceAbort,
  isFailure,
  scoped,
  sendFailure,
  studentName,
  transact,
} from './common.js'

/**
 * SAMS 3.2, part two: formal scholarships. One award, for one student and
 * one academic year, raised with its reason (and supporting documents,
 * owner type `scholarship`) and decided through the approval engine by a
 * holder of `finance.scholarship.approve` — never the person who raised
 * it.
 *
 * Once approved it applies, as an invoice adjustment, to every non-void
 * invoice of that student and year, and to any generated later. Where the
 * student has already paid more than the reduced total, the difference is
 * a credit that can be refunded (3.3).
 *
 * Revoking stops it applying to new invoices and takes it off invoices
 * with nothing paid yet; invoices already (partly) paid keep it, since
 * they were settled on those terms.
 */

const createBody = z.object({
  studentId: z.string().min(1),
  /** Defaults to the year of the student's current enrollment. */
  academicYearId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(120),
  type: z.enum(['amount', 'percent']),
  value: z.number().int().min(1),
  reason: z.string().trim().min(1).max(1000),
})

const listQuery = z.object({
  studentId: z.string().optional(),
  branchId: z.string().optional(),
  academicYearId: z.string().optional(),
  status: z.enum(['pending', 'active', 'rejected', 'cancelled', 'revoked']).optional(),
})

export function scholarshipResponse(doc: ScholarshipDoc, names?: Map<string, string>) {
  return {
    id: doc._id,
    studentId: doc.studentId,
    studentName: names?.get(doc.studentId) ?? null,
    branchId: doc.branchId,
    academicYearId: doc.academicYearId,
    name: doc.name,
    type: doc.type,
    value: doc.value,
    reason: doc.reason,
    status: doc.status,
    requestedBy: doc.requestedBy,
    decidedBy: doc.decidedBy,
    decidedAt: doc.decidedAt?.toISOString() ?? null,
    revokedAt: doc.revokedAt?.toISOString() ?? null,
    revokeReason: doc.revokeReason,
    createdAt: doc.createdAt.toISOString(),
  }
}

/** Adds an active scholarship to every non-void invoice of its student and
 * year that doesn't already carry it. Returns how many changed. */
async function applyToInvoices(ctx: TenantContext, sch: ScholarshipDoc, actorId: string): Promise<number> {
  const invoices = await ctx.invoices
    .find({ studentId: sch.studentId, academicYearId: sch.academicYearId, status: { $ne: 'void' } })
    .toArray()
  let changed = 0
  for (const invoice of invoices) {
    if ((invoice.adjustments ?? []).some((a) => a.refId === sch._id)) continue
    await setAdjustments(ctx, invoice, [...(invoice.adjustments ?? []), scholarshipAdjustment(sch, new Date(), actorId)], {
      actorId,
      action: 'invoice.scholarship.apply',
    })
    changed++
  }
  return changed
}

registerApprovalType<Record<string, never>>({
  type: 'finance.scholarship',
  entity: 'scholarship',
  requestScope: 'finance.scholarship.request',
  decideScope: 'finance.scholarship.approve',
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async resolve(ctx, id) {
    const sch = await ctx.scholarships.findOne({ _id: id })
    if (!sch) return { ok: false, error: 'NOT_FOUND' }
    if (sch.status !== 'pending') return { ok: false, error: 'NOT_PENDING' }
    return {
      ok: true,
      branchId: sch.branchId,
      dedupeKey: `scholarship:${id}`,
      summary: `${sch.name} · ${await studentName(ctx, sch.studentId)} · −${describeValue(sch.type, sch.value)}`,
    }
  },
  async onApproved(ctx, request, actorId) {
    const now = new Date()
    const sch = await ctx.scholarships.findOneAndUpdate(
      { _id: request.entityId, status: 'pending' },
      { $set: { status: 'active', decidedBy: actorId, decidedAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    )
    if (!sch) return { ok: false, error: 'NOT_PENDING' }
    const applied = await applyToInvoices(ctx, sch, actorId)
    await recordAudit(ctx.auditLog, {
      actorId,
      action: 'scholarship.approve',
      entity: 'scholarship',
      entityId: sch._id,
      branchId: sch.branchId,
      after: { status: 'active', invoicesUpdated: applied },
    })
    return { ok: true }
  },
  async onClosed(ctx, request, outcome, actorId) {
    const now = new Date()
    await ctx.scholarships.findOneAndUpdate(
      { _id: request.entityId, status: 'pending' },
      { $set: { status: outcome, decidedBy: actorId, decidedAt: now, updatedAt: now } },
    )
  },
})

export function registerScholarshipRoutes(app: FastifyInstance): void {
  app.get('/finance/scholarships', scoped('finance.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<ScholarshipDoc> = {}
    if (branches.branchIds) filter.branchId = { $in: branches.branchIds }
    if (parsed.data.studentId) filter.studentId = parsed.data.studentId
    if (parsed.data.academicYearId) filter.academicYearId = parsed.data.academicYearId
    if (parsed.data.status) filter.status = parsed.data.status
    const { rows, names } = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const rows = await ctx.scholarships.find(filter).sort({ createdAt: -1 }).limit(500).toArray()
      const students = await ctx.students.find({ _id: { $in: [...new Set(rows.map((r) => r.studentId))] } }).toArray()
      return { rows, names: new Map(students.map((s) => [s._id, `${s.givenName} ${s.familyName}`.trim()])) }
    })
    return reply.send({ scholarships: rows.map((r) => scholarshipResponse(r, names)) })
  })

  app.get('/finance/scholarships/:id', scoped('finance.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const found = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const doc = await ctx.scholarships.findOne({ _id: id })
      return doc ? { doc, name: await studentName(ctx, doc.studentId) } : null
    })
    if (!found) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, found.doc.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    return reply.send(scholarshipResponse(found.doc, new Map([[found.doc.studentId, found.name]])))
  })

  app.post('/finance/scholarships', scoped('finance.scholarship.request'), async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (parsed.data.type === 'percent' && parsed.data.value > 100) return reply.code(400).send({ error: 'VALUE_OUT_OF_RANGE' })
    const tenantId = request.auth!.tenantId!
    const student = await withTenant(tenantId, (ctx) => ctx.students.findOne({ _id: parsed.data.studentId }))
    if (!student) return reply.code(404).send({ error: 'UNKNOWN_STUDENT' })
    if (!(await callerCanUseBranch(request, student.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const allowedBranchIds = await callerBranchIds(request)

    const result = await transact(tenantId, async (ctx) => {
      const yearId = parsed.data.academicYearId ?? (await activeEnrollment(ctx, student._id))?.academicYearId
      if (!yearId || !(await ctx.academicYears.findOne({ _id: yearId }))) throw new FinanceAbort('NO_ACADEMIC_YEAR')
      const now = new Date()
      const doc: ScholarshipDoc = {
        _id: randomUUID(),
        tenantId,
        studentId: student._id,
        branchId: student.branchId,
        academicYearId: yearId,
        name: parsed.data.name,
        type: parsed.data.type,
        value: parsed.data.value,
        reason: parsed.data.reason,
        status: 'pending',
        requestedBy: request.auth!.sub,
        decidedBy: null,
        decidedAt: null,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
        createdAt: now,
        updatedAt: now,
      }
      await ctx.scholarships.insertOne(doc)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'scholarship.request',
        entity: 'scholarship',
        entityId: doc._id,
        branchId: doc.branchId,
        after: doc,
      })
      const approval = await insertRequest(ctx, {
        type: 'finance.scholarship',
        entityId: doc._id,
        payload: {},
        comment: parsed.data.reason,
        actorId: request.auth!.sub,
        allowedBranchIds,
      })
      if (!approval.ok) throw new FinanceAbort(approval.error)
      return { doc, approvalId: approval.request._id }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send({ ...scholarshipResponse(result.doc), approvalId: result.approvalId })
  })

  app.post('/finance/scholarships/:id/revoke', scoped('finance.scholarship.approve'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const reason = readReason(request.body)
    if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' })
    setAuditReason(reason)
    const tenantId = request.auth!.tenantId!
    const existing = await withTenant(tenantId, (ctx) => ctx.scholarships.findOne({ _id: id }))
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!(await callerCanUseBranch(request, existing.branchId))) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })

    const result = await transact(tenantId, async (ctx) => {
      const now = new Date()
      const doc = await ctx.scholarships.findOneAndUpdate(
        { _id: id, status: 'active' },
        { $set: { status: 'revoked', revokedAt: now, revokedBy: request.auth!.sub, revokeReason: reason, updatedAt: now } },
        { returnDocument: 'after' },
      )
      if (!doc) throw new FinanceAbort('NOT_ACTIVE')
      // Off invoices with nothing paid; settled ones keep their terms.
      const carrying = await ctx.invoices.find({ 'adjustments.refId': id, status: { $ne: 'void' } }).toArray()
      const paid = await invoicePaidTotals(ctx, carrying.map((i) => i._id))
      const unpaid = carrying.filter((i) => (paid.get(i._id) ?? 0) <= 0)
      for (const invoice of unpaid) {
        await setAdjustments(ctx, invoice, (invoice.adjustments ?? []).filter((a) => a.refId !== id), {
          actorId: request.auth!.sub,
          action: 'invoice.scholarship.remove',
        })
      }
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'scholarship.revoke',
        entity: 'scholarship',
        entityId: id,
        branchId: doc.branchId,
        before: { status: 'active' },
        after: { status: 'revoked', invoicesUpdated: unpaid.length },
      })
      return { doc, invoicesUpdated: unpaid.length }
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send({ ...scholarshipResponse(result.doc), invoicesUpdated: result.invoicesUpdated })
  })
}
