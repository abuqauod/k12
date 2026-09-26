import type { FastifyInstance } from 'fastify'
import { withTenant, withoutTenant } from '../db.js'
import { config } from '../config.js'
import { scoped } from '../records.js'

/**
 * SAMS 12 — found in the pilot: a new school opened on an empty dashboard
 * with nothing to say where to begin. The getting-started checklist: each
 * step is worked out from the school's data (never ticked by hand), with
 * the page that does it.
 */

export interface OnboardingStep {
  key: string
  done: boolean
  /** Where in the app the step is done. */
  link: string
  /** A count to show, where it helps (e.g. students imported). */
  count?: number
}

export function registerOnboardingRoutes(app: FastifyInstance): void {
  app.get('/onboarding', scoped('settings.read'), async (request, reply) => {
    const tenantId = request.auth!.tenantId!
    const steps = await withTenant(tenantId, async (ctx) => {
      const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
      const year = await ctx.academicYears.findOne({ current: true })
      const [classes, fees, students, invoices, members, gateway] = await Promise.all([
        ctx.classes.countDocuments({ active: true }),
        ctx.feeStructures.countDocuments({}),
        ctx.students.countDocuments({ status: 'enrolled' }),
        ctx.invoices.countDocuments({}),
        withoutTenant((db) => db.memberships.countDocuments({ tenantId })),
        ctx.paymentSettings.findOne({ _id: tenantId }),
      ])
      const out: OnboardingStep[] = [
        { key: 'profile', done: Boolean(tenant?.profile?.phone || tenant?.profile?.address), link: '/settings/organization' },
        { key: 'year', done: Boolean(year && year.terms.length > 0), link: '/settings/academic-years' },
        { key: 'classes', done: classes > 0, link: '/classes', count: classes },
        { key: 'fees', done: fees > 0, link: '/finance', count: fees },
        { key: 'students', done: students > 0, link: '/settings/import', count: students },
        { key: 'invoices', done: invoices > 0, link: '/finance', count: invoices },
        { key: 'team', done: members > 1, link: '/settings/team', count: members },
        { key: 'payments', done: Boolean(gateway?.enabled && gateway.provider), link: '/settings/payments' },
      ]
      return out
    })
    return reply.send({
      steps,
      done: steps.filter((s) => s.done).length,
      total: steps.length,
      // The operator's side, shown so a school knows why emails don't arrive.
      emailConfigured: Boolean(config.smtp),
    })
  })
}
