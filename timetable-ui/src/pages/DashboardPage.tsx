import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { schoolDays } from '../domain/calendar'
import { coverage, hhmm, naturalCompare, unique } from '../lib/view'
import { auditStudents } from '../domain/students'
import { listInvoices } from '../lib/financeApi'
import { formatMinorUnits } from '../domain/finance'

interface InvoiceSummary {
  outstanding: number
  overdue: number
  openTotal: number
}

export function DashboardPage() {
  const { t, n, day, lang } = useI18n()
  const { user, getAccessToken } = useAuth()
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

  const [invoiceSummary, setInvoiceSummary] = useState<InvoiceSummary | null>(null)
  const [financeLoading, setFinanceLoading] = useState(false)
  const [financeError, setFinanceError] = useState(false)

  useEffect(() => {
    if (!activeBranchId) {
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
  }, [activeBranchId, getAccessToken])

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

  const displayName = user ? (lang === 'ar' ? user.displayNameAr ?? user.displayName : user.displayName) : ''

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('dash.greeting', { name: displayName })}</h1>
          <p className="page__subtitle">{t('dash.subtitle')}</p>
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
            <button type="button" className="btn btn--primary" onClick={() => solve()}>
              {t('dash.action.solve')}
            </button>
          )}
        </div>
      </header>

      <section className="card">
        <h2 className="card__title">{t('dash.overview.title')}</h2>
        <p className="card__hint">{t('dash.overview.subtitle')}</p>
        {!activeBranchId ? (
          <p className="card__empty">{t('dash.overview.noBranch')}</p>
        ) : (
          <div className="card-row">
            <section className="card">
              <h3 className="card__subtitle">{t('dash.overview.students.title')}</h3>
              <div className="stat-row">
                <span>{t('dash.overview.students.active')}</span>
                <b>{n(activeStudents.length)}</b>
              </div>
              <div className="stat-row">
                <span>{t('dash.overview.students.attention')}</span>
                <b style={{ color: studentsNeedingAttention > 0 ? 'var(--bad)' : undefined }}>
                  {n(studentsNeedingAttention)}
                </b>
              </div>
            </section>

            <section className="card">
              <h3 className="card__subtitle">{t('dash.overview.transport.title')}</h3>
              {transportLoading ? (
                <p className="card__hint">{t('dash.overview.transport.loading')}</p>
              ) : (
                <>
                  <div className="stat-row">
                    <span>{t('dash.overview.transport.buses')}</span>
                    <b>{n(buses.length)}</b>
                  </div>
                  <div className="stat-row">
                    <span>{t('dash.overview.transport.stops')}</span>
                    <b>{n(stops.length)}</b>
                  </div>
                  <div className="stat-row">
                    <span>{t('dash.overview.transport.noStop')}</span>
                    <b style={{ color: studentsWithoutStop > 0 ? 'var(--bad)' : undefined }}>
                      {n(studentsWithoutStop)}
                    </b>
                  </div>
                </>
              )}
            </section>

            <section className="card">
              <h3 className="card__subtitle">{t('dash.overview.finance.title')}</h3>
              {financeLoading ? (
                <p className="card__hint">{t('dash.overview.finance.loading')}</p>
              ) : financeError || !invoiceSummary ? (
                <p className="card__empty">{t('dash.overview.finance.error')}</p>
              ) : (
                <>
                  <div className="stat-row">
                    <span>{t('dash.overview.finance.outstanding')}</span>
                    <b>{n(invoiceSummary.outstanding)}</b>
                  </div>
                  <div className="stat-row">
                    <span>{t('dash.overview.finance.overdue')}</span>
                    <b style={{ color: invoiceSummary.overdue > 0 ? 'var(--bad)' : undefined }}>
                      {n(invoiceSummary.overdue)}
                    </b>
                  </div>
                  <div className="stat-row">
                    <span>{t('dash.overview.finance.openTotal')}</span>
                    <b>{formatMinorUnits(invoiceSummary.openTotal)}</b>
                  </div>
                </>
              )}
            </section>
          </div>
        )}
      </section>

      <section className="kpi-row">
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
      </section>

      <div className="card-row">
        <section className="card">
          <h2 className="card__title">{t('dash.status.title')}</h2>
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
                <b style={{ color: hard === 0 ? 'var(--ok)' : 'var(--bad)' }}>{n(hard)}</b>
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
          <h2 className="card__title">{t('dash.week.title')}</h2>
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

          <h3 className="card__subtitle">{t('dash.week.breaks')}</h3>
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
        <h2 className="card__title">{t('dash.load.title')}</h2>
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
                <div className="meter">
                  <i
                    style={{
                      width: `${Math.min(100, ratio * 100)}%`,
                      background: over ? 'var(--bad)' : 'var(--accent)',
                    }}
                  />
                </div>
                {over && <small className="load__warn">{t('dash.load.over')}</small>}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
