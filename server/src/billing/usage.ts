import { withTenant, withoutTenant } from '../db.js'
import { limitsOf, modulesOf, type Module } from './plans.js'

/**
 * SAMS 13.4 — what a school uses, as billed and as limited: students
 * enrolled, campuses, staff, and SMS sent this month.
 */
export interface Usage {
  students: number
  branches: number
  staff: number
  smsThisMonth: number
}

export async function usageOf(tenantId: string, now = new Date()): Promise<Usage> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const [students, branches, smsThisMonth] = await withTenant(tenantId, (ctx) =>
    Promise.all([
      ctx.students.countDocuments({ status: 'enrolled' }),
      ctx.branches.countDocuments({ active: true }),
      ctx.notificationJobs.countDocuments({ channel: 'sms', status: 'sent', createdAt: { $gte: monthStart } }),
    ]),
  )
  const staff = await withoutTenant((db) => db.memberships.countDocuments({ tenantId, roleKey: { $ne: 'parent' } }))
  return { students, branches, staff, smsThisMonth }
}

/**
 * Whether `adding` more enrolled students fit the school's limit; the
 * refusal carries the numbers for the message. Checked before the write, so
 * two creates racing at the very limit can overshoot it by one — a limit
 * that is billed for, not a security boundary.
 */
export async function studentLimitRefusal(
  tenantId: string,
  adding = 1,
): Promise<{ error: 'PLAN_LIMIT_STUDENTS'; limit: number; enrolled: number } | null> {
  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
  if (!tenant) return null
  const { students: limit } = limitsOf(tenant)
  if (limit === null) return null
  const enrolled = await withTenant(tenantId, (ctx) => ctx.students.countDocuments({ status: 'enrolled' }))
  return enrolled + adding > limit ? { error: 'PLAN_LIMIT_STUDENTS', limit, enrolled } : null
}

export async function branchLimitRefusal(
  tenantId: string,
): Promise<{ error: 'PLAN_LIMIT_BRANCHES'; limit: number; active: number } | null> {
  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
  if (!tenant) return null
  const { branches: limit } = limitsOf(tenant)
  if (limit === null) return null
  const active = await withTenant(tenantId, (ctx) => ctx.branches.countDocuments({ active: true }))
  return active + 1 > limit ? { error: 'PLAN_LIMIT_BRANCHES', limit, active } : null
}

/** Whether the school's plan includes `module` — for work outside a route
 * (sweeps, what a page offers). */
export async function tenantHasModule(tenantId: string, module: Module): Promise<boolean> {
  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
  return tenant ? modulesOf(tenant).has(module) : false
}
