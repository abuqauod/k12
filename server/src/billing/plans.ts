import type { TenantDoc } from '../db.js'

/**
 * SAMS 13.1 — what a school has bought. A plan is a set of modules on top of
 * the core product and a few limits; the price list is per currency, per
 * active student per year, with a minimum (see docs/saas-business-model.md).
 *
 * Money is in minor units (1/100), like every other amount in the system.
 */

export const CURRENCIES = ['JOD', 'USD', 'SAR', 'AED'] as const
export type Currency = (typeof CURRENCIES)[number]

export const PLAN_KEYS = ['essentials', 'professional', 'enterprise', 'trial'] as const
export type PlanKey = (typeof PLAN_KEYS)[number]

/**
 * The modules sold on top of the core (students, families, classes, years,
 * timetable, attendance, fees and invoices, the parent portal, email and
 * in-app notices, reports on demand, imports).
 */
export const MODULES = [
  'grades',
  'admissions',
  'hr',
  'transport',
  'library',
  'wellbeing',
  'idCards',
  'onlinePayments',
  'scheduledReports',
  'operations',
  'canteen',
] as const
export type Module = (typeof MODULES)[number]

export interface PlanLimits {
  /** Enrolled students; null = no limit. */
  students: number | null
  /** Active campuses; null = no limit. */
  branches: number | null
  /** SMS a month, per enrolled student; null = no SMS allowance cap. */
  smsPerStudent: number | null
}

export interface PlanDef {
  key: PlanKey
  modules: readonly Module[]
  limits: PlanLimits
  /** Per student per year, and the yearly minimum, by currency. */
  price: Record<Currency, { perStudentYear: number; minimumYear: number }> | null
  /** Offered on the public price list. */
  listed: boolean
}

const PROFESSIONAL: readonly Module[] = [
  'grades',
  'admissions',
  'hr',
  'transport',
  'library',
  'wellbeing',
  'idCards',
  'onlinePayments',
  'scheduledReports',
]

export const PLANS: Record<PlanKey, PlanDef> = {
  essentials: {
    key: 'essentials',
    modules: [],
    limits: { students: null, branches: 1, smsPerStudent: 0 },
    price: {
      USD: { perStudentYear: 1200, minimumYear: 120_000 },
      JOD: { perStudentYear: 850, minimumYear: 85_000 },
      SAR: { perStudentYear: 4500, minimumYear: 450_000 },
      AED: { perStudentYear: 4500, minimumYear: 450_000 },
    },
    listed: true,
  },
  professional: {
    key: 'professional',
    modules: PROFESSIONAL,
    limits: { students: null, branches: 3, smsPerStudent: 2 },
    price: {
      USD: { perStudentYear: 2000, minimumYear: 300_000 },
      JOD: { perStudentYear: 1400, minimumYear: 210_000 },
      SAR: { perStudentYear: 7500, minimumYear: 1_125_000 },
      AED: { perStudentYear: 7500, minimumYear: 1_125_000 },
    },
    listed: true,
  },
  enterprise: {
    key: 'enterprise',
    modules: MODULES,
    limits: { students: null, branches: null, smsPerStudent: 4 },
    price: {
      USD: { perStudentYear: 3000, minimumYear: 750_000 },
      JOD: { perStudentYear: 2100, minimumYear: 525_000 },
      SAR: { perStudentYear: 11_000, minimumYear: 2_750_000 },
      AED: { perStudentYear: 11_000, minimumYear: 2_750_000 },
    },
    listed: true,
  },
  // Everything, for a month, for a school that signed itself up.
  trial: {
    key: 'trial',
    modules: MODULES,
    limits: { students: 150, branches: 1, smsPerStudent: 0 },
    price: null,
    listed: false,
  },
}

export const TRIAL_DAYS = 30
/** A month-to-month term costs this much more than paying for the year. */
export const MONTHLY_UPLIFT = 0.2

/** Anything else on file (schools opened before plans existed, 'test'):
 * everything on, no limits — nothing a school had is taken away. */
export function planOf(tenant: Pick<TenantDoc, 'plan'>): PlanDef | null {
  return (PLANS as Record<string, PlanDef>)[tenant.plan] ?? null
}

/** The modules a school has: its plan's, plus any add-ons sold separately. */
export function modulesOf(tenant: Pick<TenantDoc, 'plan' | 'addons'>): ReadonlySet<Module> {
  const plan = planOf(tenant)
  if (!plan) return new Set(MODULES)
  return new Set([...plan.modules, ...((tenant.addons ?? []).filter((m) => (MODULES as readonly string[]).includes(m)) as Module[])])
}

/** The plan's limits, with any the vendor set for this school on top. */
export function limitsOf(tenant: Pick<TenantDoc, 'plan' | 'limits'>): PlanLimits {
  const plan = planOf(tenant)
  const base: PlanLimits = plan?.limits ?? { students: null, branches: null, smsPerStudent: null }
  return { ...base, ...(tenant.limits ?? {}) }
}

/**
 * Which module a route belongs to, from its pattern (as registered, without
 * the deployment's prefix). Routes of the core return null.
 */
const ROUTE_MODULES: [RegExp, Module][] = [
  [/^\/grades(\/|$)/, 'grades'],
  [/^\/portal\/children\/:id\/report-cards/, 'grades'],
  [/^\/admissions(\/|$)/, 'admissions'],
  [/^\/hr(\/|$)/, 'hr'],
  [/^\/transport(\/|$)/, 'transport'],
  [/^\/ops\/transport(\/|$)/, 'transport'],
  [/^\/branches\/:branchId\/transport-settings/, 'transport'],
  [/^\/ops\/library(\/|$)/, 'library'],
  [/^\/(discipline|clinic)(\/|$)/, 'wellbeing'],
  [/^\/id-cards(\/|$)/, 'idCards'],
  [/^\/settings\/payments(\/|$)/, 'onlinePayments'],
  [/^\/finance\/online-payments/, 'onlinePayments'],
  [/^\/portal\/children\/:id\/pay$/, 'onlinePayments'],
  [/^\/portal\/payments\//, 'onlinePayments'],
  [/^\/reports\/(schedules|runs|recipients)/, 'scheduledReports'],
  [/^\/ops\//, 'operations'],
  [/^\/canteen(\/|$)/, 'canteen'],
  [/^\/portal\/children\/:id\/wallet/, 'canteen'],
]

export function moduleOfRoute(pattern: string): Module | null {
  for (const [re, module] of ROUTE_MODULES) if (re.test(pattern)) return module
  return null
}

/** What a year costs for `students` on `plan`, in `currency`'s minor units. */
export function yearlyPrice(plan: PlanDef, currency: Currency, students: number): number {
  if (!plan.price) return 0
  const p = plan.price[currency]
  return Math.max(p.minimumYear, p.perStudentYear * students)
}

/** One term's price: a year, or a month at the monthly uplift. */
export function termPrice(plan: PlanDef, currency: Currency, students: number, term: 'year' | 'month'): number {
  const year = yearlyPrice(plan, currency, students)
  return term === 'year' ? year : Math.round((year * (1 + MONTHLY_UPLIFT)) / 12)
}

/** After the grace period a school can still read (and export) its data
 * for this long; only then is it locked out. */
export const READ_ONLY_DAYS = 60

export type SubscriptionState = 'active' | 'grace' | 'readOnly' | 'locked' | 'inactive'

/**
 * Where a school stands: paid up; lapsed but inside its grace days;
 * past them, reading only; past that too; or suspended/cancelled by the
 * vendor.
 */
export function subscriptionState(
  tenant: Pick<TenantDoc, 'status' | 'validUntil' | 'graceDays'>,
  now = new Date(),
): { state: SubscriptionState; graceEnds: string | null; readOnlyUntil: string | null } {
  if (tenant.status !== 'active') return { state: 'inactive', graceEnds: null, readOnlyUntil: null }
  if (!tenant.validUntil) return { state: 'active', graceEnds: null, readOnlyUntil: null }
  const day = (offset: number) => {
    const d = new Date(`${tenant.validUntil}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + offset)
    return d
  }
  // Paid through the whole of validUntil; grace days follow it.
  const graceEnd = day(1 + tenant.graceDays)
  const readOnlyEnd = day(1 + tenant.graceDays + READ_ONLY_DAYS)
  const iso = (d: Date) => new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10)
  const out = { graceEnds: iso(graceEnd), readOnlyUntil: iso(readOnlyEnd) }
  if (now < day(1)) return { state: 'active', ...out }
  if (now < graceEnd) return { state: 'grace', ...out }
  if (now < readOnlyEnd) return { state: 'readOnly', ...out }
  return { state: 'locked', ...out }
}
