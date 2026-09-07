import type { BusStop, Depot, FleetSettings } from '../domain/fleet'
import { haversineKm } from '../domain/fleet'

/**
 * Travel cost between every pair of nodes, node 0 being the school.
 *
 * Stored as flat arrays indexed `i * size + j` and read DIRECTIONALLY: real
 * road networks are asymmetric because of one-ways and divided carriageways,
 * so `A→B` is not `B→A`. On the demo data OSRM returns 7024 m out and 6316 m
 * back for the same pair — assuming symmetry would quietly corrupt every route.
 */
export interface TravelMatrix {
  size: number
  minutes: Float64Array
  km: Float64Array
  source: 'osrm' | 'haversine'
  /** Why we fell back, when we did. */
  note?: string
}

const coordList = (depot: Depot, stops: BusStop[]) =>
  [depot, ...stops].map((node) => `${node.lng},${node.lat}`).join(';')

/**
 * Straight-line fallback. Kept deliberately: OSRM may be unreachable on a
 * school's own network, and an estimated route beats no route — as long as the
 * UI says which one it is.
 */
export function haversineMatrix(
  depot: Depot,
  stops: BusStop[],
  settings: FleetSettings,
  note?: string,
): TravelMatrix {
  const nodes = [depot, ...stops]
  const size = nodes.length
  const minutes = new Float64Array(size * size)
  const km = new Float64Array(size * size)
  const speed = Math.max(5, settings.averageSpeedKph)

  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      if (i === j) continue
      const distance = haversineKm(nodes[i]!, nodes[j]!) * settings.roadFactor
      km[i * size + j] = distance
      minutes[i * size + j] = (distance / speed) * 60
    }
  }
  return { size, minutes, km, source: 'haversine', note }
}

/**
 * One OSRM `/table` call gives the whole matrix. It is computed per set of
 * stops, not per solve — the search then runs millions of iterations against
 * these numbers for free, which is why real road distances cost almost nothing
 * here.
 */
export async function buildMatrix(
  depot: Depot,
  stops: BusStop[],
  settings: FleetSettings,
  signal?: AbortSignal,
): Promise<TravelMatrix> {
  const base = settings.osrmUrl?.trim().replace(/\/+$/, '')
  if (!base) return haversineMatrix(depot, stops, settings, 'NOT_CONFIGURED')

  const url = `${base}/table/v1/driving/${coordList(depot, stops)}?annotations=duration,distance`

  try {
    const response = await fetch(url, { signal })
    if (!response.ok) {
      return haversineMatrix(depot, stops, settings, `HTTP_${response.status}`)
    }
    const body = (await response.json()) as {
      code: string
      durations?: number[][]
      distances?: number[][]
    }
    if (body.code !== 'Ok' || !body.durations || !body.distances) {
      return haversineMatrix(depot, stops, settings, body.code ?? 'BAD_RESPONSE')
    }

    const size = stops.length + 1
    const minutes = new Float64Array(size * size)
    const km = new Float64Array(size * size)
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        // OSRM gives seconds and metres; a null means no route was found, in
        // which case a large finite cost keeps the solver from choosing it
        // without letting an Infinity poison the arithmetic.
        const seconds = body.durations[i]?.[j]
        const metres = body.distances[i]?.[j]
        minutes[i * size + j] = seconds == null ? 600 : seconds / 60
        km[i * size + j] = metres == null ? 100 : metres / 1000
      }
    }
    return { size, minutes, km, source: 'osrm' }
  } catch (error) {
    const note = error instanceof DOMException && error.name === 'AbortError' ? 'ABORTED' : 'UNREACHABLE'
    return haversineMatrix(depot, stops, settings, note)
  }
}

/**
 * Street-level geometry for one bus route, so the map draws the road the
 * driver takes rather than a line across the city.
 */
export async function fetchRouteGeometry(
  points: Array<{ lat: number; lng: number }>,
  osrmUrl: string | undefined,
  signal?: AbortSignal,
): Promise<Array<[number, number]> | null> {
  const base = osrmUrl?.trim().replace(/\/+$/, '')
  if (!base || points.length < 2) return null
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';')
  try {
    const response = await fetch(
      `${base}/route/v1/driving/${coords}?overview=full&geometries=polyline`,
      { signal },
    )
    if (!response.ok) return null
    const body = (await response.json()) as {
      code: string
      routes?: Array<{ geometry: string }>
    }
    if (body.code !== 'Ok' || !body.routes?.[0]) return null
    return decodePolyline(body.routes[0].geometry)
  } catch {
    return null
  }
}

/** Google-style encoded polyline, precision 5 — what OSRM returns by default. */
export function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = []
  let index = 0
  let lat = 0
  let lng = 0

  while (index < encoded.length) {
    let result = 0
    let shift = 0
    let byte: number
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1

    result = 0
    shift = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    lng += result & 1 ? ~(result >> 1) : result >> 1

    points.push([lat / 1e5, lng / 1e5])
  }
  return points
}
