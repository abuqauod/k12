import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { FleetProblem, FleetSolution } from '../domain/fleet'

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
}

/**
 * Leaflet is driven imperatively rather than through a React wrapper: the map
 * owns its own DOM, and re-creating layers on every render would fight it.
 * Tiles come from OpenStreetMap, so the page still works offline — the markers
 * and routes draw, only the basemap is missing.
 */
export function RouteMap({ problem, solution, focusBusId, onSelectBus }: Props) {
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

    solution.routes.forEach((route, index) => {
      if (route.legs.length === 0) return
      const dimmed = focusBusId !== null && focusBusId !== route.busId
      const colour = routeColour(index)
      const path: L.LatLngExpression[] = [[problem.depot.lat, problem.depot.lng]]

      route.legs.forEach((leg, order) => {
        const stop = stopById.get(leg.stopId)
        if (!stop) return
        path.push([stop.lat, stop.lng])
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

      path.push([problem.depot.lat, problem.depot.lng])
      L.polyline(path, {
        color: colour,
        weight: dimmed ? 2 : 4,
        opacity: dimmed ? 0.2 : 0.85,
      })
        .on('click', () => onSelectBus(route.busId))
        .addTo(layers)
    })

    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] })
  }, [problem, solution, focusBusId, onSelectBus])

  return <div className="routemap" ref={containerRef} role="application" aria-label="Bus routes" />
}
