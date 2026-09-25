import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { FleetProblem } from '../domain/fleet'
import type { RunDirection } from '../domain/students'
import {
  DEFAULT_OUTLIER_THRESHOLD_M,
  buildDoorToDoorStops,
  computeStopLink,
  findOutliers,
} from '../domain/students'
import { updateStudent } from '../lib/studentsApi'
import { useFleetSolver } from '../lib/useFleetSolver'
import { buildMatrix } from '../lib/routing'
import type { TravelMatrix } from '../lib/routing'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { RouteMap, routeColour } from '../components/RouteMap'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'

const BUDGETS = [3000, 8000, 20000]

const ICONS = {
  riders: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 20v-1a6 6 0 0 1 12 0v1M15 20v-.5a4.5 4.5 0 0 1 6-4.2',
  seat: 'M4 17h16M6 17V9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8M7 17v3M17 17v3M6 12h12',
  stop: 'M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10Zm0-8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7',
}

/** A read-only summary tile (the dashboard's tiles are links; these are not). */
function Tile(props: { icon: string; label: string; value: ReactNode; hint?: ReactNode; tone?: 'neutral' | 'ok' | 'bad' }) {
  return (
    <div className={`stat-tile stat-tile--${props.tone ?? 'neutral'}`}>
      <span className="stat-tile__icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={props.icon} />
        </svg>
      </span>
      <span className="stat-tile__label">{props.label}</span>
      <b className="stat-tile__value">{props.value}</b>
      {props.hint && <span className="stat-tile__hint">{props.hint}</span>}
    </div>
  )
}

export function RoutesPage() {
  const { t, n } = useI18n()
  const {
    fleet,
    transportLoading,
    buses,
    setBuses,
    stops,
    setStops,
    createBus: apiCreateBus,
    updateBus: apiUpdateBus,
    removeBus: apiRemoveBus,
    createStop: apiCreateStop,
    updateStop: apiUpdateStop,
    removeStop: apiRemoveStop,
    students,
    setStudents,
  } = useApp()
  const { getAccessToken } = useAuth()
  const { solution, progress, solving, error, run, stop } = useFleetSolver()

  const [budget, setBudget] = useState(8000)
  const [focusBusId, setFocusBusId] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const [highlightStopId, setHighlightStopId] = useState<string | null>(null)
  const stopRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})

  // Deep-links from GlobalSearch: ?bus=<id> reuses the existing focus-bus
  // state; ?stop=<id> scrolls to and briefly highlights that stop's row
  // (stops have no separate detail view to focus instead).
  useEffect(() => {
    const busId = searchParams.get('bus')
    const stopId = searchParams.get('stop')
    if (!busId && !stopId) return
    // Wait for the fleet to actually contain the target before consuming
    // the param — otherwise a slow-loading fleet would silently drop the
    // deep link the first time this effect runs.
    const busReady = !busId || fleet.buses.some((b) => b.id === busId)
    const stopReady = !stopId || fleet.stops.some((s) => s.id === stopId)
    if (!busReady || !stopReady) return
    if (busId) setFocusBusId(busId)
    if (stopId) {
      stopRowRefs.current[stopId]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightStopId(stopId)
      setTimeout(() => setHighlightStopId(null), 1600)
    }
    setSearchParams(
      (prev) => {
        prev.delete('bus')
        prev.delete('stop')
        return prev
      },
      { replace: true },
    )
  }, [fleet.buses, fleet.stops, searchParams, setSearchParams])
  const [direction, setDirection] = useState<RunDirection>('MORNING')
  const [matrix, setMatrix] = useState<TravelMatrix | null>(null)
  const [matrixKey, setMatrixKey] = useState<string | null>(null)
  const [lineStyle, setLineStyle] = useState<'straight' | 'route'>('straight')
  // The exact stops/problem a solve actually ran against — includes any
  // synthetic door-to-door nodes, so the map and route-card list can
  // resolve every leg's stopId, real or synthetic.
  const [effectiveProblem, setEffectiveProblem] = useState<FleetProblem>(fleet)

  const thresholdM = fleet.settings.outlierThresholdMeters ?? DEFAULT_OUTLIER_THRESHOLD_M
  const doorToDoorEnabled = fleet.settings.doorToDoorEnabled ?? true

  /** Riders for the selected run only — two-way plus that direction's
   * one-ways — with any outlier's demand moved to their own synthetic
   * door-to-door node instead of their (mismatched) assigned stop. */
  const { stops: solveStops, demand } = useMemo(
    () => buildDoorToDoorStops(fleet.stops, students, direction, thresholdM, doorToDoorEnabled),
    [fleet.stops, students, direction, thresholdM, doorToDoorEnabled],
  )

  const riders = useMemo(() => demand.reduce((sum, value) => sum + value, 0), [demand])

  const stopLinks = useMemo(() => {
    const stopById = new Map(fleet.stops.map((s) => [s.id, s]))
    return students.map((student) => computeStopLink(student, stopById, fleet.stops, thresholdM))
  }, [students, fleet.stops, thresholdM])

  const outliers = useMemo(
    () => findOutliers(students, fleet.stops, thresholdM),
    [students, fleet.stops, thresholdM],
  )
  const studentById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students])

  const solveMatrixKey = useMemo(() => solveStops.map((s) => s.id).join('|'), [solveStops])

  /**
   * The matrix is fetched per set of stops, not per solve, so a whole
   * simulated-annealing run costs one OSRM call — which is what makes real
   * road distances affordable here. Keyed off the actual node id list, not
   * just a count, so a same-length-but-different-node-set solve (an
   * outlier swapped in or out without the real stop count changing) still
   * detects the matrix as stale.
   */
  const solveNow = useCallback(
    async (seed: number, budgetMs: number) => {
      const costs =
        matrix && matrixKey === solveMatrixKey
          ? matrix
          : await buildMatrix(fleet.depot, solveStops, fleet.settings).then((built) => {
              setMatrix(built)
              setMatrixKey(solveMatrixKey)
              return built
            })
      const problem: FleetProblem = { ...fleet, stops: solveStops }
      setEffectiveProblem(problem)
      run(
        problem,
        demand,
        { size: costs.size, minutes: costs.minutes, km: costs.km },
        budgetMs,
        seed,
      )
    },
    [fleet, solveStops, demand, matrix, matrixKey, solveMatrixKey, run],
  )

  // The node set changed, so any cached matrix is stale.
  useEffect(() => {
    setMatrix(null)
    setMatrixKey(null)
  }, [solveMatrixKey, fleet.settings.osrmUrl])

  const assignNearestStop = async (studentId: string, nearestStopId: string | null) => {
    if (!nearestStopId) return
    const res = await updateStudent(getAccessToken, studentId, { stopId: nearestStopId })
    if (res.kind === 'ok') setStudents(students.map((s) => (s.id === studentId ? res.data : s)))
  }

  // Solve once on arrival so the map is never blank.
  useEffect(() => {
    void solveNow(20260906, 3000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction])

  const busById = useMemo(() => new Map(fleet.buses.map((bus) => [bus.id, bus])), [fleet.buses])
  // Resolved against the problem actually solved (real stops + any
  // synthetic door-to-door nodes), not the raw editable fleet — a solved
  // route's legs can reference a synthetic node's id.
  const stopById = useMemo(
    () => new Map(effectiveProblem.stops.map((s) => [s.id, s])),
    [effectiveProblem.stops],
  )

  const totalStudents = students.filter((s) => s.active && s.transportMode !== 'NONE').length
  const totalSeats = fleet.buses.reduce((sum, bus) => sum + bus.seats, 0)

  // Debounced per-row save for the bus/stop tables' text and number cells —
  // rapid keystrokes coalesce into one PATCH per row, not one per
  // character. The local `setBuses`/`setStops` call gives instant feedback
  // (typing feels the same as the old local-only draft did); the API call
  // is what actually persists it. Same idiom as StudentsPage.tsx's own
  // per-row debounced save.
  const busTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const busPending = useRef<Record<string, Partial<{ name: string; seats: number }>>>({})
  const scheduleBusSave = (id: string, changes: Partial<{ name: string; seats: number }>) => {
    busPending.current[id] = { ...busPending.current[id], ...changes }
    clearTimeout(busTimers.current[id])
    busTimers.current[id] = setTimeout(() => {
      const pending = busPending.current[id]
      delete busPending.current[id]
      if (pending) void apiUpdateBus(id, pending)
    }, 600)
  }
  const patchBus = (id: string, changes: Partial<{ name: string; seats: number }>) => {
    setBuses(buses.map((b) => (b.id === id ? { ...b, ...changes } : b)))
    scheduleBusSave(id, changes)
  }

  const stopTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const stopPending = useRef<Record<string, Partial<{ name: string; lat: number; lng: number }>>>({})
  const scheduleStopSave = (id: string, changes: Partial<{ name: string; lat: number; lng: number }>) => {
    stopPending.current[id] = { ...stopPending.current[id], ...changes }
    clearTimeout(stopTimers.current[id])
    stopTimers.current[id] = setTimeout(() => {
      const pending = stopPending.current[id]
      delete stopPending.current[id]
      if (pending) void apiUpdateStop(id, pending)
    }, 600)
  }
  // `pinnedBusId` is a discrete select, not continuous typing — no
  // debounce, and no local pre-merge with any pending text edit needed.
  const patchStop = (id: string, changes: Partial<{ name: string; lat: number; lng: number; pinnedBusId: string | null }>) => {
    setStops(stops.map((s) => (s.id === id ? { ...s, ...changes } : s)))
    if ('pinnedBusId' in changes) void apiUpdateStop(id, { pinnedBusId: changes.pinnedBusId })
    else scheduleStopSave(id, changes)
  }

  useEffect(
    () => () => {
      // Flush anything still pending rather than lose it on navigation.
      for (const id of Object.keys(busTimers.current)) {
        clearTimeout(busTimers.current[id])
        const pending = busPending.current[id]
        if (pending) void apiUpdateBus(id, pending)
      }
      for (const id of Object.keys(stopTimers.current)) {
        clearTimeout(stopTimers.current[id])
        const pending = stopPending.current[id]
        if (pending) void apiUpdateStop(id, pending)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const addBus = () => void apiCreateBus({ name: t('fleet.newBus'), seats: 30 })

  const handleRemoveBus = (busId: string) => {
    void apiRemoveBus(busId)
    if (focusBusId === busId) setFocusBusId(null)
  }

  const addStop = () =>
    void apiCreateStop({ name: t('fleet.newStop'), lat: fleet.depot.lat, lng: fleet.depot.lng })

  const handleRemoveStop = (stopId: string) => void apiRemoveStop(stopId)

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

          <div className="segmented" role="group" aria-label={t('fleet.lineStyle')}>
            {(['straight', 'route'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={lineStyle === option}
                onClick={() => setLineStyle(option)}
              >
                {t(`fleet.lineStyle.${option}` as TranslationKey)}
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
        </div>
      </header>

      <div className="page routes-page">
        {transportLoading && <p className="card__hint">{t('fleet.loading')}</p>}

        <section aria-label={t('fleet.fleetTitle')} className="tile-grid routes-kpis">
          <Tile icon={ICONS.riders} label={t('fleet.riders')} value={n(riders)} hint={t('fleet.studentsHint', { count: n(totalStudents) })} />
          <Tile
            icon={ICONS.seat}
            label={t('fleet.seats')}
            value={n(totalSeats)}
            tone={totalSeats < riders ? 'bad' : 'neutral'}
            hint={totalSeats < riders ? t('fleet.notEnoughSeats', { short: n(riders - totalSeats) }) : t('fleet.busCount', { count: n(fleet.buses.length) })}
          />
          <Tile icon={ICONS.stop} label={t('fleet.stops')} value={n(fleet.stops.length)} />
          <Tile
            icon={ICONS.route}
            label={t('fleet.totalDistance')}
            value={solution ? `${n(Math.round(solution.totals.distanceKm))} km` : '—'}
            hint={
              solution
                ? t('fleet.busesUsedOf', { used: n(solution.totals.busesUsed), total: n(fleet.buses.length) })
                : t('header.notSolved')
            }
            tone={!solution ? 'neutral' : solution.violations.some((v) => v.level === 'HARD') ? 'bad' : 'ok'}
          />
        </section>

        <section className="card routes-map" aria-label={t('fleet.routes')}>
          <RouteMap
            problem={solution ? effectiveProblem : fleet}
            solution={solution}
            focusBusId={focusBusId}
            onSelectBus={(busId) => setFocusBusId((current) => (current === busId ? null : busId))}
            lineStyle={lineStyle}
            students={students}
            stopLinks={stopLinks}
          />
        </section>

        <section className="routes-section" aria-labelledby="routes-list">
          <div className="section-head section-head--split">
            <div>
              <h2 id="routes-list" className="section-head__title">
                {t('fleet.routes')}
              </h2>
              <p className="section-head__hint">{t('fleet.routesHint')}</p>
            </div>
            {solution && (
              <span className="card__hint">
                {solving && <span className="chip">{t('inspector.running')}</span>}{' '}
                {t('inspector.moves')}: {n(solving ? (progress?.iterations ?? 0) : solution.stats.iterations)}
              </span>
            )}
          </div>

          {error && (
            <div className="empty-state" style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>
              {error}
            </div>
          )}
          {!solution && !error && <div className="empty-state">{solving ? t('inspector.running') : t('header.notSolved')}</div>}

          <div className="route-grid">
            {solution?.routes.map((route, index) => {
              const bus = busById.get(route.busId)
              if (!bus || route.legs.length === 0) return null
              const active = focusBusId === route.busId
              return (
                <button
                  type="button"
                  key={route.busId}
                  className={`route-card${active ? ' route-card--active' : ''}`}
                  aria-pressed={active}
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
          </div>
        </section>

        <section className="routes-section" aria-labelledby="routes-issues">
          <div className="section-head">
            <h2 id="routes-issues" className="section-head__title">
              {t('fleet.issues')}
            </h2>
          </div>
          <div className="routes-stack">
            {solution && (
              <div className="card">
                <div className="card__head">
                  <h3 className="card__title">{t('inspector.violations')}</h3>
                  {solution.violations.length > 0 && <span className="chip">{n(solution.violations.length)}</span>}
                </div>
                {solution.violations.length === 0 ? (
                  <div className="empty-state">{t('fleet.allGood')}</div>
                ) : (
                  solution.violations.slice(0, 30).map((violation, index) => (
                    <div className="violation" data-level={violation.level} key={`${violation.constraint}-${index}`}>
                      <span className="violation__head">
                        <span>{t(`fleet.constraint.${violation.constraint}` as TranslationKey)}</span>
                        <span className="violation__penalty">−{n(Math.round(violation.penalty))}</span>
                      </span>
                      <span className="violation__body">
                        {t(violation.messageKey as TranslationKey, violation.messageParams)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}

            <div className="card">
              <div className="card__head">
                <h3 className="card__title">{t('fleet.outliers')}</h3>
                {outliers.length > 0 && <span className="chip">{n(outliers.length)}</span>}
              </div>
              {outliers.length === 0 ? (
                <div className="empty-state">{t('fleet.outliers.empty')}</div>
              ) : (
                outliers.map((link) => {
                  const student = studentById.get(link.studentId)
                  if (!student) return null
                  const currentStop = link.stopId ? stopById.get(link.stopId) : null
                  const nearestStop = link.nearestStopId
                    ? fleet.stops.find((s) => s.id === link.nearestStopId)
                    : null
                  return (
                    <div className="stat-row" key={link.studentId} style={{ flexWrap: 'wrap', gap: 4 }}>
                      <span>
                        {student.givenName} {student.familyName}
                        <br />
                        <small className="card__hint">
                          {currentStop
                            ? t('fleet.outliers.distance', {
                                stop: currentStop.name,
                                distance: n(Math.round(link.distanceM ?? 0)),
                              })
                            : t('fleet.outliers.unassigned')}
                        </small>
                      </span>
                      {nearestStop ? (
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => void assignNearestStop(link.studentId, link.nearestStopId)}
                        >
                          {t('fleet.outliers.useNearest', { stop: nearestStop.name })}
                        </button>
                      ) : (
                        <small className="card__hint">{t('fleet.outliers.noNearby')}</small>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </section>

        <section className="routes-section" aria-labelledby="routes-setup">
          <div className="section-head">
            <h2 id="routes-setup" className="section-head__title">
              {t('fleet.setup')}
            </h2>
            <p className="section-head__hint">{t('fleet.setupHint')}</p>
          </div>
          <div className="routes-stack">
            <div className="card">
              <div className="card__head">
                <h3 className="card__title">{t('fleet.buses')}</h3>
                <button type="button" className="btn btn--sm" onClick={addBus}>
                  {t('fleet.addBus')}
                </button>
              </div>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('fleet.bus')}</th>
                      <th style={{ width: 110 }}>{t('fleet.seatsShort')}</th>
                      <th style={{ width: 44 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {fleet.buses.map((bus, index) => (
                      <tr key={bus.id}>
                        <td>
                          <span className="route-swatch" style={{ background: routeColour(index) }} aria-hidden="true" />
                          <input
                            className="cell-input"
                            value={bus.name}
                            aria-label={t('fleet.bus')}
                            onChange={(event) => patchBus(bus.id, { name: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="cell-input cell-input--num"
                            type="number"
                            min={1}
                            value={bus.seats}
                            aria-label={t('fleet.seatsShort')}
                            onChange={(event) =>
                              patchBus(bus.id, { seats: Math.max(1, Number(event.target.value) || 1) })
                            }
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => handleRemoveBus(bus.id)}
                            aria-label={`${t('fleet.removeBus')} ${bus.name}`}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="card__head">
                <h3 className="card__title">{t('fleet.stopsEditor')}</h3>
                <button type="button" className="btn btn--sm" onClick={addStop}>
                  {t('fleet.addStop')}
                </button>
              </div>
              <div className="table-scroll">
                <table className="table" style={{ minWidth: 520 }}>
                  <thead>
                    <tr>
                      <th>{t('fleet.stopName')}</th>
                      <th style={{ width: 130 }}>{t('fleet.stopLat')}</th>
                      <th style={{ width: 130 }}>{t('fleet.stopLng')}</th>
                      <th style={{ width: 170 }}>{t('fleet.pinnedBus')}</th>
                      <th style={{ width: 44 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {fleet.stops.map((stop) => (
                      <tr
                        key={stop.id}
                        ref={(el) => {
                          stopRowRefs.current[stop.id] = el
                        }}
                        className={stop.id === highlightStopId ? 'row--highlight' : undefined}
                      >
                        <td>
                          <input
                            className="cell-input"
                            value={stop.name}
                            aria-label={t('fleet.stopName')}
                            onChange={(event) => patchStop(stop.id, { name: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="cell-input cell-input--num"
                            type="number"
                            step="any"
                            value={stop.lat}
                            aria-label={t('fleet.stopLat')}
                            onChange={(event) => {
                              const value = Number(event.target.value)
                              if (!Number.isNaN(value)) patchStop(stop.id, { lat: value })
                            }}
                          />
                        </td>
                        <td>
                          <input
                            className="cell-input cell-input--num"
                            type="number"
                            step="any"
                            value={stop.lng}
                            aria-label={t('fleet.stopLng')}
                            onChange={(event) => {
                              const value = Number(event.target.value)
                              if (!Number.isNaN(value)) patchStop(stop.id, { lng: value })
                            }}
                          />
                        </td>
                        <td>
                          <select
                            className="cell-input"
                            value={stop.pinnedBusId ?? ''}
                            aria-label={t('fleet.pinnedBus')}
                            onChange={(event) => patchStop(stop.id, { pinnedBusId: event.target.value || null })}
                          >
                            <option value="">{t('fleet.pinnedBus.none')}</option>
                            {fleet.buses.map((bus) => (
                              <option key={bus.id} value={bus.id}>
                                {bus.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => handleRemoveStop(stop.id)}
                            aria-label={`${t('fleet.removeStop')} ${stop.name}`}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="card__head">
                <h3 className="card__title">{t('fleet.rules')}</h3>
                <Link className="btn btn--sm" to="/settings">
                  {t('fleet.editRules')}
                </Link>
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
                  {t(matrix ? (`fleet.matrix.${matrix.source}` as TranslationKey) : 'fleet.matrix.haversine')}
                </b>
              </div>
              {matrix?.note && (
                <p className="card__hint" style={{ color: 'var(--warn)', margin: '8px 0 0' }}>
                  {t('fleet.matrixNote', { note: matrix.note })}
                </p>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
