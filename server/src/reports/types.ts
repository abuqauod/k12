import type { ReportFilters, TenantContext } from '../db.js'
import type { PermissionScope } from '../auth/scopes.js'
import type { Lang, Text } from './common.js'

/**
 * SAMS 7.2: a catalog report is a table — typed columns, rows, and the
 * totals row — so one set of exporters (CSV, Excel, print) serves them
 * all. Money is in minor units, percentages are fractions (0.95), dates
 * are ISO days; text is already in the report's language.
 */

export type ColumnType = 'text' | 'number' | 'money' | 'date' | 'percent'
export type Cell = string | number | null

export interface Column {
  key: string
  label: Text
  type: ColumnType
}

export interface ReportTable {
  columns: Column[]
  rows: Record<string, Cell>[]
  /** Summed columns (and the label cell), or null for a list with nothing to add up. */
  totals: Record<string, Cell> | null
}

export type FilterKey = 'branch' | 'year' | 'dates' | 'grade' | 'class' | 'status'
export type ReportCategory = 'students' | 'attendance' | 'admissions' | 'finance' | 'hr' | 'operations'

export interface RunInput {
  /** The branches the run covers (null = every branch), already checked
   * against the viewer. */
  branchIds: string[] | null
  filters: ReportFilters
  /** Set for a report with the `dates` filter. */
  from: string | null
  to: string | null
  today: string
  lang: Lang
}

export interface ReportDefinition {
  key: string
  category: ReportCategory
  title: Text
  description: Text
  /** All of these, or the report is not in the viewer's catalog. */
  scopes: PermissionScope[]
  filters: FilterKey[]
  /** The choices for the `status` filter. */
  statuses?: { value: string; label: Text }[]
  run(ctx: TenantContext, input: RunInput): Promise<ReportTable>
}

/** Adds the summed columns up into a totals row, labelled in `labelKey`. */
export function sumRows(
  rows: Record<string, Cell>[],
  keys: string[],
  labelKey: string,
  label: string,
): Record<string, Cell> {
  const totals: Record<string, Cell> = { [labelKey]: label }
  for (const k of keys) totals[k] = rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0)
  return totals
}
