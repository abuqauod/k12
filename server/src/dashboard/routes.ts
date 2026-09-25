import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import {
  authenticate,
  callerBranchIds,
  callerHasPermission,
  requireActiveSubscription,
  requirePermission,
} from '../auth/guard.js'
import { parentsHiddenFromBranches } from '../parents/service.js'
import { toDecideFilter } from '../approvals/routes.js'

/**
 * Dashboard summary (SAMS 1.12): counts computed server-side from the same
 * collections every module uses — nothing dashboard-specific is stored.
 * Each section appears only when the caller holds its read scope, and every
 * count stays inside the caller's branches (or the one branch asked for).
 */

const query = z.object({ branchId: z.string().optional() })

export function registerDashboardRoutes(app: FastifyInstance): void {
  const guard = { preHandler: [authenticate, requireActiveSubscription, requirePermission('dashboard.read')] }

  app.get('/dashboard/summary', guard, async (request, reply) => {
    const parsed = query.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const allowed = await callerBranchIds(request)
    const { branchId } = parsed.data
    if (branchId && allowed !== null && !allowed.includes(branchId)) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    // null = every branch (a tenant-wide caller who asked for no branch).
    const scope = branchId ? [branchId] : allowed
    const branchFilter = scope === null ? {} : { branchId: { $in: scope } }

    const can = {
      parents: await callerHasPermission(request, 'parents.read'),
      enrollments: await callerHasPermission(request, 'enrollments.read'),
    }
    const toDecide = await toDecideFilter(request)

    const summary = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const result: Record<string, unknown> = {}

      if (can.parents) {
        const hidden = scope === null ? new Set<string>() : await parentsHiddenFromBranches(ctx, scope)
        const parents = (await ctx.parents.find({ status: { $ne: 'archived' } }).toArray()).filter(
          (p) => !hidden.has(p._id),
        )
        const links = await ctx.parentStudentLinks.find({ active: true }).toArray()
        const inScope =
          scope === null
            ? null
            : new Set(
                (
                  await ctx.students.find({ _id: { $in: links.map((l) => l.studentId) }, ...branchFilter }).toArray()
                ).map((s) => s._id),
              )
        const children = new Map<string, number>()
        const linked = new Set<string>()
        for (const link of links) {
          linked.add(link.parentId)
          if (inScope && !inScope.has(link.studentId)) continue
          children.set(link.parentId, (children.get(link.parentId) ?? 0) + 1)
        }
        result.parents = {
          total: parents.length,
          multiChild: parents.filter((p) => (children.get(p._id) ?? 0) >= 2).length,
          // Incomplete: not linked to any child yet, or no national ID.
          incomplete: parents.filter((p) => !linked.has(p._id) || !p.nationalId).length,
        }
      }

      if (can.enrollments) {
        const year = await ctx.academicYears.findOne({ current: true })
        const inYear = year ? { academicYearId: year._id, ...branchFilter } : null
        result.enrollments = inYear
          ? {
              academicYear: year!.name,
              active: await ctx.enrollments.countDocuments({ ...inYear, status: 'active' }),
              withdrawals: await ctx.enrollments.countDocuments({ ...inYear, status: 'withdrawn' }),
              transfers: await ctx.enrollments.countDocuments({ ...inYear, status: 'transferred' }),
            }
          : { academicYear: null, active: 0, withdrawals: 0, transfers: 0 }
      }

      // Only when the caller can decide at least one approval type.
      const decidable = (toDecide.type as { $in: string[] }).$in
      if (decidable.length > 0) {
        result.approvals = {
          pendingToDecide: await ctx.approvalRequests.countDocuments({
            $and: [toDecide, { status: 'pending' }, ...(branchId ? [{ branchId }] : [])],
          }),
        }
      }
      return result
    })
    return reply.send(summary)
  })
}
