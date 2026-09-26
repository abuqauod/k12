import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import { branchFilter, scoped, todayIso } from '../records.js'
import { hrSummary } from '../reports/hr.js'

/**
 * SAMS 4.6: one HR summary for a branch (or every branch the caller may
 * see) and a date range. Computed by the shared reporting query
 * (reports/hr.ts, SAMS 7.1).
 */

const query = z
  .object({ branchId: z.string().optional(), from: z.string().date(), to: z.string().date() })
  .refine((q) => q.from <= q.to)

export function registerHrReportRoutes(app: FastifyInstance): void {
  app.get('/hr/reports/summary', scoped('reports.hr'), async (request, reply) => {
    const parsed = query.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { from, to } = parsed.data
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const summary = await withTenant(request.auth!.tenantId!, (ctx) =>
      hrSummary(ctx, { branchIds: branches.branchIds, from, to, today: todayIso() }),
    )
    return reply.send(summary)
  })
}
