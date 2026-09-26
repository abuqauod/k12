import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import { financeSummary } from '../reports/finance.js'
import { branchFilter, scoped, todayIso } from './common.js'

/**
 * SAMS 3.6: one finance summary for a branch (or every branch the caller
 * may see) and a date range. The figures come from the shared reporting
 * queries (reports/finance.ts, SAMS 7.1), the same ones the report catalog
 * and the dashboard use.
 */

const query = z
  .object({
    branchId: z.string().optional(),
    from: z.string().date(),
    to: z.string().date(),
    academicYearId: z.string().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from after to' })

export function registerFinanceReportRoutes(app: FastifyInstance): void {
  app.get('/finance/reports/summary', scoped('reports.finance'), async (request, reply) => {
    const parsed = query.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { from, to, academicYearId } = parsed.data
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const summary = await withTenant(request.auth!.tenantId!, (ctx) =>
      financeSummary(ctx, { branchIds: branches.branchIds, academicYearId: academicYearId ?? null, from, to, today: todayIso() }),
    )
    return reply.send({ ...summary, branchId: parsed.data.branchId ?? null })
  })
}
