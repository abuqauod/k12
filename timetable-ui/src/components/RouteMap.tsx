import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { FleetProblem, FleetSolution } from '../domain/fleet'
import type { Student } from '../domain/students'
import { fetchRouteGeometry } from '../lib/routing'

/** Distinct, colour-blind-safe route colours; index wraps for large fleets. */
export const ROUTE_COLOURS = [
  '#ff7300',
  '#0d6efd',
  '#12a150',
  '#b5179e',
  '#0aa2c0',
  '#d62828',
  '#7048e8',
  '#a16207',
]

export const routeColour = (index: number) => ROUTE_COLOURS[index % ROUTE_COLOURS.length]!

interface Props {
  problem: FleetProblem
  solution: FleetSolution | null
  /** Dims every other route so one bus can be read in isolation. */
  focusBusId: string | null
  onSelectBus: (busId: string | null) => void
  /** 'route' fetches real road geometry per leg from OSRM and falls back to
   * the straight segment (silently, same as the cost-matrix fallback) when
   * OSRM is unreachable or returns nothing. Defaults to 'straight'. */
  lineStyle?: 'straight' | 'route'
  /** Students with a saved pin are drawn as small dots, independent of the
   * routes — omit to skip drawing them. */
  students?: Student[]
}

/**
 * Leaflet is driven imperatively rather than through a React wrapper: the map
 * owns its own DOM, and re-creating layers on every render would fight it.
 * Tiles come from OpenStreetMap, so the page still works offline — the markers
 * and routes draw, only the basemap is missing.
 */
export function RouteMap({
  problem,
  solution,
  focusBusId,
  onSelectBus,
  lineStyle = 'straight',
  students,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layersRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)
    map.setView([problem.depot.lat, problem.depot.lng], 12)
    layersRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      layersRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layers = layersRef.current
    if (!map || !layers) return
    let cancelled = false
    layers.clearLayers()

    const stopById = new Map(problem.stops.map((stop) => [stop.id, stop]))
    const bounds = L.latLngBounds([[problem.depot.lat, problem.depot.lng]])

    // School
    L.marker([problem.depot.lat, problem.depot.lng], {
      icon: L.divIcon({
        className: 'map-pin map-pin--school',
        html: '<span>★</span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    })
      .bindTooltip(problem.depot.name, { direction: 'top' })
      .addTo(layers)

    // Students with a saved pin — independent of any route, so they still
    // show up before a solve, or for students not yet placed on a stop.
    for (const student of students ?? []) {
      if (student.lat == null || student.lng == null) continue
      bounds.extend([student.lat, student.lng])
      L.circleMarker([student.lat, student.lng], {
        radius: 4,
        color: '#ff7300',
        weight: 1,
        fillColor: '#ff7300',
        fillOpacity: 0.8,
      })
        .bindTooltip(`${student.givenName} ${student.familyName}`.trim(), { direction: 'top' })
        .addTo(layers)
    }

    if (!solution) {
      for (const stop of problem.stops) {
        bounds.extend([stop.lat, stop.lng])
        L.circleMarker([stop.lat, stop.lng], {
          radius: 6,
          color: '#7d7c8a',
          weight: 2,
          fillColor: '#ffffff',
          fillOpacity: 1,
        })
          .bindTooltip(`${stop.name} · ${stop.studentCount}`, { direction: 'top' })
          .addTo(layers)
      }
      map.fitBounds(bounds, { padding: [30, 30] })
      return
    }

    // Stop markers draw synchronously regardless of line style; only the
    // connecting polyline's shape depends on it.
    solution.routes.forEach((route, index) => {
      if (route.legs.length === 0) return
      const dimmed = focusBusId !== null && focusBusId !== route.busId
      const colour = routeColour(index)

      route.legs.forEach((leg, order) => {
        const stop = stopById.get(leg.stopId)
        if (!stop) return
        bounds.extend([stop.lat, stop.lng])
        L.circleMarker([stop.lat, stop.lng], {
          radius: dimmed ? 5 : 8,
          color: colour,
          weight: 2,
          fillColor: colour,
          fillOpacity: dimmed ? 0.25 : 0.95,
          opacity: dimmed ? 0.3 : 1,
        })
          .bindTooltip(
            `${order + 1}. ${stop.name} · ${stop.studentCount} students · ${Math.round(
              leg.rideMinutes,
            )} min ride`,
            { direction: 'top' },
          )
          .on('click', () => onSelectBus(route.busId))
          .addTo(layers)
      })
    })

    const drawStraight = (route: FleetSolution['routes'][number], index: number) => {
      const dimmed = focusBusId !== null && focusBusId !== route.busId
      const colour = routeColour(index)
      const path: L.LatLngExpression[] = [[problem.depot.lat, problem.depot.lng]]
      for (const leg of route.legs) {
        const stop = stopById.get(leg.stopId)
        if (stop) path.push([stop.lat, stop.lng])
      }
      path.push([problem.depot.lat, problem.depot.lng])
      L.polyline(path, {
        color: colour,
        weight: dimmed ? 2 : 4,
        opacity: dimmed ? 0.2 : 0.85,
      })
        .on('click', () => onSelectBus(route.busId))
        .addTo(layers)
    }

    if (lineStyle === 'straight') {
      solution.routes.forEach((route, index) => {
        if (route.legs.length === 0) return
        drawStraight(route, index)
      })
    } else {
      // Road geometry per route, fetched in parallel; each falls back to its
      // own straight segment silently if OSRM has nothing for it — same
      // fallback contract as the cost matrix.
      solution.routes.forEach((route, index) => {
        if (route.legs.length === 0) return
        const points = [
          problem.depot,
          ...route.legs
            .map((leg) => stopById.get(leg.stopId))
            .filter((stop): stop is NonNullable<typeof stop> => Boolean(stop)),
          problem.depot,
        ]
        void fetchRouteGeometry(points, problem.settings.osrmUrl).then((geometry) => {
          if (cancelled) return
          const currentLayers = layersRef.current
          if (!currentLayers) return
          const dimmed = focusBusId !== null && focusBusId !== route.busId
          const colour = routeColour(index)
          if (!geometry) {
            drawStraight(route, index)
            return
          }
          L.polyline(geometry, {
            color: colour,
            weight: dimmed ? 2 : 4,
            opacity: dimmed ? 0.2 : 0.85,
          })
            .on('click', () => onSelectBus(route.busId))
            .addTo(currentLayers)
        })
      })
    }

    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] })

    return () => {
      cancelled = true
    }
  }, [problem, solution, focusBusId, onSelectBus, lineStyle, students])

  return <div className="routemap" ref={containerRef} role="application" aria-label="Bus routes" />
}
