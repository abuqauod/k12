import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  createSchedule,
  deleteSchedule,
  downloadRun,
  exportReport,
  getCatalog,
  listRecipients,
  listRuns,
  listSchedules,
  RANGES,
  runReport,
  runScheduleNow,
  saveBlob,
  updateSchedule,
  type CatalogEntry,
  type Cell,
  type ColumnType,
  type ExportRun,
  type ReportFilters,
  type ReportResult,
  type Schedule,
  type ScheduleInput,
} from '../lib/reportsApi'
import { listAcademicYears, type AcademicYear } from '../lib/academicYearsApi'
import { listClasses } from '../lib/classesApi'
import type { SchoolClass } from '../domain/classes'
import { formatMinorUnits } from '../domain/finance'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/**
 * Reports (SAMS Phase 7): the catalog of reports the member may run, each
 * with its filters, shown as a table and exported as CSV, Excel or a
 * print page (Save as PDF); scheduled exports; and the files those made.
 * Every figure is computed by the server's shared reporting queries.
 */

type Tab = 'reports' | 'schedules' | 'exports'
const CATEGORIES = ['students', 'attendance', 'admissions', 'finance', 'hr', 'operations'] as const
/** The table shows this many rows; the export has them all. */
const SHOWN = 500

const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`
const today = () => new Date().toISOString().slice(0, 10)

export function reportError(t: (key: TranslationKey) => string, code: string): string {
  const key = `rep.error.${code}` as TranslationKey
  const text = t(key)
  return text === key ? t('rep.error.generic') : text
}

function formatCell(value: Cell, type: ColumnType, n: (v: number) => string): string {
  if (value === null || value === undefined || value === '') return type === 'text' || type === 'date' ? '' : '—'
  if (typeof value !== 'number') return value
  if (type === 'money') return formatMinorUnits(value)
  if (type === 'percent') return `${n(Math.round(value * 1000) / 10)}%`
  return n(value)
}

/** Years and classes for the filter pickers. */
function useFilterData(branchId: string | null) {
  const { getAccessToken } = useAuth()
  const [years, setYears] = useState<AcademicYear[]>([])
  const [classes, setClasses] = useState<SchoolClass[]>([])
  useEffect(() => {
    void listAcademicYears(getAccessToken).then((r) => r.kind === 'ok' && setYears(r.data))
  }, [getAccessToken])
  useEffect(() => {
    void listClasses(getAccessToken, { branchId: branchId ?? undefined, includeInactive: true }).then(
      (r) => r.kind === 'ok' && setClasses(r.data),
    )
  }, [getAccessToken, branchId])
  return { years, classes }
}

export function ReportsPage() {
  const { t, lang } = useI18n()
  const [params, setParams] = useSearchParams()
  const { getAccessToken } = useAuth()
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [canSchedule, setCanSchedule] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getCatalog(getAccessToken, lang).then((r) => {
      if (r.kind === 'ok') {
        setCatalog(r.data.reports)
        setCanSchedule(r.data.canSchedule)
      } else setError(reportError(t, r.error))
    })
  }, [getAccessToken, lang, t])

  const tabs: Tab[] = canSchedule ? ['reports', 'schedules', 'exports'] : ['reports', 'exports']
  const asked = params.get('tab') as Tab
  const tab = tabs.includes(asked) ? asked : 'reports'
  const go = (x: Tab) => setParams(new URLSearchParams({ tab: x }), { replace: true })

  return (
    <div className="page ops-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.reports')}</h1>
          <p className="page__subtitle">{t('rep.subtitle')}</p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label={t('nav.reports')}>
        {tabs.map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x} className="tabs__tab" onClick={() => go(x)}>
            {t(`rep.tab.${x}` as TranslationKey)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="finance-panel">
        {error && <p className="login__error">{error}</p>}
        {catalog === null ? (
          !error && <div className="skeleton" style={{ height: 160 }} />
        ) : (
          <>
            {tab === 'reports' && <ReportsTab catalog={catalog} />}
            {tab === 'schedules' && <SchedulesTab catalog={catalog} />}
            {tab === 'exports' && <ExportsTab />}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- catalog --

function ReportsTab({ catalog }: { catalog: CatalogEntry[] }) {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const key = params.get('report')
  const report = catalog.find((r) => r.key === key)
  if (report) return <ReportView report={report} />
  if (catalog.length === 0) return <div className="empty-state">{t('rep.none')}</div>
  const open = (k: string) => setParams(new URLSearchParams({ tab: 'reports', report: k }))
  return (
    <div className="report-catalog">
      {CATEGORIES.filter((c) => catalog.some((r) => r.category === c)).map((c) => (
        <section key={c} className="card">
          <h2 className="card__title">{t(`rep.cat.${c}` as TranslationKey)}</h2>
          <ul className="report-list">
            {catalog
              .filter((r) => r.category === c)
              .map((r) => (
                <li key={r.key}>
                  <button type="button" className="report-link" onClick={() => open(r.key)}>
                    <b>{r.title}</b>
                    <small>{r.description}</small>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** The pickers for a report's filters (dates are separate: a schedule uses
 * a relative range instead). */
function FilterFields({
  report,
  value,
  onChange,
}: {
  report: CatalogEntry
  value: ReportFilters
  onChange: (next: ReportFilters) => void
}) {
  const { t } = useI18n()
  const { branches } = useApp()
  const { years, classes } = useFilterData(value.branchId)
  const has = (k: CatalogEntry['filters'][number]) => report.filters.includes(k)
  const grades = useMemo(() => [...new Set(classes.map((c) => c.gradeLevel))].sort(), [classes])
  const shownClasses = classes.filter((c) => !value.gradeLevel || c.gradeLevel === value.gradeLevel)
  const set = (patch: Partial<ReportFilters>) => onChange({ ...value, ...patch })
  return (
    <>
      {has('branch') && (
        <label className="field field--inline">
          <span>{t('rep.f.branch')}</span>
          <select
            className="select input--sm"
            value={value.branchId ?? ''}
            onChange={(e) => set({ branchId: e.target.value || null, classId: null })}
          >
            <option value="">{t('rep.f.allBranches')}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {has('year') && (
        <label className="field field--inline">
          <span>{t('rep.f.year')}</span>
          <select
            className="select input--sm"
            value={value.academicYearId ?? ''}
            onChange={(e) => set({ academicYearId: e.target.value || null })}
          >
            <option value="">{t('rep.f.anyYear')}</option>
            {years.map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
                {y.current ? ` (${t('rep.f.current')})` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {has('grade') && (
        <label className="field field--inline">
          <span>{t('rep.f.grade')}</span>
          <select
            className="select input--sm"
            value={value.gradeLevel ?? ''}
            onChange={(e) => set({ gradeLevel: e.target.value || null, classId: null })}
          >
            <option value="">{t('rep.f.all')}</option>
            {grades.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
      )}
      {has('class') && (
        <label className="field field--inline">
          <span>{t('rep.f.class')}</span>
          <select className="select input--sm" value={value.classId ?? ''} onChange={(e) => set({ classId: e.target.value || null })}>
            <option value="">{t('rep.f.all')}</option>
            {shownClasses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {has('status') && report.statuses.length > 0 && (
        <label className="field field--inline">
          <span>{t('rep.f.status')}</span>
          <select className="select input--sm" value={value.status ?? ''} onChange={(e) => set({ status: e.target.value || null })}>
            <option value="">{t('rep.f.all')}</option>
            {report.statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  )
}

const FILTER_PARAMS = ['branchId', 'academicYearId', 'gradeLevel', 'classId', 'status'] as const

function ReportView({ report }: { report: CatalogEntry }) {
  const { t, lang, n } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState<ReportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // The filters live in the URL, so a report can be linked to and reloaded.
  const filters: ReportFilters = {
    branchId: params.has('branchId') ? params.get('branchId') || null : activeBranchId,
    academicYearId: params.get('academicYearId') || null,
    gradeLevel: params.get('gradeLevel') || null,
    classId: params.get('classId') || null,
    status: params.get('status') || null,
  }
  const dated = report.filters.includes('dates')
  const from = params.get('from') || monthStart()
  const to = params.get('to') || today()
  const setFilters = (next: ReportFilters & { from?: string; to?: string }) =>
    setParams(
      (p) => {
        for (const k of FILTER_PARAMS) {
          const v = next[k]
          if (k === 'branchId') p.set(k, v ?? '')
          else if (v) p.set(k, v)
          else p.delete(k)
        }
        if (next.from !== undefined) p.set('from', next.from)
        if (next.to !== undefined) p.set('to', next.to)
        return p
      },
      { replace: true },
    )
  const run = { ...filters, from: dated ? from : null, to: dated ? to : null, lang }
  const runKey = JSON.stringify([report.key, run])

  useEffect(() => {
    if (dated && (!from || !to || from > to)) return
    let live = true
    setData(null)
    setError(null)
    void runReport(getAccessToken, report.key, run).then((r) => {
      if (!live) return
      if (r.kind === 'ok') setData(r.data)
      else setError(reportError(t, r.error))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAccessToken, runKey])

  const download = async (format: 'csv' | 'xlsx' | 'html') => {
    setBusy(format)
    setError(null)
    // Opened now, while the click still counts as the user's: a window
    // opened after the download would be blocked as a pop-up.
    const win = format === 'html' ? window.open('', '_blank') : null
    const res = await exportReport(getAccessToken, report.key, run, format)
    setBusy(null)
    if (res.kind !== 'ok') {
      win?.close()
      return setError(reportError(t, res.error))
    }
    if (format === 'html') {
      const url = URL.createObjectURL(res.data.blob)
      if (win) win.location.href = url
      else window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } else saveBlob(res.data.blob, res.data.fileName)
  }

  const back = () => setParams(new URLSearchParams({ tab: 'reports' }))
  const numeric = (type: ColumnType) => type !== 'text' && type !== 'date'

  return (
    <div className="report">
      <div>
        <button type="button" className="btn btn--sm btn--ghost" onClick={back}>
          {lang === 'ar' ? '›' : '‹'} {t('rep.back')}
        </button>
      </div>
      <header>
        <h2 className="report__title">{report.title}</h2>
        <p className="card__hint">{report.description}</p>
      </header>
      <div className="panel">
        <div className="inline-form">
          <FilterFields report={report} value={filters} onChange={(next) => setFilters(next)} />
          {dated && (
            <>
              <label className="field field--inline">
                <span>{t('fin.report.from')}</span>
                <input
                  type="date"
                  className="input input--sm"
                  value={from}
                  onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                />
              </label>
              <label className="field field--inline">
                <span>{t('fin.report.to')}</span>
                <input
                  type="date"
                  className="input input--sm"
                  value={to}
                  onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                />
              </label>
            </>
          )}
        </div>
        <div className="inline-form">
          <button type="button" className="btn btn--sm" disabled={!!busy || !data} onClick={() => void download('csv')}>
            {busy === 'csv' ? t('rep.preparing') : t('rep.export.csv')}
          </button>
          <button type="button" className="btn btn--sm" disabled={!!busy || !data} onClick={() => void download('xlsx')}>
            {busy === 'xlsx' ? t('rep.preparing') : t('rep.export.xlsx')}
          </button>
          <button type="button" className="btn btn--sm" disabled={!!busy || !data} onClick={() => void download('html')}>
            {busy === 'html' ? t('rep.preparing') : t('rep.export.print')}
          </button>
          {can('reports.schedule') && (
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() =>
                setParams(
                  new URLSearchParams({ tab: 'schedules', new: report.key, ...(filters.branchId ? { branchId: filters.branchId } : {}) }),
                )
              }
            >
              {t('rep.schedule')}
            </button>
          )}
        </div>
      </div>
      {error && <p className="login__error">{error}</p>}
      {dated && from > to && <p className="login__error">{t('rep.error.DATES_OUT_OF_ORDER')}</p>}
      {!data && !error ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : data ? (
        <section className="card">
          <p className="card__hint">
            {data.meta.map((m) => `${m.label}: ${m.value}`).join(' · ')} · {t('rep.rows', { count: n(data.rows.length) })}
          </p>
          {data.rows.length === 0 ? (
            <div className="empty-state">{t('rep.empty')}</div>
          ) : (
            <div className="table-scroll report-table">
              <table className="table">
                <thead>
                  <tr>
                    {data.columns.map((c) => (
                      <th key={c.key} className={numeric(c.type) ? 'num' : undefined}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.slice(0, SHOWN).map((row, i) => (
                    <tr key={i}>
                      {data.columns.map((c) => (
                        <td key={c.key} className={numeric(c.type) ? 'num mono' : c.type === 'date' ? 'mono' : 'bidi'}>
                          {formatCell(row[c.key] ?? null, c.type, n)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {data.totals && (
                  <tfoot>
                    <tr>
                      {data.columns.map((c) => (
                        <td key={c.key} className={numeric(c.type) ? 'num mono' : undefined}>
                          {formatCell(data.totals![c.key] ?? null, c.type, n)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          {(data.rows.length > SHOWN || data.truncated) && (
            <p className="notice notice--warn">
              {data.truncated ? t('rep.truncated') : t('rep.moreRows', { shown: n(SHOWN), count: n(data.rows.length) })}
            </p>
          )}
        </section>
      ) : null}
    </div>
  )
}

// -------------------------------------------------------------- schedules --

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

function describeTiming(s: Pick<ScheduleInput, 'frequency' | 'weekday' | 'monthDay'>, t: ReturnType<typeof useI18n>['t']) {
  if (s.frequency === 'weekly') return t('rep.sch.everyWeekday', { day: t(`rep.day.${s.weekday ?? 1}` as TranslationKey) })
  if (s.frequency === 'monthly') return t('rep.sch.everyMonthDay', { day: String(s.monthDay ?? 1) })
  return t('rep.sch.everyDay')
}

function SchedulesTab({ catalog }: { catalog: CatalogEntry[] }) {
  const { t, lang } = useI18n()
  const { getAccessToken, user } = useAuth()
  const [params, setParams] = useSearchParams()
  const [rows, setRows] = useState<Schedule[] | null>(null)
  const [editing, setEditing] = useState<Schedule | 'new' | null>(params.get('new') ? 'new' : null)
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await listSchedules(getAccessToken)
    setRows(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken])
  useEffect(() => {
    void load()
  }, [load])

  const title = (s: Schedule) => s.name || (s.reportTitle ? s.reportTitle[lang] : s.reportKey)
  const act = async (fn: () => Promise<{ kind: string; error?: string }>, done?: string) => {
    setError(null)
    setNote(null)
    const res = await fn()
    if (res.kind !== 'ok') setError(reportError(t, res.error ?? 'generic'))
    else if (done) setNote({ text: done, warn: false })
    await load()
  }
  const runNow = async (s: Schedule) => {
    setError(null)
    setNote(null)
    const res = await runScheduleNow(getAccessToken, s.id)
    if (res.kind !== 'ok') setError(reportError(t, res.error))
    else
      setNote({
        text:
          t('rep.sch.ran', { rows: String(res.data.rows), people: String(res.data.notified) }) +
          (res.data.skippedRecipients ? ` ${t('rep.sch.skipped', { count: String(res.data.skippedRecipients) })}` : ''),
        warn: res.data.skippedRecipients > 0,
      })
    await load()
  }

  if (editing) {
    return (
      <ScheduleForm
        catalog={catalog}
        initial={editing === 'new' ? null : editing}
        presetKey={params.get('new')}
        presetBranch={params.get('branchId')}
        onClose={(saved) => {
          setEditing(null)
          if (params.get('new')) setParams(new URLSearchParams({ tab: 'schedules' }), { replace: true })
          if (saved) {
            setNote({ text: t('rep.sch.saved'), warn: false })
            void load()
          }
        }}
      />
    )
  }

  return (
    <section className="card">
      <div className="inline-form">
        <h2 className="card__title" style={{ margin: 0 }}>
          {t('rep.tab.schedules')}
        </h2>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn--sm btn--primary" onClick={() => setEditing('new')}>
          {t('rep.sch.new')}
        </button>
      </div>
      <p className="card__hint">{t('rep.sch.hint')}</p>
      {note && <p className={`notice${note.warn ? ' notice--warn' : ''}`}>{note.text}</p>}
      {error && <p className="login__error">{error}</p>}
      {rows === null ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : rows.length === 0 ? (
        <div className="empty-state">{t('rep.sch.none')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t('rep.sch.col.report')}</th>
                <th>{t('rep.sch.col.when')}</th>
                <th>{t('rep.sch.col.next')}</th>
                <th>{t('rep.sch.col.last')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <b>{title(s)}</b>
                    <br />
                    <small className="card__hint">
                      {s.format === 'xlsx' ? 'Excel' : 'CSV'} · {t(`rep.range.${s.range}` as TranslationKey)} ·{' '}
                      {t('rep.sch.people', { count: String(s.recipients.length + 1) })}
                      {s.ownerId !== user?.id && s.ownerName ? ` · ${s.ownerName}` : ''}
                    </small>
                  </td>
                  <td>{describeTiming(s, t)}</td>
                  <td className="mono">{s.active ? s.nextRunDate : <span className="chip">{t('rep.sch.paused')}</span>}</td>
                  <td>
                    {s.lastRunAt ? <span className="mono">{s.lastRunAt.slice(0, 10)}</span> : '—'}
                    {s.lastError && (
                      <>
                        {' '}
                        <span className="chip chip--bad">{reportError(t, s.lastError)}</span>
                      </>
                    )}
                  </td>
                  <td>
                    <span className="inline-form" style={{ padding: 0, flexWrap: 'nowrap' }}>
                      <button type="button" className="btn btn--sm" onClick={() => void runNow(s)}>
                        {t('rep.sch.runNow')}
                      </button>
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(s)}>
                        {t('rep.sch.edit')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => void act(() => updateSchedule(getAccessToken, s.id, { active: !s.active }))}
                      >
                        {s.active ? t('rep.sch.pause') : t('rep.sch.resume')}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => {
                          if (window.confirm(t('rep.sch.confirmDelete', { name: title(s) })))
                            void act(() => deleteSchedule(getAccessToken, s.id))
                        }}
                      >
                        {t('rep.sch.delete')}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

const EMPTY_FILTERS: ReportFilters = { branchId: null, academicYearId: null, gradeLevel: null, classId: null, status: null }

function ScheduleForm({
  catalog,
  initial,
  presetKey,
  presetBranch,
  onClose,
}: {
  catalog: CatalogEntry[]
  initial: Schedule | null
  presetKey: string | null
  presetBranch: string | null
  onClose: (saved: boolean) => void
}) {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [draft, setDraft] = useState<ScheduleInput>(() =>
    initial
      ? {
          name: initial.name,
          reportKey: initial.reportKey,
          filters: initial.filters,
          range: initial.range,
          format: initial.format,
          language: initial.language,
          frequency: initial.frequency,
          weekday: initial.weekday,
          monthDay: initial.monthDay,
          recipients: initial.recipients,
          active: initial.active,
        }
      : {
          name: '',
          reportKey: catalog.some((r) => r.key === presetKey) ? presetKey! : catalog[0]!.key,
          filters: { ...EMPTY_FILTERS, branchId: presetBranch || null },
          range: 'previous_month',
          format: 'xlsx',
          language: lang,
          frequency: 'monthly',
          weekday: 1,
          monthDay: 1,
          recipients: [],
          active: true,
        },
  )
  const [people, setPeople] = useState<{ userId: string; name: string; email: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const report = catalog.find((r) => r.key === draft.reportKey)
  const set = (patch: Partial<ScheduleInput>) => setDraft((d) => ({ ...d, ...patch }))

  useEffect(() => {
    setPeople(null)
    void listRecipients(getAccessToken, draft.reportKey, draft.filters.branchId).then((r) => setPeople(r.kind === 'ok' ? r.data : []))
  }, [getAccessToken, draft.reportKey, draft.filters.branchId])

  // Recipients who can no longer receive it (another report, a wider
  // branch) drop off the list.
  const eligible = new Set((people ?? []).map((p) => p.userId))
  const recipients = people === null ? draft.recipients : draft.recipients.filter((r) => eligible.has(r))

  const save = async () => {
    setSaving(true)
    setError(null)
    const body = { ...draft, recipients }
    const res = initial ? await updateSchedule(getAccessToken, initial.id, body) : await createSchedule(getAccessToken, body)
    setSaving(false)
    if (res.kind !== 'ok') return setError(reportError(t, res.error))
    onClose(true)
  }

  return (
    <section className="card">
      <h2 className="card__title">{initial ? t('rep.sch.editTitle') : t('rep.sch.new')}</h2>
      <div className="stack-form">
        <label className="field">
          <span>{t('rep.sch.report')}</span>
          <select
            className="select"
            value={draft.reportKey}
            onChange={(e) => set({ reportKey: e.target.value, filters: { ...EMPTY_FILTERS, branchId: draft.filters.branchId } })}
          >
            {CATEGORIES.map((c) => (
              <optgroup key={c} label={t(`rep.cat.${c}` as TranslationKey)}>
                {catalog
                  .filter((r) => r.category === c)
                  .map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.title}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('rep.sch.name')}</span>
          <input
            className="input"
            maxLength={120}
            placeholder={report?.title}
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
        {report && (
          <div className="inline-form">
            <FilterFields report={report} value={draft.filters} onChange={(filters) => set({ filters })} />
            {report.filters.includes('dates') && (
              <label className="field field--inline">
                <span>{t('rep.sch.range')}</span>
                <select
                  className="select input--sm"
                  value={draft.range}
                  onChange={(e) => set({ range: e.target.value as ScheduleInput['range'] })}
                >
                  {RANGES.map((r) => (
                    <option key={r} value={r}>
                      {t(`rep.range.${r}` as TranslationKey)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <div className="inline-form">
          <label className="field field--inline">
            <span>{t('rep.sch.frequency')}</span>
            <select
              className="select input--sm"
              value={draft.frequency}
              onChange={(e) => set({ frequency: e.target.value as ScheduleInput['frequency'] })}
            >
              {(['daily', 'weekly', 'monthly'] as const).map((f) => (
                <option key={f} value={f}>
                  {t(`rep.freq.${f}` as TranslationKey)}
                </option>
              ))}
            </select>
          </label>
          {draft.frequency === 'weekly' && (
            <label className="field field--inline">
              <span>{t('rep.sch.on')}</span>
              <select className="select input--sm" value={draft.weekday ?? 1} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d) => (
                  <option key={d} value={d}>
                    {t(`rep.day.${d}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft.frequency === 'monthly' && (
            <label className="field field--inline">
              <span>{t('rep.sch.onDay')}</span>
              <select className="select input--sm" value={draft.monthDay ?? 1} onChange={(e) => set({ monthDay: Number(e.target.value) })}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field field--inline">
            <span>{t('rep.sch.format')}</span>
            <select className="select input--sm" value={draft.format} onChange={(e) => set({ format: e.target.value as 'csv' | 'xlsx' })}>
              <option value="xlsx">Excel (.xlsx)</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <label className="field field--inline">
            <span>{t('rep.sch.language')}</span>
            <select className="select input--sm" value={draft.language} onChange={(e) => set({ language: e.target.value as 'en' | 'ar' })}>
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
        </div>
        <fieldset className="field">
          <span>{t('rep.sch.recipients')}</span>
          <small className="card__hint">{t('rep.sch.recipientsHint')}</small>
          {people === null ? (
            <div className="skeleton" style={{ height: 40 }} />
          ) : people.length === 0 ? (
            <small className="card__hint">{t('rep.sch.noRecipients')}</small>
          ) : (
            <div className="check-grid">
              {people.map((p) => (
                <label key={p.userId} className="checkbox-inline" title={p.email}>
                  <input
                    type="checkbox"
                    checked={recipients.includes(p.userId)}
                    onChange={(e) =>
                      set({ recipients: e.target.checked ? [...recipients, p.userId] : recipients.filter((r) => r !== p.userId) })
                    }
                  />
                  {p.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {error && <p className="login__error">{error}</p>}
        <div className="inline-form">
          <button type="button" className="btn btn--primary" disabled={saving} onClick={() => void save()}>
            {t('comm.save')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => onClose(false)}>
            {t('docs.cancel')}
          </button>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- exports --

function ExportsTab() {
  const { t, n } = useI18n()
  const { getAccessToken } = useAuth()
  const [params] = useSearchParams()
  const highlight = params.get('run')
  const [runs, setRuns] = useState<ExportRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void listRuns(getAccessToken).then((r) => setRuns(r.kind === 'ok' ? r.data : []))
  }, [getAccessToken])
  const get = async (run: ExportRun) => {
    setError(null)
    const res = await downloadRun(getAccessToken, run)
    if (res.kind !== 'ok') return setError(reportError(t, res.error))
    saveBlob(res.data.blob, res.data.fileName)
  }
  const size = (bytes: number) => (bytes < 1024 ? `${n(bytes)} B` : `${n(Math.round(bytes / 102.4) / 10)} KB`)
  return (
    <section className="card">
      <h2 className="card__title">{t('rep.tab.exports')}</h2>
      <p className="card__hint">{t('rep.runs.hint')}</p>
      {error && <p className="login__error">{error}</p>}
      {runs === null ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : runs.length === 0 ? (
        <div className="empty-state">{t('rep.runs.none')}</div>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t('rep.sch.col.report')}</th>
                <th>{t('rep.runs.period')}</th>
                <th>{t('rep.runs.made')}</th>
                <th className="num">{t('rep.runs.rows')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={r.id === highlight ? 'row--highlight' : undefined}>
                  <td>
                    <b>{r.title}</b>
                    <br />
                    <small className="card__hint mono">
                      {r.fileName} · {size(r.size)}
                    </small>
                  </td>
                  <td className="mono">{r.from ? (r.from === r.to ? r.from : `${r.from} – ${r.to}`) : '—'}</td>
                  <td className="mono">{r.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="num mono">{n(r.rows)}</td>
                  <td>
                    <button type="button" className="btn btn--sm" onClick={() => void get(r)}>
                      {t('rep.runs.download')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
