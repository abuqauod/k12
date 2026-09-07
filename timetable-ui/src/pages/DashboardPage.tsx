import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import { schoolDays } from '../domain/calendar'
import { coverage, hhmm, naturalCompare, unique } from '../lib/view'

export function DashboardPage() {
  const { t, n, day, lang } = useI18n()
  const { user } = useAuth()
  const { problem, solution, solving, progress, solve, stop } = useApp()

  const teachers = useMemo(
    () => unique(problem.lessons.map((lesson) => lesson.teacher)).sort(naturalCompare),
    [problem.lessons],
  )
  const cohorts = useMemo(() => coverage(problem), [problem])
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

  const displayName = user ? (lang === 'ar' ? user.nameAr : user.name) : ''

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
                  {rule.studentGroups.length === 0
                    ? t('dash.breaks.allClasses')
                    : rule.studentGroups.join('، ')}
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
