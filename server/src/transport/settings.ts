import type { TransportSettingsDoc } from '../db.js'

/**
 * A branch with no settings row yet behaves as if it had these — mirrors
 * timetable-ui's `domain/fleet.ts` `sampleFleet()` routing-rule defaults,
 * except `osrmUrl`, which defaults empty (falls back to straight-line
 * estimates) rather than a developer's local OSRM instance. Depot
 * coordinates default to `null` island — a brand-new branch has no real
 * depot location yet, and a wrong-but-plausible default (e.g. some other
 * school's campus) would be worse than an obviously-unset one the UI can
 * prompt for.
 */
export const DEFAULT_TRANSPORT_SETTINGS = {
  depotName: '',
  depotLat: 0,
  depotLng: 0,
  roadFactor: 1.35,
  averageSpeedKph: 32,
  dwellMinutes: 1.5,
  maxRideMinutes: 45,
  earliestDeparture: '06:30:00',
  bellTime: '08:30:00',
  arrivalBufferMinutes: 15,
  osrmUrl: '',
  outlierThresholdMeters: 500,
  doorToDoorEnabled: true,
} as const

export interface EffectiveTransportSettings {
  depotName: string
  depotLat: number
  depotLng: number
  roadFactor: number
  averageSpeedKph: number
  dwellMinutes: number
  maxRideMinutes: number
  earliestDeparture: string
  bellTime: string
  arrivalBufferMinutes: number
  osrmUrl: string
  outlierThresholdMeters: number
  doorToDoorEnabled: boolean
}

export function effectiveTransportSettings(
  doc: TransportSettingsDoc | null,
): EffectiveTransportSettings {
  const d = DEFAULT_TRANSPORT_SETTINGS
  return {
    depotName: doc?.depotName ?? d.depotName,
    depotLat: doc?.depotLat ?? d.depotLat,
    depotLng: doc?.depotLng ?? d.depotLng,
    roadFactor: doc?.roadFactor ?? d.roadFactor,
    averageSpeedKph: doc?.averageSpeedKph ?? d.averageSpeedKph,
    dwellMinutes: doc?.dwellMinutes ?? d.dwellMinutes,
    maxRideMinutes: doc?.maxRideMinutes ?? d.maxRideMinutes,
    earliestDeparture: doc?.earliestDeparture ?? d.earliestDeparture,
    bellTime: doc?.bellTime ?? d.bellTime,
    arrivalBufferMinutes: doc?.arrivalBufferMinutes ?? d.arrivalBufferMinutes,
    osrmUrl: doc?.osrmUrl ?? d.osrmUrl,
    outlierThresholdMeters: doc?.outlierThresholdMeters ?? d.outlierThresholdMeters,
    doorToDoorEnabled: doc?.doorToDoorEnabled ?? d.doorToDoorEnabled,
  }
}
