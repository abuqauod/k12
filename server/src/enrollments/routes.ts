import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { EnrollmentDoc } from '../db.js'
import {
  authenticate,
  callerCanUseBranch,
  requireActiveSubscription,
  requireRole,
} from '../auth/guard.js'
import {
  bulkAssignToClass,
  enrollmentHistory,
  transferStudent,
  withdrawStudent,
} from './service.js'

/**
 * Enrollment history and the operations that change it — transfer, withdraw,
 * bulk class assignment. Student creation opens the first enrollment itself
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
    createdAt: doc.createdAt.toISOString(),
  }
}

const ERROR_STATUS: Record<string, number> = {
  NOT_ENROLLED: 409,
  SAME_CLASS: 409,
  ALREADY_ENROLLED: 409,
  UNKNOWN_CLASS: 404,
  NO_ACADEMIC_YEAR: 409,
}

export function registerEnrollmentRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription] }
  const writeGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('admin')] }

  app.get('/students/:studentId/enrollments', readGuard, async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const rows = await withTenant(request.auth!.tenantId!, (ctx) => enrollmentHistory(ctx, studentId))
    return reply.send({ enrollments: rows.map(toResponse) })
  })

  app.post('/students/:studentId/transfer', writeGuard, async (request, reply) => {
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

  app.post('/students/:studentId/withdraw', writeGuard, async (request, reply) => {
    const { studentId } = request.params as { studentId: string }
    const parsed = withdrawBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })

    const tenantId = request.auth!.tenantId!
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
        actorId: request.auth!.sub,
      }),
    )
    if (!result.ok) return reply.code(ERROR_STATUS[result.error] ?? 400).send({ error: result.error })
    return reply.send({ enrollment: toResponse(result.enrollment) })
  })

  app.post('/enrollments/bulk-assign', writeGuard, async (request, reply) => {
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
