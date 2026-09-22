/**
 * School bus routing — a capacitated vehicle routing problem with time limits.
 *
 * Morning model: each bus leaves the school, collects students at a sequence of
 * stops, and returns to the school before the bell. The afternoon run is the
 * same route reversed, so only one direction is solved.
 *
 * Planning entity: the assignment of stops to buses and the order within a bus.
 */

export interface Depot {
  id: string
  name: string
  lat: number
  lng: number
}

export interface BusStop {
  id: string
  name: string
  lat: number
  lng: number
  /** Students boarding here. Drives the capacity constraint. */
  studentCount: number
  /** Manually pinned to one bus — the solver treats this as a hard
   * constraint and never reassigns the stop to a different bus, only
   * optimising its position within that bus's route. Unset means the solver
   * picks the bus freely. */
  pinnedBusId?: string | null
  /** Present only on a synthetic node built for one outlier student's own
   * pin ("door-to-door" routing — see domain/students.ts's
   * `buildDoorToDoorStops`), never on a real, editable stop. Absent means a
   * real stop; never written into a persisted `FleetProblem.stops` or shown
   * in the stops editor table. */
  studentId?: string
}

export interface Bus {
  id: string
  name: string
  seats: number
}

export interface FleetSettings {
  /** Straight-line distance is multiplied by this to approximate road length. */
  roadFactor: number
  averageSpeedKph: number
  /** Minutes spent stationary at each stop. */
  dwellMinutes: number
  /** No child may ride longer than this, from their stop to the school. */
  maxRideMinutes: number
  /** Earliest a bus may leave the depot, "HH:MM:SS". */
  earliestDeparture: string
  /** First period start, from the timetable calendar. */
  bellTime: string
  /** Buses must be parked this many minutes before the bell. */
  arrivalBufferMinutes: number
  /** OSRM base url. Empty falls back to straight-line estimates. */
  osrmUrl: string
  /**
   * A student's own pin further than this from their assigned stop is
   * flagged "needs review" (RoutesPage's outliers panel) and, if
   * `doorToDoorEnabled`, routed to directly instead of at their stop.
   * Undefined on a fleet saved before this existed — callers fall back to
   * `DEFAULT_OUTLIER_THRESHOLD_M` (domain/students.ts).
   */
  outlierThresholdMeters?: number
  /** Master switch for door-to-door fallback routing of outlier students.
   * Undefined (a fleet saved before this existed) behaves as `true`. */
  doorToDoorEnabled?: boolean
}

export interface FleetProblem {
  depot: Depot
  buses: Bus[]
  stops: BusStop[]
  settings: FleetSettings
}

export interface RouteLeg {
  stopId: string
  /** Minutes after departure that the bus reaches this stop. */
  arrivalMinutes: number
  /** Minutes this stop's students spend on the bus. */
  rideMinutes: number
  loadAfter: number
}

export interface VehicleRoute {
  busId: string
  legs: RouteLeg[]
  distanceKm: number
  /** Depot back to depot. */
  durationMinutes: number
  load: number
  /** Clock time the bus reaches school, "HH:MM". */
  arrivalAtSchool: string
  departAt: string
}

export type FleetConstraintId =
  | 'STOP_UNASSIGNED'
  | 'BUS_CAPACITY'
  | 'MAX_RIDE_TIME'
  | 'ARRIVE_BEFORE_BELL'
  | 'TOTAL_DISTANCE'
  | 'BUSES_USED'

export interface FleetViolation {
  constraint: FleetConstraintId
  level: 'HARD' | 'SOFT'
  penalty: number
  messageKey: string
  messageParams: Record<string, string | number>
  busId?: string
  stopIds: string[]
}

export interface FleetSolution {
  status: 'SUCCESS' | 'INFEASIBLE' | 'IDLE'
  score: { hard: number; soft: number }
  routes: VehicleRoute[]
  unassignedStopIds: string[]
  violations: FleetViolation[]
  totals: { distanceKm: number; durationMinutes: number; busesUsed: number; students: number }
  stats: { iterations: number; elapsedMs: number }
}

export const FLEET_CONSTRAINT_META: Record<
  FleetConstraintId,
  { level: 'HARD' | 'SOFT'; labelKey: string }
> = {
  STOP_UNASSIGNED: { level: 'HARD', labelKey: 'fleet.constraint.unassigned' },
  BUS_CAPACITY: { level: 'HARD', labelKey: 'fleet.constraint.capacity' },
  MAX_RIDE_TIME: { level: 'HARD', labelKey: 'fleet.constraint.rideTime' },
  ARRIVE_BEFORE_BELL: { level: 'HARD', labelKey: 'fleet.constraint.bell' },
  TOTAL_DISTANCE: { level: 'SOFT', labelKey: 'fleet.constraint.distance' },
  BUSES_USED: { level: 'SOFT', labelKey: 'fleet.constraint.buses' },
}

/* --------------------------------------------------------------- assembly */
// `FleetProblem` — the shape the VRP solver and the map consume — is now
// assembled from the real transport backend's separate resources (buses,
// stops, per-branch settings) plus the live student roster, rather than
// being a single JSON blob that could hold bundled fake data. See
// state/AppContext.tsx for where this is called.

/** A branch's full transport settings row from the API — `FleetSettings`
 * plus the depot fields, which travel together over the wire (one PUT
 * /branches/:id/transport-settings) but are kept as separate `depot`/
 * `settings` objects in `FleetProblem`, matching how the solver and the map
 * have always consumed them. */
export interface TransportSettings extends FleetSettings {
  depotName: string
  depotLat: number
  depotLng: number
}

export function assembleFleetProblem(
  buses: Bus[],
  stops: BusStop[],
  settings: TransportSettings,
  studentCounts: Map<string, number>,
): FleetProblem {
  return {
    depot: { id: 'DEPOT', name: settings.depotName, lat: settings.depotLat, lng: settings.depotLng },
    buses,
    stops: stops.map((stop) => ({ ...stop, studentCount: studentCounts.get(stop.id) ?? 0 })),
    settings,
  }
}

/* ------------------------------------------------------------------- utils */

export const EARTH_RADIUS_KM = 6371

/** Great-circle distance. Multiplied by `roadFactor` to approximate roads. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = Math.PI / 180
  const dLat = (b.lat - a.lat) * toRad
  const dLng = (b.lng - a.lng) * toRad
  const lat1 = a.lat * toRad
  const lat2 = b.lat * toRad
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(':')
  return Number(h) * 60 + Number(m)
}

export function toClock(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

/** The closest real stop to a point, straight-line — `null` when there are
 * no stops to compare against. Used to suggest a stop when a student's pin
 * is placed (StudentDetailDialog) and to compute distance-to-assigned-stop
 * (domain/students.ts's `computeStopLink`). */
export function findNearestStop(
  point: { lat: number; lng: number },
  stops: BusStop[],
): { stop: BusStop; distanceM: number } | null {
  let best: { stop: BusStop; distanceM: number } | null = null
  for (const stop of stops) {
    const distanceM = haversineKm(point, stop) * 1000
    if (!best || distanceM < best.distanceM) best = { stop, distanceM }
  }
  return best
}

/** Minutes a bus needs to travel between two points. */
export function travelMinutes(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  settings: FleetSettings,
): number {
  const km = haversineKm(a, b) * settings.roadFactor
  return (km / Math.max(5, settings.averageSpeedKph)) * 60
}
