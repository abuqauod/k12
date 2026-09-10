import type { FastifyInstance } from 'fastify'
import { authenticate, callerBranchIds, requireActiveSubscription } from '../auth/guard.js'
import { branchToResponse, listBranchesForTenant } from './service.js'

/**
 * The tenant-facing branch surface is READ ONLY. A branch's identity (name,
 * code, address, timezone, active) is provisioned by the vendor through the
 * platform console (`/admin/tenants/:id/branches`); a school's own users
 * only need to see the list — for the branch switcher, staff assignment,
 * class creation and attendance. Everything *operational* about a branch
 * (school calendar, absence-notification settings) stays tenant self-service
 * on its own routes.
 */
export function registerBranchRoutes(app: FastifyInstance): void {
  const readGuard = { preHandler: [authenticate, requireActiveSubscription] }

  app.get('/branches', readGuard, async (request, reply) => {
    const allowed = await callerBranchIds(request)
    const branches = await listBranchesForTenant(request.auth!.tenantId!)
    const visible = allowed === null ? branches : branches.filter((b) => allowed.includes(b._id))
    return reply.send({ branches: visible.map(branchToResponse) })
  })
}
