import type { FastifyInstance, FastifyRequest } from 'fastify'
import { MongoServerError } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import { activeCodes, ensureDefaults } from '../settings/lookups.js'
import { readReason, setAuditReason } from '../requestContext.js'
import type { EnrollmentDoc } from '../db.js'
import {
  authenticate,
  callerCanUseBranch,
  requireActiveSubscription,
  requirePermission,
} from '../auth/guard.js'
import type { PermissionScope } from '../auth/scopes.js'
import {
  activatePending,
  bulkAssignToClass,
  cancelPending,
  enrollmentHistory,
  openEnrollment,
  transferStudent,
  withdrawStudent,
} from './service.js'
import { RolloverAbort, checkRows, commitRows, proposal, startYear } from './rollover.js'

/**
 * Enrollment history and the operations that change it — transfer, withdraw,
 * re-enroll / plan a place, activate or cancel a planned one, bulk class
 * assignment. Student creation opens the first enrollment itself
 * (students/routes.ts); this is everything after that. All mutations are
 * admin-only and branch-checked on both the source and the destination
 * branch, so a branch admin can move a student within their branches but
 * not out to one they don't hold.
 */

const transferBody = z.object({
  toClassId: z.string().min(1),
  effectiveDate: z.string().date().optional(),
  reason: z.string().max(500).nullable().default(null),
})

const withdrawBody = z.object({
  status: z.enum(['withdrawn', 'graduated']),
  effectiveDate: z.string().date().optional(),
  reason: z.string().max(500).nullable().default(null),
  /** A `withdrawalReason` code (SAMS 2.4). A withdrawal with only a
   * free-text reason is recorded as `other`, so older clients keep working. */
  reasonCode: z.string().max(64).nullable().default(null),
})

const openBody = z.object({
  classId: z.string().min(1),
  startDate: z.string().date().optional(),
  /** true: a planned place (e.g. next year); false: a re-enrollment now. */
  pending: z.boolean().default(false),
})

const activateBody = z.object({ startDate: z.string().date().optional() }).default({})

const yearsQuery = z.object({
  branchId: z.string().min(1),
  fromYearId: z.string().min(1),
  toYearId: z.string().min(1),
})

const rolloverBody = yearsQuery.extend({
  rows: z
    .array(
      z.object({
        studentId: z.string().min(1),
        action: z.enum(['promote', 'hold', 'graduate', 'withdraw']),
        toClassId: z.string().min(1).nullable().optional(),
        reasonCode: z.string().max(64).nullable().optional(),
      }),
    )
    .min(1)
    .max(2000),
  /** First day in the new class; defaults to the new year's start. */
  startDate: z.string().date().optional(),
  /** When graduations / withdrawals take effect; defaults to the old year's end. */
  closeDate: z.string().date().optional(),
})

const startBody = z.object({
  branchId: z.string().min(1),
  toYearId: z.string().min(1),
  startDate: z.string().date().optional(),
})

const bulkBody = z.object({
  studentIds: z.array(z.string().min(1)).min(1).max(500),
  toClassId: z.string().min(1),
  effectiveDate: z.string().date().optional(),
  reason: z.string().max(500).nullable().default(null),
})

function toResponse(doc: EnrollmentDoc) {
  return {
    id: doc._id,
    studentId: doc.studentId,
    branchId: doc.branchId,
    classId: doc.classId,
    academicYearId: doc.academicYearId,
    startDate: doc.startDate,
    endDate: doc.endDate,
    status: doc.status,
    supersededBy: doc.supersededBy,
    reason: doc.reason,
    reasonCode: doc.reasonCode ?? null,
    createdAt: doc.createdAt.toISOString(),
  }
}

const ERROR_STATUS: Record<string, number> = {
  NOT_ENROLLED: 409,
  SAME_CLASS: 409,
  ALREADY_ENROLLED: 409,
  UNKNOWN_CLASS: 404,
  UNKNOWN_STUDENT: 404,
  NOT_FOUND: 404,
  NO_ACADEMIC_YEAR: 409,
  YEAR_TAKEN: 409,
  NOT_PENDING: 409,
}

const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000

/** The caller must hold every branch involved (the student's current one,
 * and the enrollment's or target class's). */
async function canUseAll(request: FastifyRequest, branchIds: (string | null | undefined)[]): Promise<boolean> {
  for (const branchId of branchIds) {
    if (branchId && !(await callerCanUseBranch(request, branchId))) return false
  }
  return true
}

export function registerEnrollmentRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('enrollments.read')] }
  const scoped = (scope: PermissionScope) => ({
    preHandler: [authenticate, requireActiveSubscription, requirePermission(scope)],
  })

  app.get('/students/:studentId/enrollments', readGuard, async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const { student, rows } = await withTenant(request.auth!.tenantId!, async (ctx) => ({
      student: await ctx.students.findOne({ _id: studentId }),
      rows: await enrollmentHistory(ctx, studentId),
    }))
    // Branch isolation: this read used to skip the check every other
    // student read makes.
    if (student && !(await callerCanUseBranch(request, student.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    return reply.send({ enrollments: rows.map(toResponse) })
  })

  /** Re-enroll now, or plan a future place (SAMS 2.4). */
  app.post('/students/:studentId/enrollments', scoped('enrollments.assign'), async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const parsed = openBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    const pre = await withTenant(tenantId, async (ctx) => ({
      student: await ctx.students.findOne({ _id: studentId }),
      target: await ctx.classes.findOne({ _id: parsed.data.classId }),
    }))
    if (!(await canUseAll(request, [pre.student?.branchId, pre.target?.branchId]))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    try {
      const result = await withTenant(tenantId, (ctx) =>
        openEnrollment(ctx, tenantId, { studentId, ...parsed.data, actorId: request.auth!.sub }),
      )
      if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
      return reply.code(201).send({ enrollment: toResponse(result.enrollment) })
    } catch (error) {
      // The per-year index caught a concurrent request for the same year.
      if (isDuplicateKey(error)) return reply.code(409).send({ error: 'YEAR_TAKEN' })
      throw error
    }
  })

  /** Pending rows: start one, or call it off. */
  const pendingRow = async (request: FastifyRequest, id: string) => {
    const tenantId = request.auth!.tenantId!
    const found = await withTenant(tenantId, async (ctx) => {
      const row = await ctx.enrollments.findOne({ _id: id })
      const student = row ? await ctx.students.findOne({ _id: row.studentId }) : null
      return { row, student }
    })
    if (!found.row) return { status: 404, error: 'NOT_FOUND' }
    if (!(await canUseAll(request, [found.row.branchId, found.student?.branchId]))) {
      return { status: 403, error: 'BRANCH_FORBIDDEN' }
    }
    return null
  }

  app.post('/enrollments/:id/activate', scoped('enrollments.assign'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = activateBody.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const denied = await pendingRow(request, id)
    if (denied) return reply.code(denied.status).send({ error: denied.error })
    const result = await withTenant(request.auth!.tenantId!, (ctx) =>
      activatePending(ctx, { enrollmentId: id, startDate: parsed.data.startDate, actorId: request.auth!.sub }),
    ).catch((error: unknown) => {
      if (isDuplicateKey(error)) return { ok: false as const, error: 'ALREADY_ENROLLED' as const }
      throw error
    })
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.send({ enrollment: toResponse(result.enrollment) })
  })

  app.post('/enrollments/:id/cancel', scoped('enrollments.assign'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const reason = readReason(request.body)
    if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' })
    setAuditReason(reason)
    const denied = await pendingRow(request, id)
    if (denied) return reply.code(denied.status).send({ error: denied.error })
    const result = await withTenant(request.auth!.tenantId!, (ctx) =>
      cancelPending(ctx, { enrollmentId: id, reason, actorId: request.auth!.sub }),
    )
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.send({ enrollment: toResponse(result.enrollment) })
  })

  app.post('/students/:studentId/transfer', scoped('enrollments.transfer'), async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const parsed = transferBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const tenantId = request.auth!.tenantId!
    // The caller must hold both the branch the student is leaving and the one
    // the target class is in — checked before the write, then again inside.
    const pre = await withTenant(tenantId, async (ctx) => {
      const current = await ctx.enrollments.findOne({ studentId, status: 'active' })
      const target = await ctx.classes.findOne({ _id: parsed.data.toClassId })
      return { fromBranch: current?.branchId ?? null, toBranch: target?.branchId ?? null }
    })
    for (const branchId of [pre.fromBranch, pre.toBranch]) {
      if (branchId && !(await callerCanUseBranch(request, branchId))) {
        return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
      }
    }

    const result = await withTenant(tenantId, (ctx) =>
      transferStudent(ctx, tenantId, {
        studentId,
        toClassId: parsed.data.toClassId,
        effectiveDate: parsed.data.effectiveDate,
        reason: parsed.data.reason,
        actorId: request.auth!.sub,
      }),
    )
    if (!result.ok) {
      return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    }
    return reply.send({ from: toResponse(result.from), to: toResponse(result.to) })
  })

  app.post('/students/:studentId/withdraw', scoped('enrollments.withdraw'), async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const parsed = withdrawBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    // A withdrawal must say why (SAMS 1.12): a reason code from the
    // settings list (SAMS 2.4), a note, or both. Only a note means "other".
    let reasonCode: string | null = null
    if (parsed.data.status === 'withdrawn') {
      const note = readReason(request.body)
      reasonCode = parsed.data.reasonCode ?? (note ? 'other' : null)
      if (!reasonCode) return reply.code(400).send({ error: 'REASON_REQUIRED' })
      await ensureDefaults(tenantId, 'withdrawalReason')
      const valid = await withTenant(tenantId, async (ctx) => (await activeCodes(ctx, 'withdrawalReason')).has(reasonCode!))
      if (!valid) return reply.code(400).send({ error: 'INVALID_REASON_CODE' })
      setAuditReason(note ?? reasonCode)
    }

    const current = await withTenant(tenantId, (ctx) =>
      ctx.enrollments.findOne({ studentId, status: 'active' }),
    )
    if (current && !(await callerCanUseBranch(request, current.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const result = await withTenant(tenantId, (ctx) =>
      withdrawStudent(ctx, {
        studentId,
        status: parsed.data.status,
        effectiveDate: parsed.data.effectiveDate,
        reason: parsed.data.reason,
        reasonCode,
        actorId: request.auth!.sub,
      }),
    )
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.send({ enrollment: toResponse(result.enrollment) })
  })

  // ------------------------------------------------ year end (SAMS 2.6) --

  app.get('/enrollments/rollover', scoped('enrollments.assign'), async (request, reply) => {
    const parsed = yearsQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    const result = await withTenant(request.auth!.tenantId!, (ctx) => proposal(ctx, parsed.data))
    return reply.send({
      rows: result.rows,
      toClasses: result.toClasses.map((c) => ({
        id: c._id,
        gradeLevel: c.gradeLevel,
        name: c.name,
        label: `${c.gradeLevel} ${c.name}`.trim(),
      })),
    })
  })

  /** Resolves the years and checks every row; shared by preview and commit. */
  type Prepared =
    | { status: number; error: string }
    | {
        body: z.infer<typeof rolloverBody>
        checks: Awaited<ReturnType<typeof checkRows>>
        startDate: string
        closeDate: string
      }
  const prepare = async (request: FastifyRequest): Promise<Prepared> => {
    const parsed = rolloverBody.safeParse(request.body)
    if (!parsed.success) return { status: 400, error: 'INVALID_BODY' } as const
    const body = parsed.data
    if (body.fromYearId === body.toYearId) return { status: 400, error: 'SAME_YEAR' } as const
    if (!(await callerCanUseBranch(request, body.branchId))) return { status: 403, error: 'BRANCH_FORBIDDEN' } as const
    const tenantId = request.auth!.tenantId!
    await ensureDefaults(tenantId, 'withdrawalReason')
    return withTenant(tenantId, async (ctx) => {
      const [from, to] = await Promise.all([
        ctx.academicYears.findOne({ _id: body.fromYearId }),
        ctx.academicYears.findOne({ _id: body.toYearId }),
      ])
      if (!from || !to) return { status: 404, error: 'UNKNOWN_ACADEMIC_YEAR' } as const
      const reasonCodes = await activeCodes(ctx, 'withdrawalReason')
      const checks = await checkRows(ctx, { ...body, reasonCodes })
      return {
        body,
        checks,
        startDate: body.startDate ?? to.startDate,
        closeDate: body.closeDate ?? from.endDate,
      }
    })
  }

  const summarize = (rows: { action: string }[]) =>
    rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.action]: (acc[r.action] ?? 0) + 1 }), {})

  app.post('/enrollments/rollover/preview', scoped('enrollments.assign'), async (request, reply) => {
    const prepared = await prepare(request)
    if ('error' in prepared) return reply.code(prepared.status).send({ error: prepared.error })
    return reply.send({
      ok: prepared.checks.every((c) => c.ok),
      rows: prepared.checks,
      summary: summarize(prepared.body.rows),
      startDate: prepared.startDate,
      closeDate: prepared.closeDate,
    })
  })

  app.post('/enrollments/rollover/commit', scoped('enrollments.assign'), async (request, reply) => {
    const prepared = await prepare(request)
    if ('error' in prepared) return reply.code(prepared.status).send({ error: prepared.error })
    if (!prepared.checks.every((c) => c.ok)) {
      return reply.code(409).send({ error: 'ROWS_INVALID', rows: prepared.checks.filter((c) => !c.ok) })
    }
    try {
      const counts = await withTenant(request.auth!.tenantId!, (ctx) =>
        commitRows(ctx, request.auth!.tenantId!, {
          ...prepared.body,
          rows: prepared.body.rows,
          startDate: prepared.startDate,
          closeDate: prepared.closeDate,
          actorId: request.auth!.sub,
        }),
      )
      return reply.send({ ok: true, summary: counts })
    } catch (error) {
      if (error instanceof RolloverAbort) {
        return reply.code(409).send({ error: 'ROWS_INVALID', rows: [{ studentId: error.studentId, ok: false, error: error.code }] })
      }
      if (isDuplicateKey(error)) return reply.code(409).send({ error: 'YEAR_TAKEN' })
      throw error
    }
  })

  /** Every planned place in the new year starts; old enrollments complete. */
  app.post('/enrollments/rollover/start', scoped('enrollments.assign'), async (request, reply) => {
    const parsed = startBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    try {
      const result = await withTenant(request.auth!.tenantId!, (ctx) =>
        startYear(ctx, { ...parsed.data, actorId: request.auth!.sub }),
      )
      return reply.send(result)
    } catch (error) {
      if (error instanceof RolloverAbort) {
        return reply.code(409).send({ error: error.code, studentId: error.studentId })
      }
      throw error
    }
  })

  app.post('/enrollments/bulk-assign', scoped('enrollments.assign'), async (request, reply) => {
    const parsed = bulkBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const tenantId = request.auth!.tenantId!
    const target = await withTenant(tenantId, (ctx) =>
      ctx.classes.findOne({ _id: parsed.data.toClassId }),
    )
    if (!target) return reply.code(404).send({ error: 'UNKNOWN_CLASS' })
    if (!(await callerCanUseBranch(request, target.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const rows = await withTenant(tenantId, (ctx) =>
      bulkAssignToClass(ctx, tenantId, {
        studentIds: parsed.data.studentIds,
        toClassId: parsed.data.toClassId,
        effectiveDate: parsed.data.effectiveDate,
        reason: parsed.data.reason,
        actorId: request.auth!.sub,
      }),
    )
    const summary = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1
      return acc
    }, {})
    return reply.send({ summary, rows })
  })
}
