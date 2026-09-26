import { authorizedFetch, type TokenGetter } from './http'
import { api, enc, pick, qs, type ApiResult } from './apiClient'
import { loadSyncSettings } from './sync'

/** Client for the report catalog, exports and scheduled exports (SAMS Phase 7). */

export type FilterKey = 'branch' | 'year' | 'dates' | 'grade' | 'class' | 'status'
export type ReportCategory = 'students' | 'attendance' | 'admissions' | 'finance' | 'hr' | 'operations'

export interface CatalogEntry {
  key: string
  category: ReportCategory
  title: string
  description: string
  filters: FilterKey[]
  statuses: { value: string; label: string }[]
}

export interface ReportFilters {
  branchId: string | null
  academicYearId: string | null
  gradeLevel: string | null
  classId: string | null
  status: string | null
}

export interface RunParams extends Partial<ReportFilters> {
  from?: string | null
  to?: string | null
  lang: 'en' | 'ar'
}

export type ColumnType = 'text' | 'number' | 'money' | 'date' | 'percent'
export type Cell = string | number | null

export interface ReportResult {
  key: string
  title: string
  from: string | null
  to: string | null
  columns: { key: string; label: string; type: ColumnType }[]
  rows: Record<string, Cell>[]
  totals: Record<string, Cell> | null
  truncated: boolean
  meta: { label: string; value: string }[]
}

export const getCatalog = (getToken: TokenGetter, lang: 'en' | 'ar') =>
  api<{ reports: CatalogEntry[]; canSchedule: boolean }>(getToken, 'GET', `/reports/catalog${qs({ lang })}`)

const runQuery = (p: RunParams) =>
  qs({
    branchId: p.branchId,
    academicYearId: p.academicYearId,
    gradeLevel: p.gradeLevel,
    classId: p.classId,
    status: p.status,
    from: p.from,
    to: p.to,
    lang: p.lang,
  })

export const runReport = (getToken: TokenGetter, key: string, params: RunParams) =>
  api<ReportResult>(getToken, 'GET', `/reports/${enc(key)}${runQuery(params)}`)

const baseUrl = () => loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')

/** The file name from Content-Disposition (the UTF-8 form first). */
function fileNameOf(res: Response, fallback: string): string {
  const header = res.headers.get('Content-Disposition') ?? ''
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (utf) return decodeURIComponent(utf[1]!)
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? fallback
}

async function fetchFile(getToken: TokenGetter, path: string, fallback: string): Promise<ApiResult<{ blob: Blob; fileName: string }>> {
  try {
    const res = await authorizedFetch(`${baseUrl()}${path}`, { method: 'GET' }, getToken, 120_000)
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      return { kind: 'error', error: body.error ?? `HTTP_${res.status}` }
    }
    return { kind: 'ok', data: { blob: await res.blob(), fileName: fileNameOf(res, fallback) } }
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const exportReport = (getToken: TokenGetter, key: string, params: RunParams, format: 'csv' | 'xlsx' | 'html') =>
  fetchFile(
    getToken,
    `/reports/${enc(key)}/export${runQuery(params)}${`&format=${format}${format === 'html' ? '&autoprint=1' : ''}`}`,
    `${key}.${format}`,
  )

// ------------------------------------------------------------ schedules --

export type ReportRange =
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'month_to_date'
  | 'previous_month'
  | 'year_to_date'
  | 'academic_year'
export const RANGES: ReportRange[] = [
  'yesterday',
  'last_7_days',
  'last_30_days',
  'month_to_date',
  'previous_month',
  'year_to_date',
  'academic_year',
]
export type Frequency = 'daily' | 'weekly' | 'monthly'

export interface ScheduleInput {
  name: string
  reportKey: string
  filters: ReportFilters
  range: ReportRange
  format: 'csv' | 'xlsx'
  language: 'en' | 'ar'
  frequency: Frequency
  weekday: number | null
  monthDay: number | null
  recipients: string[]
  active: boolean
}

export interface Schedule extends ScheduleInput {
  id: string
  reportTitle: { en: string; ar: string } | null
  ownerId: string
  ownerName?: string
  nextRunDate: string
  lastRunAt: string | null
  lastRunId: string | null
  lastError: string | null
  createdAt: string
}

export const listSchedules = (getToken: TokenGetter) =>
  pick(api<{ schedules: Schedule[] }>(getToken, 'GET', '/reports/schedules'), 'schedules')
export const createSchedule = (getToken: TokenGetter, body: ScheduleInput) => api<Schedule>(getToken, 'POST', '/reports/schedules', body)
export const updateSchedule = (getToken: TokenGetter, id: string, body: Partial<ScheduleInput>) =>
  api<Schedule>(getToken, 'PATCH', `/reports/schedules/${enc(id)}`, body)
export const deleteSchedule = (getToken: TokenGetter, id: string) => api<{ ok: true }>(getToken, 'DELETE', `/reports/schedules/${enc(id)}`)
export const runScheduleNow = (getToken: TokenGetter, id: string) =>
  api<{ runId: string; rows: number; notified: number; skippedRecipients: number }>(
    getToken,
    'POST',
    `/reports/schedules/${enc(id)}/run`,
    {},
  )
export const listRecipients = (getToken: TokenGetter, key: string, branchId: string | null) =>
  pick(
    api<{ members: { userId: string; name: string; email: string }[] }>(getToken, 'GET', `/reports/recipients${qs({ key, branchId })}`),
    'members',
  )

// ----------------------------------------------------------------- runs --

export interface ExportRun {
  id: string
  scheduleId: string
  reportKey: string
  title: string
  from: string | null
  to: string | null
  format: 'csv' | 'xlsx'
  fileName: string
  size: number
  rows: number
  createdAt: string
}

export const listRuns = (getToken: TokenGetter) => pick(api<{ runs: ExportRun[] }>(getToken, 'GET', '/reports/runs'), 'runs')
export const downloadRun = (getToken: TokenGetter, run: ExportRun) => fetchFile(getToken, `/reports/runs/${enc(run.id)}/file`, run.fileName)
