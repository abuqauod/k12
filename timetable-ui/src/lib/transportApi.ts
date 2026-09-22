import { loadSyncSettings } from './sync'
import { authorizedFetch, type TokenGetter } from './http'
import type { Bus, BusStop } from '../domain/fleet'
import type { TransportSettings } from '../domain/fleet'

/**
 * Client for the real, per-branch transport backend (`/transport/buses`,
 * `/transport/stops`, `/branches/:id/transport-settings`) — replaces the
 * old whole-fleet blob sync at dataset key `fleet-<branchId>`, same idiom
 * as studentsApi.ts replacing the old students blob.
 */

export type TransportResult<T> = { kind: 'ok'; data: T } | { kind: 'error'; error: string }

function baseUrl(): string {
  return loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
}

async function call(path: string, init: RequestInit, getToken: TokenGetter): Promise<Response> {
  return authorizedFetch(`${baseUrl()}${path}`, init, getToken)
}

async function parse<T>(response: Response): Promise<TransportResult<T>> {
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* keep null */
  }
  if (!response.ok) {
    const error = (body as { error?: string } | null)?.error ?? `HTTP_${response.status}`
    return { kind: 'error', error }
  }
  return { kind: 'ok', data: body as T }
}

interface WireBus {
  id: string
  branchId: string
  name: string
  seats: number
  active: boolean
}

interface WireStop {
  id: string
  branchId: string
  name: string
  lat: number
  lng: number
  pinnedBusId: string | null
  active: boolean
}

/** `studentCount` isn't part of the wire shape at all — see db.ts's
 * `StopDoc` comment for why it isn't modeled server-side. Callers
 * (state/AppContext.tsx) fill it in live from the real roster via
 * `assembleFleetProblem`; `0` here is only ever a placeholder that gets
 * immediately overwritten. */
function stopFromWire(w: WireStop): BusStop {
  return { id: w.id, name: w.name, lat: w.lat, lng: w.lng, pinnedBusId: w.pinnedBusId, studentCount: 0 }
}
function busFromWire(w: WireBus): Bus {
  return { id: w.id, name: w.name, seats: w.seats }
}

export async function listBuses(getToken: TokenGetter, branchId: string): Promise<TransportResult<Bus[]>> {
  try {
    const response = await call(`/transport/buses?branchId=${encodeURIComponent(branchId)}`, { method: 'GET' }, getToken)
    const result = await parse<{ buses: WireBus[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.buses.map(busFromWire) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function createBus(
  getToken: TokenGetter,
  input: { branchId: string; name: string; seats: number },
): Promise<TransportResult<Bus>> {
  try {
    const response = await call('/transport/buses', { method: 'POST', body: JSON.stringify(input) }, getToken)
    const result = await parse<WireBus>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: busFromWire(result.data) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateBus(
  getToken: TokenGetter,
  id: string,
  patch: { name?: string; seats?: number },
): Promise<TransportResult<Bus>> {
  try {
    const response = await call(
      `/transport/buses/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      getToken,
    )
    const result = await parse<WireBus>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: busFromWire(result.data) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function deactivateBus(getToken: TokenGetter, id: string): Promise<TransportResult<Bus>> {
  try {
    const response = await call(`/transport/buses/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }, getToken)
    const result = await parse<WireBus>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: busFromWire(result.data) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function listStops(getToken: TokenGetter, branchId: string): Promise<TransportResult<BusStop[]>> {
  try {
    const response = await call(`/transport/stops?branchId=${encodeURIComponent(branchId)}`, { method: 'GET' }, getToken)
    const result = await parse<{ stops: WireStop[] }>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: result.data.stops.map(stopFromWire) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function createStop(
  getToken: TokenGetter,
  input: { branchId: string; name: string; lat: number; lng: number; pinnedBusId?: string | null },
): Promise<TransportResult<BusStop>> {
  try {
    const response = await call('/transport/stops', { method: 'POST', body: JSON.stringify(input) }, getToken)
    const result = await parse<WireStop>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: stopFromWire(result.data) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateStop(
  getToken: TokenGetter,
  id: string,
  patch: { name?: string; lat?: number; lng?: number; pinnedBusId?: string | null },
): Promise<TransportResult<BusStop>> {
  try {
    const response = await call(
      `/transport/stops/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
      getToken,
    )
    const result = await parse<WireStop>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: stopFromWire(result.data) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function deactivateStop(getToken: TokenGetter, id: string): Promise<TransportResult<BusStop>> {
  try {
    const response = await call(`/transport/stops/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }, getToken)
    const result = await parse<WireStop>(response)
    return result.kind === 'ok' ? { kind: 'ok', data: stopFromWire(result.data) } : result
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function getTransportSettings(
  getToken: TokenGetter,
  branchId: string,
): Promise<TransportResult<TransportSettings>> {
  try {
    const response = await call(`/branches/${encodeURIComponent(branchId)}/transport-settings`, { method: 'GET' }, getToken)
    return parse<TransportSettings>(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}

export async function updateTransportSettings(
  getToken: TokenGetter,
  branchId: string,
  settings: TransportSettings,
): Promise<TransportResult<{ ok: true }>> {
  try {
    const response = await call(
      `/branches/${encodeURIComponent(branchId)}/transport-settings`,
      { method: 'PUT', body: JSON.stringify(settings) },
      getToken,
    )
    return parse(response)
  } catch {
    return { kind: 'error', error: 'NETWORK_ERROR' }
  }
}
