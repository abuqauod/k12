import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { sampleFleet } from '../domain/fleet'
import type { RunDirection } from '../domain/students'
import { demandByStop } from '../domain/students'
import { useFleetSolver } from '../lib/useFleetSolver'
import { buildMatrix } from '../lib/routing'
import type { TravelMatrix } from '../lib/routing'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { RouteMap, routeColour } from '../components/RouteMap'
import { useApp } from '../state/AppContext'

const BUDGETS = [3000, 8000, 20000]

export function RoutesPage() {
  const { t, n } = useI18n()
  const { fleet, setFleet, students } = useApp()
  const { solution, progress, solving, error, run, stop } = useFleetSolver()

  const [budget, setBudget] = useState(8000)
  const [focusBusId, setFocusBusId] = useState<string | null>(null)
  const [direction, setDirection] = useState<RunDirection>('MORNING')
  const [matrix, setMatrix] = useState<TravelMatrix | null>(null)

  /** Riders for the selected run only — two-way plus that direction's one-ways. */
  const demand = useMemo(() => {
    const counts = demandByStop(students, direction)
    return fleet.stops.map((stop) => counts.get(stop.id) ?? 0)
  }, [students, direction, fleet.stops])

  const riders = useMemo(() => demand.reduce((sum, value) => sum + value, 0), [demand])

  /**
   * The matrix is fetched per set of stops, not per solve, so a whole
   * simulated-annealing run costs one OSRM call — which is what makes real
   * road distances affordable here.
   */
  const solveNow = useCallback(
    async (seed: number, budgetMs: number) => {
      const costs =
        matrix && matrix.size === fleet.stops.length + 1
          ? matrix
          : await buildMatrix(fleet.depot, fleet.stops, fleet.settings).then((built) => {
              setMatrix(built)
              return built
            })
      run(
        fleet,
        demand,
        { size: costs.size, minutes: costs.minutes, km: costs.km },
        budgetMs,
        seed,
      )
    },
    [fleet, demand, matrix, run],
  )

  // Stops changed, so any cached matrix is stale.
  useEffect(() => {
    setMatrix(null)
  }, [fleet.stops, fleet.settings.osrmUrl])

  // Solve once on arrival so the map is never blank.
  useEffect(() => {
    void solveNow(20260906, 3000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction])

  const busById = useMemo(() => new Map(fleet.buses.map((bus) => [bus.id, bus])), [fleet.buses])
  const stopById = useMemo(() => new Map(fleet.stops.map((s) => [s.id, s])), [fleet.stops])

  const totalStudents = students.filter((s) => s.active && s.transportMode !== 'NONE').length
  const totalSeats = fleet.buses.reduce((sum, bus) => sum + bus.seats, 0)

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span>
            <h1 className="brand__title">{t('nav.routes')}</h1>
            <p className="brand__subtitle">{t('fleet.subtitle')}</p>
          </span>
        </div>

        <div className="header__spacer" />

        <div className="header__controls">
          <span
            className={`score${
              solving ? ' score--solving' : solution?.status === 'SUCCESS' ? ' score--ok' : solution ? ' score--bad' : ''
            }`}
          >
            <span className="score__dot" />
            {solution
              ? t('fleet.score', {
                  km: n(Math.round(solution.totals.distanceKm)),
                  buses: n(solution.totals.busesUsed),
                })
              : t('header.notSolved')}
          </span>

          <div className="segmented" role="group" aria-label={t('fleet.direction')}>
            {(['MORNING', 'EVENING'] as RunDirection[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={direction === option}
                onClick={() => setDirection(option)}
              >
                {t(`fleet.direction.${option}` as TranslationKey)}
              </button>
            ))}
          </div>

          <select
            className="select"
            value={budget}
            onChange={(event) => setBudget(Number(event.target.value))}
            aria-label={t('header.budget', { seconds: n(budget / 1000) })}
          >
            {BUDGETS.map((value) => (
              <option key={value} value={value}>
                {t('header.budget', { seconds: n(value / 1000) })}
              </option>
            ))}
          </select>

          {solving ? (
            <button type="button" className="btn" onClick={stop}>
              {t('header.stop')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void solveNow(Date.now() & 0x7fffffff, budget)}
            >
              {t('fleet.optimise')}
            </button>
          )}

          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setFleet(sampleFleet())
              setMatrix(null)
              setFocusBusId(null)
            }}
          >
            {t('header.reset')}
          </button>
        </div>
      </header>

      <div className="workspace workspace--routes">
        <aside className="column column--left">
          <div className="panel">
            <div className="panel__head">
              <h3 className="panel__title">{t('fleet.fleetTitle')}</h3>
            </div>
            <div className="stat-row">
              <span>{t('fleet.riders')}</span>
              <b>{n(riders)}</b>
            </div>
            <div className="stat-row">
              <span>{t('fleet.students')}</span>
              <b>{n(totalStudents)}</b>
            </div>
            <div className="stat-row">
              <span>{t('fleet.seats')}</span>
              <b style={{ color: totalSeats < riders ? 'var(--bad)' : undefined }}>
                {n(totalSeats)}
              </b>
            </div>
            <div className="stat-row">
              <span>{t('fleet.stops')}</span>
              <b>{n(fleet.stops.length)}</b>
            </div>
            {totalSeats < riders && (
              <p className="card__hint" style={{ color: 'var(--bad)', margin: '8px 0 0' }}>
                {t('fleet.notEnoughSeats', { short: n(riders - totalSeats) })}
              </p>
            )}
          </div>

          <div className="panel">
            <div className="panel__head">
              <h3 className="panel__title">{t('fleet.rules')}</h3>
            </div>
            <div className="stat-row">
              <span>{t('fleet.maxRide')}</span>
              <b>{n(fleet.settings.maxRideMinutes)} min</b>
            </div>
            <div className="stat-row">
              <span>{t('fleet.bell')}</span>
              <b>{fleet.settings.bellTime.slice(0, 5)}</b>
            </div>
            <div className="stat-row">
              <span>{t('fleet.matrixSource')}</span>
              <b style={{ color: matrix?.source === 'osrm' ? 'var(--ok)' : 'var(--warn)' }}>
                {t(
                  matrix
                    ? (`fleet.matrix.${matrix.source}` as TranslationKey)
                    : 'fleet.matrix.haversine',
                )}
              </b>
            </div>
            {matrix?.note && (
              <p className="card__hint" style={{ color: 'var(--warn)', margin: '8px 0 0' }}>
                {t('fleet.matrixNote', { note: matrix.note })}
              </p>
            )}
            <div className="page__actions" style={{ marginBlockStart: 10 }}>
              <Link className="btn btn--sm" to="/settings">
                {t('fleet.editRules')}
              </Link>
            </div>
          </div>

          <div className="panel">
            <div className="panel__head">
              <h3 className="panel__title">{t('fleet.buses')}</h3>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('fleet.bus')}</th>
                  <th style={{ width: 62 }}>{t('fleet.seatsShort')}</th>
                </tr>
              </thead>
              <tbody>
                {fleet.buses.map((bus, index) => (
                  <tr key={bus.id}>
                    <td>
                      <span
                        className="route-swatch"
                        style={{ background: routeColour(index) }}
                        aria-hidden="true"
                      />
                      <input
                        className="cell-input"
                        value={bus.name}
                        onChange={(event) =>
                          setFleet({
                            ...fleet,
                            buses: fleet.buses.map((b) =>
                              b.id === bus.id ? { ...b, name: event.target.value } : b,
                            ),
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        className="cell-input cell-input--num"
                        type="number"
                        min={1}
                        value={bus.seats}
                        onChange={(event) =>
                          setFleet({
                            ...fleet,
                            buses: fleet.buses.map((b) =>
                              b.id === bus.id
                                ? { ...b, seats: Math.max(1, Number(event.target.value) || 1) }
                                : b,
                            ),
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>

        <main className="column column--center column--map">
          <RouteMap
            problem={fleet}
            solution={solution}
            focusBusId={focusBusId}
            onSelectBus={(busId) => setFocusBusId((current) => (current === busId ? null : busId))}
          />
        </main>

        <aside className="column column--right">
          <div className="panel">
            <div className="panel__head">
              <h3 className="panel__title">{t('fleet.routes')}</h3>
              {solving && <span className="chip">{t('inspector.running')}</span>}
            </div>

            {error && (
              <div className="empty-state" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>
                {error}
              </div>
            )}

            {solution && (
              <>
                <div className="stat-row">
                  <span>{t('fleet.totalDistance')}</span>
                  <b>{n(solution.totals.distanceKm)} km</b>
                </div>
                <div className="stat-row">
                  <span>{t('fleet.busesUsed')}</span>
                  <b>
                    {n(solution.totals.busesUsed)}/{n(fleet.buses.length)}
                  </b>
                </div>
                <div className="stat-row">
                  <span>{t('inspector.moves')}</span>
                  <b>{n(solving ? (progress?.iterations ?? 0) : solution.stats.iterations)}</b>
                </div>
              </>
            )}
          </div>

          {solution?.routes.map((route, index) => {
            const bus = busById.get(route.busId)
            if (!bus || route.legs.length === 0) return null
            const active = focusBusId === route.busId
            return (
              <button
                type="button"
                key={route.busId}
                className={`route-card${active ? ' route-card--active' : ''}`}
                onClick={() => setFocusBusId(active ? null : route.busId)}
              >
                <span className="route-card__head">
                  <span className="route-swatch" style={{ background: routeColour(index) }} />
                  <b>{bus.name}</b>
                  <span className="mono">
                    {n(route.load)}/{n(bus.seats)}
                  </span>
                </span>
                <span className="route-card__meta">
                  {t('fleet.routeMeta', {
                    km: n(Math.round(route.distanceKm * 10) / 10),
                    minutes: n(Math.round(route.durationMinutes)),
                    stops: n(route.legs.length),
                  })}
                </span>
                <span className="route-card__meta">
                  {t('fleet.departArrive', {
                    depart: route.departAt,
                    arrive: route.arrivalAtSchool,
                  })}
                </span>
                {active && (
                  <ol className="route-card__stops">
                    {route.legs.map((leg) => (
                      <li key={leg.stopId}>
                        <span>{stopById.get(leg.stopId)?.name ?? leg.stopId}</span>
                        <span className="mono">
                          +{n(Math.round(leg.arrivalMinutes))}m · {n(leg.loadAfter)}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </button>
            )
          })}

          {solution && solution.violations.length > 0 && (
            <div className="panel">
              <div className="panel__head">
                <h3 className="panel__title">{t('inspector.violations')}</h3>
              </div>
              {solution.violations.slice(0, 30).map((violation, index) => (
                <div
                  className="violation"
                  data-level={violation.level}
                  key={`${violation.constraint}-${index}`}
                >
                  <span className="violation__head">
                    <span>{t(`fleet.constraint.${violation.constraint}` as TranslationKey)}</span>
                    <span className="violation__penalty">−{n(Math.round(violation.penalty))}</span>
                  </span>
                  <span className="violation__body">
                    {t(violation.messageKey as TranslationKey, violation.messageParams)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {solution && solution.violations.length === 0 && (
            <div className="panel">
              <div className="empty-state">{t('fleet.allGood')}</div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
