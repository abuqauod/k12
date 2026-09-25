import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { schoolDays } from '../domain/calendar'
import { coverage, hhmm, naturalCompare, unique } from '../lib/view'
import { auditStudents } from '../domain/students'
import { listInvoices } from '../lib/financeApi'
import { listAuditLog } from '../lib/auditLog'
import { getDashboardSummary } from '../lib/dashboardApi'
import type { DashboardSummary } from '../lib/dashboardApi'
import type { AuditEntry } from '../lib/auditLog'
import { formatMinorUnits } from '../domain/finance'

interface InvoiceSummary {
  outstanding: number
  overdue: number
  openTotal: number
}

/** Stroke icons (24px grid) — inline so they follow `currentColor`. */
const ICON = {
  students:
    'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10 8v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 5.15a3 3 0 0 1 0 5.7',
  invoice: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6M9 12h6',
  overdue: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  bus: 'M5 17V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v11M5 11h14M7 20v-3M17 20v-3M5 17h14M8 14h.01M16 14h.01',
  plus: 'M12 5v14M5 12h14',
  cash: 'M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  check: 'M4 12l5 5L20 6',
  family: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 20v-1a5 5 0 0 1 10 0v1M14 20v-.5a4 4 0 0 1 7-2.6',
  enroll: 'M4 6l8-3 8 3-8 3-8-3Zm3 2.2V13c0 1.7 2.2 3 5 3s5-1.3 5-3V8.2',
  approve: 'M9 12l2 2 4-4M12 3l7 3v6c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6l7-3Z',
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

type Tone = 'neutral' | 'ok' | 'warn' | 'bad'

/** A summary tile that is also the way into its module. */
function StatTile(props: {
  to: string
  icon: string
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
  loading?: boolean
}) {
  const tone = props.tone ?? 'neutral'
  return (
    <Link to={props.to} className={`stat-tile stat-tile--${tone}`} aria-busy={props.loading || undefined}>
      <span className="stat-tile__icon">
        <Icon d={props.icon} />
      </span>
      <span className="stat-tile__label">{props.label}</span>
      <b className="stat-tile__value">{props.loading ? <span className="skeleton" /> : props.value}</b>
      {props.hint && !props.loading && <span className="stat-tile__hint">{props.hint}</span>}
    </Link>
  )
}

/** "2 hours ago" in the active language. */
function relativeTime(iso: string, lang: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  const format = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(Math.round(seconds), 'second')
}

export function DashboardPage() {
  const { t, n, day, lang } = useI18n()
  const { user, getAccessToken, can } = useAuth()
  const { problem, solution, solving, progress, solve, stop, students, buses, stops, activeBranchId, transportLoading } =
    useApp()

  const activeStudents = useMemo(() => students.filter((s) => s.active), [students])
  const studentsNeedingAttention = useMemo(
    () => new Set(auditStudents(students).map((issue) => issue.studentId)).size,
    [students],
  )
  const studentsWithoutStop = useMemo(
    () => activeStudents.filter((s) => s.transportMode !== 'NONE' && !s.stopId).length,
    [activeStudents],
  )

  const canFinance = can('finance.read')
  const canAudit = can('audit.read')

  // Server-side counts (SAMS 1.12): parents, this year's enrollment, and
  // approvals waiting on this user — each present only if permitted.
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    void getDashboardSummary(getAccessToken, activeBranchId).then((result) => {
      if (cancelled) return
      setSummaryLoading(false)
      setSummary(result.kind === 'ok' ? result.data : null)
    })
    return () => {
      cancelled = true
    }
  }, [getAccessToken, activeBranchId])

  const [invoiceSummary, setInvoiceSummary] = useState<InvoiceSummary | null>(null)
  const [financeLoading, setFinanceLoading] = useState(false)
  const [financeError, setFinanceError] = useState(false)

  useEffect(() => {
    if (!activeBranchId || !canFinance) {
      setInvoiceSummary(null)
      setFinanceError(false)
      return
    }
    let cancelled = false
    setFinanceLoading(true)
    setFinanceError(false)
    void (async () => {
      const [openResult, partialResult] = await Promise.all([
        listInvoices(getAccessToken, { branchId: activeBranchId, status: 'open' }),
        listInvoices(getAccessToken, { branchId: activeBranchId, status: 'partially_paid' }),
      ])
      if (cancelled) return
      setFinanceLoading(false)
      if (openResult.kind !== 'ok' || partialResult.kind !== 'ok') {
        setFinanceError(true)
        return
      }
      const invoices = [...openResult.data, ...partialResult.data]
      const today = new Date().toISOString().slice(0, 10)
      setInvoiceSummary({
        outstanding: invoices.length,
        overdue: invoices.filter((inv) => inv.dueDate && inv.dueDate < today).length,
        openTotal: openResult.data.reduce((sum, inv) => sum + inv.total, 0),
      })
    })()
    return () => {
      cancelled = true
    }
  }, [activeBranchId, canFinance, getAccessToken])

  // Recent activity — the same audit feed the Activity log page reads,
  // branch-filtered by the server for branch-confined members.
  const [activity, setActivity] = useState<AuditEntry[] | null>(null)
  const [activityError, setActivityError] = useState(false)
  useEffect(() => {
    if (!canAudit) return
    let cancelled = false
    void listAuditLog(getAccessToken, { limit: 6, ...(activeBranchId ? { branchId: activeBranchId } : {}) }).then(
      (result) => {
        if (cancelled) return
        setActivityError(result.kind !== 'ok')
        setActivity(result.kind === 'ok' ? result.data : null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [canAudit, activeBranchId, getAccessToken])

  const teachers = useMemo(
    () => unique(problem.lessons.map((lesson) => lesson.teacher)).sort(naturalCompare),
    [problem.lessons],
  )
  const cohorts = useMemo(() => coverage(problem), [problem])
  // classId -> label, for the breaks list below (BreakRule.classIds holds
  // real ids; every lesson already carries its own resolved label, so no
  // separate class fetch is needed just to print one here).
  const classLabel = useMemo(() => {
    const map = new Map<string, string>()
    for (const lesson of problem.lessons) {
      if (lesson.classId) map.set(lesson.classId, lesson.studentGroup)
    }
    return map
  }, [problem.lessons])
  const days = schoolDays(problem.calendar)
  const firstDay = problem.timeslots.filter((slot) => slot.dayOfWeek === days[0])
  const dayEnds = firstDay.length > 0 ? hhmm(firstDay[firstDay.length - 1].endTime) : '—'

  const hard = solving ? (progress?.best.hard ?? 0) : (solution?.score.hard ?? 0)
  const soft = solving ? (progress?.best.soft ?? 0) : (solution?.score.soft ?? 0)
  const feasible = solution?.status === 'SUCCESS'

  const kpis = [
    { key: 'dash.kpi.cohorts', value: cohorts.length },
    { key: 'dash.kpi.lessons', value: problem.lessons.length },
    { key: 'dash.kpi.teachers', value: teachers.length },
    { key: 'dash.kpi.rooms', value: problem.rooms.length },
  ] as const

  const quickActions = [
    { to: '/students', icon: ICON.plus, label: t('dash.quick.addStudent'), show: can('students.create') },
    { to: '/finance', icon: ICON.cash, label: t('dash.quick.recordPayment'), show: can('finance.payment.create') },
    { to: '/attendance', icon: ICON.check, label: t('dash.quick.attendance'), show: can('attendance.write') },
  ].filter((action) => action.show)

  const displayName = user ? (lang === 'ar' ? user.displayNameAr ?? user.displayName : user.displayName) : ''

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('dash.greeting', { name: displayName })}</h1>
          <p className="page__subtitle">{t('dash.subtitle')}</p>
        </div>
        {quickActions.length > 0 && (
          <nav className="quick-actions" aria-label={t('dash.overview.title')}>
            {quickActions.map((action, index) => (
              <Link key={action.to} to={action.to} className={`btn${index === 0 ? ' btn--primary' : ''}`}>
                <Icon d={action.icon} />
                {action.label}
              </Link>
            ))}
          </nav>
        )}
      </header>

      {/* ------------------------------------------------ school overview */}
      <section aria-labelledby="dash-overview">
        <div className="section-head">
          <h2 id="dash-overview" className="section-head__title">
            {t('dash.overview.title')}
          </h2>
          <p className="section-head__hint">{t('dash.overview.subtitle')}</p>
        </div>
        {!activeBranchId ? (
          <p className="card card__empty">{t('dash.overview.noBranch')}</p>
        ) : (
          <div className="tile-grid">
            <StatTile
              to="/students"
              icon={ICON.students}
              label={t('dash.overview.students.active')}
              value={n(activeStudents.length)}
              tone={studentsNeedingAttention > 0 ? 'warn' : 'ok'}
              hint={
                studentsNeedingAttention > 0
                  ? t('dash.overview.students.hint', { n: n(studentsNeedingAttention) })
                  : t('dash.overview.students.ok')
              }
            />
            {canFinance && (
              <>
                <StatTile
                  to="/finance"
                  icon={ICON.invoice}
                  label={t('dash.overview.finance.outstanding')}
                  loading={financeLoading}
                  value={financeError || !invoiceSummary ? '—' : n(invoiceSummary.outstanding)}
                  tone={financeError ? 'bad' : 'neutral'}
                  hint={
                    financeError
                      ? t('dash.overview.finance.error')
                      : invoiceSummary &&
                        t('dash.overview.finance.openHint', { amount: formatMinorUnits(invoiceSummary.openTotal) })
                  }
                />
                <StatTile
                  to="/finance"
                  icon={ICON.overdue}
                  label={t('dash.overview.finance.overdue')}
                  loading={financeLoading}
                  value={financeError || !invoiceSummary ? '—' : n(invoiceSummary.overdue)}
                  tone={invoiceSummary && invoiceSummary.overdue > 0 ? 'bad' : 'ok'}
                  hint={
                    invoiceSummary &&
                    (invoiceSummary.overdue > 0
                      ? t('dash.overview.finance.overdueHint')
                      : t('dash.overview.finance.overdueOk'))
                  }
                />
              </>
            )}
            <StatTile
              to="/routes"
              icon={ICON.bus}
              label={t('dash.overview.transport.buses')}
              loading={transportLoading}
              value={n(buses.length)}
              tone={studentsWithoutStop > 0 ? 'warn' : 'neutral'}
              hint={t('dash.overview.transport.hint', { stops: n(stops.length), n: n(studentsWithoutStop) })}
            />
            {(summaryLoading || summary?.parents) && (
              <StatTile
                to="/parents"
                icon={ICON.family}
                label={t('dash.parents.title')}
                loading={summaryLoading}
                value={n(summary?.parents?.total ?? 0)}
                tone={(summary?.parents?.incomplete ?? 0) > 0 ? 'warn' : 'neutral'}
                hint={
                  summary?.parents &&
                  t('dash.parents.hint', {
                    multi: n(summary.parents.multiChild),
                    incomplete: n(summary.parents.incomplete),
                  })
                }
              />
            )}
            {summary?.enrollments && (
              <StatTile
                to="/students"
                icon={ICON.enroll}
                label={t('dash.enrollments.title', { year: summary.enrollments.academicYear ?? '—' })}
                value={n(summary.enrollments.active)}
                tone={summary.enrollments.withdrawals > 0 ? 'warn' : 'neutral'}
                hint={t('dash.enrollments.hint', {
                  withdrawals: n(summary.enrollments.withdrawals),
                  transfers: n(summary.enrollments.transfers),
                })}
              />
            )}
            {summary?.approvals && (
              <StatTile
                to="/approvals"
                icon={ICON.approve}
                label={t('dash.approvals.title')}
                value={n(summary.approvals.pendingToDecide)}
                tone={summary.approvals.pendingToDecide > 0 ? 'warn' : 'ok'}
                hint={t(summary.approvals.pendingToDecide > 0 ? 'dash.approvals.waiting' : 'dash.approvals.none')}
              />
            )}
          </div>
        )}
      </section>

      {canAudit && (
        <section className="card" aria-labelledby="dash-activity">
          <div className="card__head">
            <h2 id="dash-activity" className="card__title">
              {t('dash.activity.title')}
            </h2>
            <Link to="/logs" className="card__link">
              {t('dash.activity.viewAll')}
            </Link>
          </div>
          {activityError ? (
            <p className="card__empty">{t('dash.activity.error')}</p>
          ) : activity === null ? (
            <ul className="activity" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <li key={i}>
                  <span className="skeleton" />
                </li>
              ))}
            </ul>
          ) : activity.length === 0 ? (
            <p className="card__empty">{t('dash.activity.empty')}</p>
          ) : (
            <ul className="activity">
              {activity.map((entry) => (
                <li key={entry.id}>
                  <span className="activity__dot" aria-hidden="true" />
                  <span className="activity__action mono">{entry.action}</span>
                  {entry.entity && <span className="chip">{entry.entity}</span>}
                  <time className="activity__time" dateTime={entry.createdAt}>
                    {relativeTime(entry.createdAt, lang)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ------------------------------------------------------ timetable */}
      <section aria-labelledby="dash-timetable" className="dash-group">
        <div className="section-head section-head--split">
          <div>
            <h2 id="dash-timetable" className="section-head__title">
              {t('dash.section.timetable')}
            </h2>
            <p className="section-head__hint">{t('dash.section.timetableHint')}</p>
          </div>
          <div className="page__actions">
            <Link className="btn" to="/timetable">
              {t('dash.action.open')}
            </Link>
            {solving ? (
              <button type="button" className="btn" onClick={stop}>
                {t('dash.action.stop')}
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => solve()}>
                {t('dash.action.solve')}
              </button>
            )}
          </div>
        </div>

        <div className="kpi-row">
          {kpis.map((kpi) => (
            <article className="kpi" key={kpi.key}>
              <span className="kpi__label">{t(kpi.key)}</span>
              <b className="kpi__value">{n(kpi.value)}</b>
            </article>
          ))}
          <article className="kpi">
            <span className="kpi__label">{t('dash.kpi.slots')}</span>
            <b className="kpi__value">{n(problem.timeslots.length)}</b>
            <small className="kpi__hint">
              {t('dash.kpi.slotsHint', {
                days: n(days.length),
                periods: n(problem.calendar.periodsPerDay),
              })}
            </small>
          </article>
        </div>

        <div className="card-row">
          <section className="card">
            <h3 className="card__title">{t('dash.status.title')}</h3>
            {!solution && !solving ? (
              <p className="card__empty">{t('dash.status.none')}</p>
            ) : (
              <>
                <p className={`verdict${feasible && !solving ? ' verdict--ok' : solving ? '' : ' verdict--bad'}`}>
                  <span className="score__dot" />
                  {solving
                    ? t('dash.status.solving')
                    : feasible
                      ? t('dash.status.success')
                      : t('dash.status.infeasible', { count: n(Math.abs(hard)) })}
                </p>
                <div className="stat-row">
                  <span>{t('dash.status.hard')}</span>
                  <b className={hard === 0 ? 'tone-ok' : 'tone-bad'}>{n(hard)}</b>
                </div>
                <div className="stat-row">
                  <span>{t('dash.status.soft')}</span>
                  <b>{n(soft)}</b>
                </div>
                <div className="stat-row">
                  <span>{t('dash.status.moves')}</span>
                  <b>{n(solving ? (progress?.iterations ?? 0) : (solution?.stats.iterations ?? 0))}</b>
                </div>
                <div className="stat-row">
                  <span>{t('dash.status.time')}</span>
                  <b>
                    {(
                      (solving ? (progress?.elapsedMs ?? 0) : (solution?.stats.elapsedMs ?? 0)) / 1000
                    ).toFixed(1)}
                    s
                  </b>
                </div>
              </>
            )}
          </section>

          <section className="card">
            <h3 className="card__title">{t('dash.week.title')}</h3>
            <div className="stat-row">
              <span>{t('dash.week.start')}</span>
              <b>{day(problem.calendar.weekStart)}</b>
            </div>
            <div className="stat-row">
              <span>{t('dash.week.days')}</span>
              <b>{n(days.length)}</b>
            </div>
            <div className="stat-row">
              <span>{t('dash.week.periods')}</span>
              <b>{n(problem.calendar.periodsPerDay)}</b>
            </div>
            <div className="stat-row">
              <span>{t('dash.week.dayRange', { from: hhmm(problem.calendar.dayStart), to: dayEnds })}</span>
              <b />
            </div>

            <h4 className="card__subtitle">{t('dash.week.breaks')}</h4>
            {problem.calendar.breaks.map((rule) => (
              <div className="break-line" key={rule.id}>
                <b>{rule.name}</b>
                <span className="chip">
                  {rule.kind === 'CLOCK' ? t('dash.breaks.clock') : t('dash.breaks.period')}
                </span>
                <span className="mono">
                  {rule.kind === 'CLOCK'
                    ? `${t('dash.breaks.afterPeriod', { period: n(rule.period) })} · ${t('dash.breaks.minutes', { minutes: n(rule.minutes) })}`
                    : t('dash.breaks.atPeriod', { period: n(rule.period) })}
                </span>
                {rule.kind === 'PERIOD' && (
                  <span className="break-line__groups">
                    {rule.classIds.length === 0
                      ? t('dash.breaks.allClasses')
                      : rule.classIds.map((id) => classLabel.get(id) ?? id).join('، ')}
                  </span>
                )}
              </div>
            ))}
          </section>
        </div>

        <section className="card">
          <h3 className="card__title">{t('dash.load.title')}</h3>
          <p className="card__hint">{t('dash.load.hint')}</p>
          <div className="load-grid">
            {cohorts.map((entry) => {
              const ratio = entry.capacity > 0 ? entry.scheduled / entry.capacity : 0
              const over = entry.scheduled > entry.capacity
              return (
                <div className="load" key={entry.group}>
                  <div className="load__head">
                    <span>{entry.group}</span>
                    <b className={over ? 'is-over' : undefined}>
                      {n(entry.scheduled)}/{n(entry.capacity)}
                    </b>
                  </div>
                  <div
                    className="meter"
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={entry.capacity}
                    aria-valuenow={entry.scheduled}
                    aria-label={entry.group}
                  >
                    <i className={over ? 'is-over' : undefined} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                  </div>
                  {over && <small className="load__warn">{t('dash.load.over')}</small>}
                </div>
              )
            })}
          </div>
        </section>
      </section>
    </div>
  )
}
