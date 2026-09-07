import type {
  FleetProblem,
  FleetSolution,
  FleetViolation,
  RouteLeg,
  VehicleRoute,
} from '../../domain/fleet'
import { haversineKm, toClock, toMinutes } from '../../domain/fleet'

/** Flat, DIRECTIONAL cost arrays indexed `i * size + j`; node 0 is the school. */
export interface TravelCosts {
  size: number
  minutes: Float64Array
  km: Float64Array
}

export interface VrpOptions {
  /** Riders per stop for THIS run. Morning and afternoon differ. */
  demand: number[]
  /** Real road costs when available; straight-line is computed if omitted. */
  costs?: TravelCosts
  timeBudgetMs: number
  seed?: number
  onProgress?: (progress: { elapsedMs: number; iterations: number; best: number }) => void
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Routes as arrays of stop indices; index -1 in the matrix is the depot. */
type Plan = number[][]

interface Compiled {
  n: number
  buses: number
  seats: Int32Array
  demand: Int32Array
  /** Minutes between nodes; node 0 is the depot, stops are 1..n. */
  time: Float64Array
  dist: Float64Array
  dwell: number
  maxRide: number
  maxRouteMinutes: number
}

function compile(problem: FleetProblem, demand: number[], costs?: TravelCosts): Compiled {
  const { depot, stops, buses, settings } = problem
  const n = stops.length
  const size = n + 1
  const nodes = [depot, ...stops]

  let time: Float64Array
  let dist: Float64Array

  if (costs && costs.size === size) {
    // Road costs are asymmetric — one-ways and divided carriageways mean
    // A→B is not B→A — so they are used exactly as given, never mirrored.
    time = costs.minutes
    dist = costs.km
  } else {
    time = new Float64Array(size * size)
    dist = new Float64Array(size * size)
    const speed = Math.max(5, settings.averageSpeedKph)
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) {
        const km = haversineKm(nodes[i]!, nodes[j]!) * settings.roadFactor
        const minutes = (km / speed) * 60
        dist[i * size + j] = km
        dist[j * size + i] = km
        time[i * size + j] = minutes
        time[j * size + i] = minutes
      }
    }
  }

  const latest =
    toMinutes(settings.bellTime) - Math.max(0, settings.arrivalBufferMinutes)
  const maxRouteMinutes = Math.max(10, latest - toMinutes(settings.earliestDeparture))

  return {
    n,
    buses: buses.length,
    seats: Int32Array.from(buses.map((bus) => bus.seats)),
    demand: Int32Array.from(stops.map((_, i) => Math.max(0, demand[i] ?? 0))),
    time,
    dist,
    dwell: Math.max(0, settings.dwellMinutes),
    maxRide: Math.max(1, settings.maxRideMinutes),
    maxRouteMinutes,
  }
}

/** Walk one route, returning its cost and how badly it breaks the rules. */
function evaluateRoute(model: Compiled, route: number[], busIndex: number) {
  const size = model.n + 1
  let clock = 0
  let km = 0
  let load = 0
  let previous = 0

  const arrival: number[] = []
  for (const stop of route) {
    const node = stop + 1
    clock += model.time[previous * size + node]!
    km += model.dist[previous * size + node]!
    arrival.push(clock)
    load += model.demand[stop]!
    clock += model.dwell
    previous = node
  }
  clock += model.time[previous * size]!
  km += model.dist[previous * size]!

  const overCapacity = Math.max(0, load - model.seats[busIndex]!)
  const overTime = Math.max(0, clock - model.maxRouteMinutes)

  let rideExcess = 0
  for (let i = 0; i < route.length; i++) {
    const ride = clock - arrival[i]!
    if (ride > model.maxRide) rideExcess += ride - model.maxRide
  }

  return { duration: clock, km, load, overCapacity, overTime, rideExcess, arrival }
}

function score(model: Compiled, plan: Plan) {
  let hard = 0
  let km = 0
  let used = 0

  for (let bus = 0; bus < plan.length; bus++) {
    const route = plan[bus]!
    if (route.length === 0) continue
    used++
    const result = evaluateRoute(model, route, bus)
    hard -= result.overCapacity
    // Minutes are scaled so a one-minute breach is not worth a whole student.
    hard -= result.overTime / 5
    hard -= result.rideExcess / 5
    km += result.km
  }

  // Fewer buses is better, but only as a tiebreaker against distance.
  return { hard, soft: -(km + used * 2) }
}

const scalar = (s: { hard: number; soft: number }) => s.hard * 1_000_000 + s.soft

/**
 * Cheapest-insertion construction: take the stop furthest from school first
 * (the hardest to place well) and insert each into the position that adds the
 * least driving, skipping buses that cannot take the load.
 */
function construct(model: Compiled, rand: () => number): Plan {
  const size = model.n + 1
  const plan: Plan = Array.from({ length: model.buses }, () => [])
  const loads = new Int32Array(model.buses)

  const order = Array.from({ length: model.n }, (_, i) => i)
    // A stop with no riders on this run is simply not on it.
    .filter((stop) => model.demand[stop]! > 0)
    .sort((a, b) => model.dist[(b + 1) * size]! - model.dist[(a + 1) * size]!)

  for (const stop of order) {
    let bestBus = -1
    let bestPos = 0
    let bestCost = Number.POSITIVE_INFINITY

    for (let bus = 0; bus < model.buses; bus++) {
      if (loads[bus]! + model.demand[stop]! > model.seats[bus]!) continue
      const route = plan[bus]!
      for (let pos = 0; pos <= route.length; pos++) {
        const before = pos === 0 ? 0 : route[pos - 1]! + 1
        const after = pos === route.length ? 0 : route[pos]! + 1
        const added =
          model.dist[before * size + (stop + 1)]! +
          model.dist[(stop + 1) * size + after]! -
          model.dist[before * size + after]!
        // Nudge toward emptier buses so one does not hoover up every stop.
        const cost = added + loads[bus]! * 0.01 + rand() * 0.001
        if (cost < bestCost) {
          bestCost = cost
          bestBus = bus
          bestPos = pos
        }
      }
    }

    // Nothing has room: put it on the emptiest bus and let the search or the
    // capacity violation surface the problem honestly.
    if (bestBus < 0) {
      let emptiest = 0
      for (let bus = 1; bus < model.buses; bus++) {
        if (loads[bus]! < loads[emptiest]!) emptiest = bus
      }
      bestBus = emptiest
      bestPos = plan[emptiest]!.length
    }

    plan[bestBus]!.splice(bestPos, 0, stop)
    loads[bestBus]! += model.demand[stop]!
  }

  return plan
}

const clone = (plan: Plan): Plan => plan.map((route) => route.slice())

export function solveFleet(problem: FleetProblem, options: VrpOptions): FleetSolution {
  const started = Date.now()
  const model = compile(problem, options.demand, options.costs)

  if (model.n === 0 || model.buses === 0) {
    return {
      status: model.n === 0 ? 'SUCCESS' : 'INFEASIBLE',
      score: { hard: model.n === 0 ? 0 : -model.n, soft: 0 },
      routes: [],
      unassignedStopIds: model.buses === 0 ? problem.stops.map((s) => s.id) : [],
      violations:
        model.buses === 0
          ? [
              {
                constraint: 'STOP_UNASSIGNED',
                level: 'HARD',
                penalty: model.n,
                messageKey: 'fleet.msg.noBuses',
                messageParams: {},
                stopIds: problem.stops.map((s) => s.id),
              },
            ]
          : [],
      totals: { distanceKm: 0, durationMinutes: 0, busesUsed: 0, students: 0 },
      stats: { iterations: 0, elapsedMs: Date.now() - started },
    }
  }

  const rand = mulberry32(options.seed ?? 0x7a11)
  let current = construct(model, rand)
  let currentScore = scalar(score(model, current))
  let best = clone(current)
  let bestScore = currentScore

  let temperature = 6
  let iterations = 0
  let lastReport = started

  for (;;) {
    const now = Date.now()
    if (now - started >= options.timeBudgetMs) break
    if (options.onProgress && now - lastReport >= 150) {
      lastReport = now
      options.onProgress({ elapsedMs: now - started, iterations, best: bestScore })
    }

    for (let block = 0; block < 500; block++) {
      iterations++
      const candidate = clone(current)
      const move = rand()

      if (move < 0.45) {
        // Relocate one stop to a new position, possibly on another bus.
        const from = pickNonEmpty(candidate, rand)
        if (from < 0) break
        const route = candidate[from]!
        const [stop] = route.splice((rand() * route.length) | 0, 1)
        const to = (rand() * candidate.length) | 0
        const target = candidate[to]!
        target.splice((rand() * (target.length + 1)) | 0, 0, stop!)
      } else if (move < 0.75) {
        // Swap a stop between two buses.
        const a = pickNonEmpty(candidate, rand)
        const b = pickNonEmpty(candidate, rand)
        if (a < 0 || b < 0) break
        const ra = candidate[a]!
        const rb = candidate[b]!
        const ia = (rand() * ra.length) | 0
        const ib = (rand() * rb.length) | 0
        const tmp = ra[ia]!
        ra[ia] = rb[ib]!
        rb[ib] = tmp
      } else {
        // 2-opt: reverse a segment, which untangles crossing legs.
        const bus = pickNonEmpty(candidate, rand)
        if (bus < 0) break
        const route = candidate[bus]!
        if (route.length < 3) continue
        let i = (rand() * route.length) | 0
        let j = (rand() * route.length) | 0
        if (i > j) [i, j] = [j, i]
        if (j - i < 1) continue
        const segment = route.slice(i, j + 1).reverse()
        route.splice(i, segment.length, ...segment)
      }

      const candidateScore = scalar(score(model, candidate))
      const delta = candidateScore - currentScore
      if (delta >= 0 || rand() < Math.exp(delta / temperature)) {
        current = candidate
        currentScore = candidateScore
        if (candidateScore > bestScore) {
          bestScore = candidateScore
          best = clone(candidate)
        }
      }
    }

    temperature = Math.max(0.4, temperature * 0.995)
  }

  return describe(problem, model, best, iterations, Date.now() - started)
}

function pickNonEmpty(plan: Plan, rand: () => number): number {
  const candidates: number[] = []
  for (let i = 0; i < plan.length; i++) if (plan[i]!.length > 0) candidates.push(i)
  if (candidates.length === 0) return -1
  return candidates[(rand() * candidates.length) | 0]!
}

/** Turns the winning plan into routes, clock times and readable violations. */
function describe(
  problem: FleetProblem,
  model: Compiled,
  plan: Plan,
  iterations: number,
  elapsedMs: number,
): FleetSolution {
  const { buses, stops, settings } = problem
  const violations: FleetViolation[] = []
  const routes: VehicleRoute[] = []
  const latestArrival = toMinutes(settings.bellTime) - settings.arrivalBufferMinutes

  let hard = 0
  let totalKm = 0
  let totalMinutes = 0
  let students = 0
  let used = 0

  plan.forEach((route, busIndex) => {
    const bus = buses[busIndex]!
    if (route.length === 0) {
      routes.push({
        busId: bus.id,
        legs: [],
        distanceKm: 0,
        durationMinutes: 0,
        load: 0,
        arrivalAtSchool: '—',
        departAt: '—',
      })
      return
    }

    used++
    const result = evaluateRoute(model, route, busIndex)
    const departAt = latestArrival - result.duration
    const legs: RouteLeg[] = route.map((stop, i) => ({
      stopId: stops[stop]!.id,
      arrivalMinutes: result.arrival[i]!,
      rideMinutes: result.duration - result.arrival[i]!,
      loadAfter: route.slice(0, i + 1).reduce((sum, s) => sum + model.demand[s]!, 0),
    }))

    totalKm += result.km
    totalMinutes += result.duration
    students += result.load

    if (result.overCapacity > 0) {
      hard -= result.overCapacity
      violations.push({
        constraint: 'BUS_CAPACITY',
        level: 'HARD',
        penalty: result.overCapacity,
        messageKey: 'fleet.msg.capacity',
        messageParams: { bus: bus.name, load: result.load, seats: bus.seats },
        busId: bus.id,
        stopIds: route.map((s) => stops[s]!.id),
      })
    }

    if (departAt < toMinutes(settings.earliestDeparture)) {
      const shortfall = Math.round(toMinutes(settings.earliestDeparture) - departAt)
      hard -= shortfall / 5
      violations.push({
        constraint: 'ARRIVE_BEFORE_BELL',
        level: 'HARD',
        penalty: shortfall,
        messageKey: 'fleet.msg.bell',
        messageParams: {
          bus: bus.name,
          minutes: shortfall,
          depart: toClock(departAt),
          earliest: settings.earliestDeparture.slice(0, 5),
        },
        busId: bus.id,
        stopIds: [],
      })
    }

    for (const leg of legs) {
      if (leg.rideMinutes > settings.maxRideMinutes) {
        const over = Math.round(leg.rideMinutes - settings.maxRideMinutes)
        hard -= over / 5
        violations.push({
          constraint: 'MAX_RIDE_TIME',
          level: 'HARD',
          penalty: over,
          messageKey: 'fleet.msg.rideTime',
          messageParams: {
            stop: stops.find((s) => s.id === leg.stopId)?.name ?? leg.stopId,
            minutes: Math.round(leg.rideMinutes),
            limit: settings.maxRideMinutes,
          },
          busId: bus.id,
          stopIds: [leg.stopId],
        })
      }
    }

    routes.push({
      busId: bus.id,
      legs,
      distanceKm: result.km,
      durationMinutes: result.duration,
      load: result.load,
      arrivalAtSchool: toClock(latestArrival),
      departAt: toClock(departAt),
    })
  })

  violations.sort((a, b) => b.penalty - a.penalty)

  return {
    status: hard === 0 ? 'SUCCESS' : 'INFEASIBLE',
    score: { hard: Math.round(hard * 10) / 10, soft: -Math.round(totalKm * 10) / 10 },
    routes,
    unassignedStopIds: [],
    violations,
    totals: {
      distanceKm: Math.round(totalKm * 10) / 10,
      durationMinutes: Math.round(totalMinutes),
      busesUsed: used,
      students,
    },
    stats: { iterations, elapsedMs },
  }
}
