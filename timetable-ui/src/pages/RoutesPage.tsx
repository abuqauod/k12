import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { sampleFleet } from '../domain/fleet'
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
import { Splitter } from '../components/Splitter'
import { useMediaQuery } from '../lib/useMediaQuery'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'

const BUDGETS = [3000, 8000, 20000]

let busCounter = 0
let stopCounter = 0

const WIDTHS_KEY = 'fleet.layout'
// Wider than the timetable's side panels — the stops editor table (name,
// lat, lng, pinned bus) needs the room to stop scrolling horizontally.
const DEFAULT_LEFT = 380
const DEFAULT_RIGHT = 360
const MIN_LEFT = 280
const MAX_LEFT = 640
const MIN_RIGHT = 280
const MAX_RIGHT = 560
/** The map itself never shrinks past this, whatever the side panels do. */
const MIN_MAP = 360
const SPLITTER = 8

interface PanelWidths {
  left: number
  right: number
}

function readWidths(): PanelWidths {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY)
    if (!raw) return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT }
    const parsed = JSON.parse(raw) as Partial<PanelWidths>
    return {
      left: Number.isFinite(parsed.left) ? Number(parsed.left) : DEFAULT_LEFT,
      right: Number.isFinite(parsed.right) ? Number(parsed.right) : DEFAULT_RIGHT,
    }
  } catch {
    return { left: DEFAULT_LEFT, right: DEFAULT_RIGHT }
  }
}

export function RoutesPage() {
  const { t, n } = useI18n()
  const { fleet, setFleet, students, setStudents } = useApp()
  const { getAccessToken } = useAuth()
  const { solution, progress, solving, error, run, stop } = useFleetSolver()

  const [budget, setBudget] = useState(8000)
  const [focusBusId, setFocusBusId] = useState<string | null>(null)
  const [direction, setDirection] = useState<RunDirection>('MORNING')
  const [matrix, setMatrix] = useState<TravelMatrix | null>(null)
  const [matrixKey, setMatrixKey] = useState<string | null>(null)
  const [lineStyle, setLineStyle] = useState<'straight' | 'route'>('straight')
  // The exact stops/problem a solve actually ran against — includes any
  // synthetic door-to-door nodes, so the map and route-card list can
  // resolve every leg's stopId, real or synthetic.
  const [effectiveProblem, setEffectiveProblem] = useState<FleetProblem>(fleet)

  // Splitters appear as soon as there are two columns to divide — the right
  // column itself only exists above the wider breakpoint, matching
  // shell.css's `.workspace--routes` media rules.
  const roomy = useMediaQuery('(min-width: 861px)')
  const rightFits = useMediaQuery('(min-width: 1181px)')
  const workspaceRef = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<PanelWidths>(readWidths)
  const [workspaceWidth, setWorkspaceWidth] = useState(0)

  useEffect(() => {
    try {
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths))
    } catch {
      // Preference simply will not persist.
    }
  }, [widths])

  // Observed rather than read from the ref during render, so the clamp also
  // reacts to the sidebar collapsing — not just to window resizes.
  useLayoutEffect(() => {
    const element = workspaceRef.current
    if (!element) return
    setWorkspaceWidth(element.clientWidth)
    const observer = new ResizeObserver((entries) => {
      setWorkspaceWidth(entries[0].contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [roomy])

  /**
   * The hard limit is the map, not the panel: a panel may only grow while
   * the map still has MIN_MAP left, so it can never be squeezed to nothing.
   */
  const maxFor = useCallback(
    (side: 'left' | 'right') => {
      const ceiling = side === 'left' ? MAX_LEFT : MAX_RIGHT
      if (!workspaceWidth) return ceiling
      const other = side === 'left' ? (rightFits ? widths.right : 0) : widths.left
      const splitters = SPLITTER * (rightFits ? 2 : 1)
      return Math.max(
        side === 'left' ? MIN_LEFT : MIN_RIGHT,
        Math.min(ceiling, workspaceWidth - other - splitters - MIN_MAP),
      )
    },
    [workspaceWidth, rightFits, widths.left, widths.right],
  )

  const effectiveWidths = {
    left: Math.min(widths.left, maxFor('left')),
    right: Math.min(widths.right, maxFor('right')),
  }

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

  const addBus = () => {
    busCounter += 1
    const id = `BUS-NEW-${Date.now().toString(36)}-${busCounter}`
    setFleet({ ...fleet, buses: [...fleet.buses, { id, name: t('fleet.newBus'), seats: 30 }] })
  }

  const removeBus = (busId: string) => {
    setFleet({
      ...fleet,
      buses: fleet.buses.filter((b) => b.id !== busId),
      // A stop pinned to the bus being removed would otherwise point at a
      // bus that no longer exists — fall back to auto-assign.
      stops: fleet.stops.map((s) => (s.pinnedBusId === busId ? { ...s, pinnedBusId: null } : s)),
    })
    if (focusBusId === busId) setFocusBusId(null)
  }

  const addStop = () => {
    stopCounter += 1
    const id = `ST-NEW-${Date.now().toString(36)}-${stopCounter}`
    setFleet({
      ...fleet,
      stops: [
        ...fleet.stops,
        {
          id,
          name: t('fleet.newStop'),
          lat: fleet.depot.lat,
          lng: fleet.depot.lng,
          studentCount: 0,
          pinnedBusId: null,
        },
      ],
    })
  }

  const patchStop = (stopId: string, changes: Partial<(typeof fleet.stops)[number]>) => {
    setFleet({
      ...fleet,
      stops: fleet.stops.map((s) => (s.id === stopId ? { ...s, ...changes } : s)),
    })
  }

  const removeStop = (stopId: string) => {
    setFleet({ ...fleet, stops: fleet.stops.filter((s) => s.id !== stopId) })
  }

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

      <div
        ref={workspaceRef}
        className="workspace workspace--routes"
        style={
          roomy
            ? {
                gridTemplateColumns: rightFits
                  ? `${effectiveWidths.left}px ${SPLITTER}px minmax(${MIN_MAP}px, 1fr) ${SPLITTER}px ${effectiveWidths.right}px`
                  : `${effectiveWidths.left}px ${SPLITTER}px minmax(${MIN_MAP}px, 1fr)`,
              }
            : undefined
        }
      >
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
              <button type="button" className="btn btn--sm" onClick={addBus}>
                {t('fleet.addBus')}
              </button>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('fleet.bus')}</th>
                  <th style={{ width: 62 }}>{t('fleet.seatsShort')}</th>
                  <th style={{ width: 30 }} />
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
                    <td>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => removeBus(bus.id)}
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

          <div className="panel">
            <div className="panel__head">
              <h3 className="panel__title">{t('fleet.stopsEditor')}</h3>
              <button type="button" className="btn btn--sm" onClick={addStop}>
                {t('fleet.addStop')}
              </button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ minWidth: 420 }}>
                <thead>
                  <tr>
                    <th>{t('fleet.stopName')}</th>
                    <th style={{ width: 84 }}>{t('fleet.stopLat')}</th>
                    <th style={{ width: 84 }}>{t('fleet.stopLng')}</th>
                    <th style={{ width: 110 }}>{t('fleet.pinnedBus')}</th>
                    <th style={{ width: 30 }} />
                  </tr>
                </thead>
                <tbody>
                  {fleet.stops.map((stop) => (
                    <tr key={stop.id}>
                      <td>
                        <input
                          className="cell-input"
                          value={stop.name}
                          onChange={(event) => patchStop(stop.id, { name: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="cell-input cell-input--num"
                          type="number"
                          step="any"
                          value={stop.lat}
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
                          onChange={(event) =>
                            patchStop(stop.id, { pinnedBusId: event.target.value || null })
                          }
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
                          onClick={() => removeStop(stop.id)}
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
        </aside>

        {roomy && (
          <Splitter
            value={effectiveWidths.left}
            min={MIN_LEFT}
            max={maxFor('left')}
            defaultValue={DEFAULT_LEFT}
            onChange={(next) => setWidths((current) => ({ ...current, left: next }))}
            label={t('layout.resizeFleetPanel')}
          />
        )}

        <main className="column column--center column--map">
          <RouteMap
            problem={solution ? effectiveProblem : fleet}
            solution={solution}
            focusBusId={focusBusId}
            onSelectBus={(busId) => setFocusBusId((current) => (current === busId ? null : busId))}
            lineStyle={lineStyle}
            students={students}
            stopLinks={stopLinks}
          />
        </main>

        {roomy && rightFits && (
          <Splitter
            value={effectiveWidths.right}
            min={MIN_RIGHT}
            max={maxFor('right')}
            defaultValue={DEFAULT_RIGHT}
            invert
            onChange={(next) => setWidths((current) => ({ ...current, right: next }))}
            label={t('layout.resizeRoutesPanel')}
          />
        )}

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

          <div className="panel">
            <div className="panel__head">
              <h3 className="panel__title">{t('fleet.outliers')}</h3>
              {outliers.length > 0 && <span className="chip">{n(outliers.length)}</span>}
            </div>
            {outliers.length === 0 ? (
              <div className="empty-state">{t('fleet.outliers.empty')}</div>
            ) : (
              outliers.map((link) => {
                const student = studentById.get(link.studentId)
                if (!student) return null
                const currentStop = link.stopId ? stopById.get(link.stopId) : null
                const nearestStop = link.nearestStopId ? fleet.stops.find((s) => s.id === link.nearestStopId) : null
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
        </aside>
      </div>
    </div>
  )
}
