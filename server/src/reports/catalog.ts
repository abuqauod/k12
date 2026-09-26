import { withTenant } from '../db.js'
import type { ReportFilters } from '../db.js'
import { reportBranches, type Lang, type ReportViewer } from './common.js'
import type { ReportDefinition, ReportTable } from './types.js'
import { studentReports } from './defs/students.js'
import { attendanceReports } from './defs/attendance.js'
import { financeReports } from './defs/finance.js'
import { hrReports } from './defs/hr.js'

/**
 * SAMS 7.2: the report catalog. Every report is a definition here: which
 * scopes it needs, which filters it takes, and how it builds its table.
 * A viewer sees only the reports whose scopes they hold, and a run covers
 * only their branches, whether it comes from a request or from a
 * scheduled export running as its owner.
 */

export const REPORTS: ReportDefinition[] = [...studentReports, ...attendanceReports, ...financeReports, ...hrReports]
const BY_KEY = new Map(REPORTS.map((r) => [r.key, r]))

export const findReport = (key: string) => BY_KEY.get(key) ?? null

export const canRun = (viewer: Pick<ReportViewer, 'scopes'>, def: ReportDefinition) => def.scopes.every((s) => viewer.scopes.has(s))

export function catalogFor(viewer: ReportViewer, lang: Lang) {
  return REPORTS.filter((r) => canRun(viewer, r)).map((r) => ({
    key: r.key,
    category: r.category,
    title: r.title[lang],
    description: r.description[lang],
    filters: r.filters,
    statuses: (r.statuses ?? []).map((s) => ({ value: s.value, label: s.label[lang] })),
  }))
}

/** A cap on one table, so a runaway filter can't build a file nobody can open. */
export const MAX_ROWS = 20_000
/** The longest date range one run may cover. */
const MAX_RANGE_DAYS = 800

export interface RunRequest {
  key: string
  filters: ReportFilters
  from: string | null
  to: string | null
  lang: Lang
  today: string
}

export interface RunResult {
  definition: ReportDefinition
  title: string
  branchIds: string[] | null
  /** The filters the run actually used (those the report takes). */
  applied: ReportFilters
  from: string | null
  to: string | null
  table: ReportTable
  truncated: boolean
}

export type RunFailure = { error: 'UNKNOWN_REPORT' | 'FORBIDDEN' | 'BRANCH_FORBIDDEN' | 'DATES_REQUIRED' | 'DATES_OUT_OF_ORDER' | 'RANGE_TOO_LONG' | 'INVALID_STATUS' }

export async function runReport(viewer: ReportViewer, req: RunRequest): Promise<RunResult | RunFailure> {
  const def = findReport(req.key)
  if (!def) return { error: 'UNKNOWN_REPORT' }
  if (!canRun(viewer, def)) return { error: 'FORBIDDEN' }
  const branchIds = reportBranches(viewer, def.filters.includes('branch') ? req.filters.branchId : null)
  if (branchIds === false) return { error: 'BRANCH_FORBIDDEN' }

  const takesDates = def.filters.includes('dates')
  if (takesDates) {
    if (!req.from || !req.to) return { error: 'DATES_REQUIRED' }
    if (req.from > req.to) return { error: 'DATES_OUT_OF_ORDER' }
    if ((Date.parse(req.to) - Date.parse(req.from)) / 86_400_000 > MAX_RANGE_DAYS) return { error: 'RANGE_TOO_LONG' }
  }
  // Keep only the filters this report takes, so a schedule or a URL can't
  // narrow it by something its title doesn't say.
  const f = req.filters
  const takes = (k: string) => def.filters.includes(k as never)
  const filters: ReportFilters = {
    branchId: takes('branch') ? f.branchId : null,
    academicYearId: takes('year') ? f.academicYearId : null,
    gradeLevel: takes('grade') ? f.gradeLevel : null,
    classId: takes('class') ? f.classId : null,
    status: takes('status') ? f.status : null,
  }
  if (filters.status && !(def.statuses ?? []).some((s) => s.value === filters.status)) return { error: 'INVALID_STATUS' }
  const from = takesDates ? req.from : null
  const to = takesDates ? req.to : null

  const table = await withTenant(viewer.tenantId, (ctx) =>
    def.run(ctx, { branchIds, filters, from, to, today: req.today, lang: req.lang }),
  )
  const truncated = table.rows.length > MAX_ROWS
  if (truncated) table.rows = table.rows.slice(0, MAX_ROWS)
  return { definition: def, title: def.title[req.lang], branchIds, applied: filters, from, to, table, truncated }
}

export const isRunFailure = (r: RunResult | RunFailure): r is RunFailure => 'error' in r
