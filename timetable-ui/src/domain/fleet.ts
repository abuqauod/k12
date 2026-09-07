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

/* ------------------------------------------------------------------ sample */

const SCHOOL: Depot = {
  id: 'DEPOT',
  name: 'Northgate International School',
  lat: 31.9539,
  lng: 35.9106,
}

/** Deterministic, so the demo map looks the same on every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NEIGHBOURHOODS = [
  'Abdoun', 'Sweifieh', 'Deir Ghbar', 'Um Uthaina', 'Khalda', 'Tla al-Ali',
  'Jubeiha', 'Shmeisani', 'Rabieh', 'Dabouq', 'Marj al-Hamam', 'Naour',
  'Wadi Saqra', 'Jabal Amman', 'Weibdeh', 'Medina', 'Gardens', 'Sports City',
  'Mecca St', 'Zahran', 'Airport Rd', 'Bayader', 'Hummar', 'Sahab',
]

export function sampleFleet(): FleetProblem {
  const random = mulberry32(0x51e3)
  const stops: BusStop[] = NEIGHBOURHOODS.map((name, index) => {
    // Scatter stops in a ring 1.5–7 km around the school.
    const angle = (index / NEIGHBOURHOODS.length) * Math.PI * 2 + random() * 0.5
    const radiusKm = 1.5 + random() * 5.5
    const latOffset = (radiusKm / 111) * Math.cos(angle)
    const lngOffset = (radiusKm / (111 * Math.cos((SCHOOL.lat * Math.PI) / 180))) * Math.sin(angle)
    return {
      id: `ST-${String(index + 1).padStart(2, '0')}`,
      name,
      lat: Number((SCHOOL.lat + latOffset).toFixed(5)),
      lng: Number((SCHOOL.lng + lngOffset).toFixed(5)),
      studentCount: 4 + Math.floor(random() * 15),
    }
  })

  // Sized against the ~250 students the stops generate, with roughly 10%
  // headroom. A fleet with fewer seats than students can never be feasible,
  // and the panel says so before you waste a solve on it.
  const buses: Bus[] = [
    { id: 'BUS-1', name: 'Bus 1', seats: 45 },
    { id: 'BUS-2', name: 'Bus 2', seats: 45 },
    { id: 'BUS-3', name: 'Bus 3', seats: 45 },
    { id: 'BUS-4', name: 'Bus 4', seats: 32 },
    { id: 'BUS-5', name: 'Bus 5', seats: 32 },
    { id: 'BUS-6', name: 'Bus 6', seats: 32 },
    { id: 'BUS-7', name: 'Bus 7', seats: 24 },
    { id: 'BUS-8', name: 'Bus 8', seats: 24 },
  ]

  return {
    depot: SCHOOL,
    buses,
    stops,
    settings: {
      roadFactor: 1.35,
      averageSpeedKph: 32,
      dwellMinutes: 1.5,
      maxRideMinutes: 45,
      earliestDeparture: '06:30:00',
      bellTime: '08:30:00',
      arrivalBufferMinutes: 15,
      osrmUrl: 'http://localhost:5001',
    },
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

/** Minutes a bus needs to travel between two points. */
export function travelMinutes(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  settings: FleetSettings,
): number {
  const km = haversineKm(a, b) * settings.roadFactor
  return (km / Math.max(5, settings.averageSpeedKph)) * 60
}
