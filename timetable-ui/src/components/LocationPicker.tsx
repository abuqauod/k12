import { useEffect, useRef } from 'react'
import L from 'leaflet'

interface Props {
  /** Null/undefined shows the map centred on `center` with no pin placed yet. */
  lat: number | null | undefined
  lng: number | null | undefined
  /** Where to centre the map when no pin is set yet — typically the depot. */
  center: { lat: number; lng: number }
  onChange: (lat: number, lng: number) => void
}

/**
 * A single-marker Leaflet picker: click anywhere to place the pin, or drag an
 * existing one. Reuses the same imperative-Leaflet approach as RouteMap for
 * the same reason — a React wrapper would fight the map's own DOM ownership.
 */
export function LocationPicker({ lat, lng, center, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  // Read inside the click/drag handlers without re-binding them on every
  // parent re-render — the handlers are only ever attached once.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)
    map.setView([lat ?? center.lat, lng ?? center.lng], lat != null ? 15 : 12)

    map.on('click', (event: L.LeafletMouseEvent) => {
      onChangeRef.current(Number(event.latlng.lat.toFixed(6)), Number(event.latlng.lng.toFixed(6)))
    })

    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      markerRef.current = null
    }
    // Only the container mounts once — lat/lng/center changes are handled by
    // the effect below so the map itself isn't recreated on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (lat == null || lng == null) {
      if (markerRef.current) {
        markerRef.current.remove()
        markerRef.current = null
      }
      return
    }

    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lng], {
        draggable: true,
        icon: L.divIcon({
          className: 'map-pin map-pin--student',
          html: '<span>●</span>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
      })
        .on('dragend', (event) => {
          const position = (event.target as L.Marker).getLatLng()
          onChangeRef.current(Number(position.lat.toFixed(6)), Number(position.lng.toFixed(6)))
        })
        .addTo(map)
      map.setView([lat, lng], 15)
    } else {
      markerRef.current.setLatLng([lat, lng])
    }
  }, [lat, lng])

  return (
    <div
      className="routemap routemap--picker"
      ref={containerRef}
      role="application"
      aria-label="Pick a location on the map"
    />
  )
}
