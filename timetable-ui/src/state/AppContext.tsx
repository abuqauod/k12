import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Problem, Score, Solution } from '../domain/types'
import { DEFAULT_WEIGHTS } from '../domain/types'
import { DEFAULT_CALENDAR, normalizeProblem } from '../domain/calendar'
import { sampleProblem } from '../domain/sample'
import type { Bus, BusStop, FleetProblem, TransportSettings } from '../domain/fleet'
import { assembleFleetProblem } from '../domain/fleet'
import type { Student } from '../domain/students'
import type { Branch } from '../domain/branches'
import { listBranches } from '../lib/branchesApi'
import { listStudents } from '../lib/studentsApi'
import {
  createBus as apiCreateBus,
  createStop as apiCreateStop,
  deactivateBus,
  deactivateStop,
  getTransportSettings,
  listBuses,
  listStops,
  updateBus as apiUpdateBus,
  updateStop as apiUpdateStop,
  updateTransportSettings as apiUpdateTransportSettings,
} from '../lib/transportApi'
import { useSolver } from '../lib/useSolver'
import type { SolverProgress } from '../lib/useSolver'
import { clearDataset, loadDataset, saveDataset } from '../lib/storage'
import {
  isConfigured,
  loadSyncSettings,
  pullDataset,
  pushDataset,
  saveSyncSettings,
} from '../lib/sync'
import type { SyncSettings, SyncStatus } from '../lib/sync'
import { useAuth } from '../auth/AuthContext'

export type Theme = 'auto' | 'light' | 'dark'

/** A branch with no transport-settings row yet behaves as if it had these —
 * mirrors the server's own `DEFAULT_TRANSPORT_SETTINGS`
 * (server/src/transport/settings.ts) so the two can't drift. */
const DEFAULT_TRANSPORT_SETTINGS: TransportSettings = {
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
}

interface AppValue {
  problem: Problem
  setProblem: (next: Problem) => void
  solution: Solution | null
  progress: SolverProgress | null
  solving: boolean
  error: string | null
  shownScore: Score | undefined
  dirty: boolean
  budget: number
  setBudget: (ms: number) => void
  seed: number
  solve: (seed?: number) => void
  reseed: () => void
  stop: () => void
  resetSample: () => void
  importProblem: (file: File, onDone: (message: string) => void) => void
  theme: Theme
  setTheme: (theme: Theme) => void
  /** Assembled from `buses`/`stops`/`transportSettings` plus the live
   * roster's per-stop counts — the shape the map and the VRP solver
   * consume. Read this for display/solving; mutate via the functions
   * below (each writes through to the server), or `setBuses`/`setStops`
   * for an instant-feedback local patch a caller then debounce-saves with
   * `updateBus`/`updateStop` — same split as `students`/`setStudents`. */
  fleet: FleetProblem
  transportLoading: boolean
  buses: Bus[]
  setBuses: (next: Bus[]) => void
  stops: BusStop[]
  setStops: (next: BusStop[]) => void
  createBus: (input: { name: string; seats: number }) => Promise<void>
  updateBus: (id: string, patch: { name?: string; seats?: number }) => Promise<void>
  removeBus: (id: string) => Promise<void>
  createStop: (input: { name: string; lat: number; lng: number; pinnedBusId?: string | null }) => Promise<void>
  updateStop: (id: string, patch: { name?: string; lat?: number; lng?: number; pinnedBusId?: string | null }) => Promise<void>
  removeStop: (id: string) => Promise<void>
  updateTransportSettings: (patch: Partial<TransportSettings>) => void
  students: Student[]
  setStudents: (next: Student[]) => void
  /** The school's campuses. Empty until loaded (or if the server is
   * unreachable); a single-branch school still has one entry. */
  branches: Branch[]
  /** The campus the UI is currently scoped to — classes, the register and
   * absence notifications all read this. Null before branches load. */
  activeBranchId: string | null
  setActiveBranchId: (id: string) => void
  reloadBranches: () => Promise<void>
  /** ISO timestamp of the last local autosave. */
  savedAt: string | null
  syncSettings: SyncSettings
  setSyncSettings: (settings: SyncSettings) => void
  syncStatus: SyncStatus
  syncNow: () => Promise<void>
  pullFromServer: () => Promise<void>
  syncConfigured: boolean
}

const AppContext = createContext<AppValue | null>(null)
const THEME_KEY = 'timetable.theme'
const STUDENTS_KEY = 'timetable.students'

function readJson<T>(key: string, fallback: () => T, valid: (value: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw) as T
      if (valid(parsed)) return parsed
    }
  } catch {
    // Corrupt payload: fall back rather than crash the app.
  }
  return fallback()
}

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'auto' || stored === 'light' || stored === 'dark') return stored
  } catch {
    // Fall through to the default.
  }
  return 'auto'
}

/**
 * Whether `problem` has ever been reconciled with the server on this
 * device — the signal the auto-hydration effect below uses to decide it's
 * safe to silently replace the bundled sample data with the real thing.
 * Deliberately NOT "is there anything in localStorage": the autosave
 * effect below persists the CURRENT state (sample included) on first mount
 * regardless, so presence alone can't distinguish "never synced" from
 * "synced once, or never touched." This flag is only ever set by an actual
 * successful push or pull (manual or automatic), and once set, the
 * auto-hydration effect never fires again for that key — from then on the
 * existing manual Sync/Pull buttons and dirty-tracking are what manage a
 * real local draft, exactly as before this existed.
 */
const EVER_SYNCED_PREFIX = 'timetable.everSynced'
function everSyncedKey(schoolId: string): string {
  return `${EVER_SYNCED_PREFIX}.${schoolId}`
}
function hasEverSynced(schoolId: string): boolean {
  try {
    return localStorage.getItem(everSyncedKey(schoolId)) === 'true'
  } catch {
    return true // storage unavailable: don't risk auto-overwriting on every render
  }
}
function markEverSynced(schoolId: string): void {
  try {
    localStorage.setItem(everSyncedKey(schoolId), 'true')
  } catch {
    // Best effort — a failed write just means this can't skip a future retry.
  }
}

/**
 * The actual safety check the `problem` auto-hydration effect relies on:
 * `hasEverSynced` only knows whether a round-trip ever completed, not
 * whether the CURRENT local state is still untouched — a device can have
 * `hasEverSynced === false` while sitting on a real, valuable,
 * never-successfully-synced local draft (edited fully offline, or every
 * sync attempt failed). `sampleProblem` is pure and deterministic (no
 * Date.now/Math.random), so a fresh call always serializes identically to
 * the one nothing has ever touched — this is the one case where
 * auto-replacing local state is provably safe.
 */
function isPristineProblem(problem: Problem): boolean {
  const json = JSON.stringify(problem)
  return json === JSON.stringify(normalizeProblem(sampleProblem())) || json === JSON.stringify(normalizeProblem(emptyProblem()))
}

/** SAMS 12: what a school with no timetable yet starts from — the sample's
 * week structure, none of its classes, teachers or rooms. */
function emptyProblem(): Problem {
  return { ...sampleProblem(), rooms: [], lessons: [], unavailability: [] }
}

const ACTIVE_BRANCH_KEY = 'timetable.activeBranch'

export function AppProvider({ children }: { children: ReactNode }) {
  // Sync authenticates as the signed-in user — no separate token setting.
  const { getAccessToken, user: signedIn, roleKey, accessReady, tenant, hasModule } = useAuth()
  // SAMS 13.1: transport is a module; a plan without it has nothing to load.
  const transportOn = accessReady && hasModule('transport')
  // Everything loaded here is the staff app's; a parent portal login
  // (SAMS 6.4) loads none of it.
  const user = accessReady && roleKey !== 'parent' ? signedIn : null

  // Restore the saved dataset; only fall back to the sample on a fresh install.
  // Another school's saved work is not restored at all (SAMS 12).
  const restored = useRef(
    ((d) => (d && d.owner && tenant && d.owner !== tenant.id ? null : d))(loadDataset()),
  ).current
  const [problem, setProblemState] = useState<Problem>(() => restored?.problem ?? sampleProblem())
  const [revision, setRevision] = useState(restored?.revision ?? 1)
  // SAMS 12: whose timetable work is on this device.
  const ownerRef = useRef<string | null>(restored?.owner ?? null)
  const [savedAt, setSavedAt] = useState<string | null>(restored?.savedAt ?? null)

  const [budget, setBudget] = useState(5000)
  const [seed, setSeed] = useState(1337)
  const [dirty, setDirty] = useState(false)
  const [theme, setThemeState] = useState<Theme>(readTheme)

  const [branches, setBranches] = useState<Branch[]>([])
  const [activeBranchId, setActiveBranchIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_BRANCH_KEY)
    } catch {
      return null
    }
  })

  const setActiveBranchId = useCallback((id: string) => {
    setActiveBranchIdState(id)
    try {
      localStorage.setItem(ACTIVE_BRANCH_KEY, id)
    } catch {
      // Preference simply will not persist.
    }
  }, [])

  const [students, setStudentsState] = useState<Student[]>(() =>
    readJson(STUDENTS_KEY, () => [], (v) => Array.isArray(v)),
  )

  const reloadBranches = useCallback(async () => {
    const token = await getAccessToken()
    if (!token) return
    const result = await listBranches(getAccessToken)
    if (result.kind !== 'ok') return
    setBranches(result.data)
    // Keep the active branch valid: fall back to the first one the caller
    // can actually see.
    setActiveBranchIdState((current) => {
      const stillValid = current && result.data.some((b) => b.id === current)
      const next = stillValid ? current : (result.data[0]?.id ?? null)
      try {
        if (next) localStorage.setItem(ACTIVE_BRANCH_KEY, next)
      } catch {
        // ignore
      }
      return next
    })
  }, [getAccessToken])

  useEffect(() => {
    if (user) void reloadBranches()
    else setBranches([])
  }, [user, reloadBranches])

  useEffect(() => {
    try {
      localStorage.setItem(STUDENTS_KEY, JSON.stringify(students))
    } catch {
      // Preference simply will not persist.
    }
  }, [students])

  // ---------------------------------------------------------------- transport
  // Buses, stops and settings for the active branch — real, server-backed
  // resources (server/src/transport/routes.ts), not a locally-editable
  // draft: every mutation below writes straight through, same as the real
  // students roster. No blob, no sample fallback, no offline draft to lose.
  const [buses, setBuses] = useState<Bus[]>([])
  const [stops, setStops] = useState<BusStop[]>([])
  const [transportSettings, setTransportSettings] = useState<TransportSettings>(DEFAULT_TRANSPORT_SETTINGS)
  const [transportLoading, setTransportLoading] = useState(false)
  // Which branch `buses`/`stops`/`transportSettings` actually belong to —
  // guards every mutation below against firing against a branch the UI has
  // already navigated away from (a slow request resolving after the user
  // switched campuses).
  const transportBranchRef = useRef<string | null>(null)
  // Set right before a freshly-fetched settings row is applied, so the
  // debounced save effect below skips writing it straight back to the
  // server it just came from. Cleared on that same effect's next run.
  const transportSettingsHydrating = useRef(false)
  // Which branch `transportSettings` state actually holds data for. Stays
  // behind `activeBranchId` for the whole window between a branch switch
  // starting and its settings GET resolving — during which `transportSettings`
  // still holds the PREVIOUS branch's values. The debounced save effect below
  // refuses to write while these two disagree, so a slow GET can never lose
  // a race against a stale PUT for the branch being switched away from (or,
  // on first load, against writing `DEFAULT_TRANSPORT_SETTINGS` for real data).
  const transportSettingsBranchRef = useRef<string | null>(null)

  useEffect(() => {
    if (!user || !activeBranchId || !transportOn) {
      setBuses([])
      setStops([])
      setTransportSettings(DEFAULT_TRANSPORT_SETTINGS)
      transportBranchRef.current = null
      transportSettingsBranchRef.current = null
      return
    }
    let cancelled = false
    transportBranchRef.current = activeBranchId
    setTransportLoading(true)
    void (async () => {
      const [busesResult, stopsResult, settingsResult] = await Promise.all([
        listBuses(getAccessToken, activeBranchId),
        listStops(getAccessToken, activeBranchId),
        getTransportSettings(getAccessToken, activeBranchId),
      ])
      if (cancelled) return
      if (busesResult.kind === 'ok') setBuses(busesResult.data)
      if (stopsResult.kind === 'ok') setStops(stopsResult.data)
      if (settingsResult.kind === 'ok') {
        // The debounced save effect below must not immediately write this
        // fetched value straight back to the server it just came from.
        transportSettingsHydrating.current = true
        transportSettingsBranchRef.current = activeBranchId
        setTransportSettings(settingsResult.data)
      }
      setTransportLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [user, activeBranchId, getAccessToken, transportOn])

  const studentCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const student of students) {
      if (!student.active || student.transportMode === 'NONE' || !student.stopId) continue
      counts.set(student.stopId, (counts.get(student.stopId) ?? 0) + 1)
    }
    return counts
  }, [students])

  const fleet = useMemo(
    () => assembleFleetProblem(buses, stops, transportSettings, studentCounts),
    [buses, stops, transportSettings, studentCounts],
  )

  const createBus = useCallback(
    async (input: { name: string; seats: number }) => {
      if (!activeBranchId) return
      const result = await apiCreateBus(getAccessToken, { branchId: activeBranchId, ...input })
      if (result.kind === 'ok' && transportBranchRef.current === activeBranchId) {
        setBuses((current) => [...current, result.data])
      }
    },
    [activeBranchId, getAccessToken],
  )

  const updateBus = useCallback(
    async (id: string, patch: { name?: string; seats?: number }) => {
      const branchId = activeBranchId
      const result = await apiUpdateBus(getAccessToken, id, patch)
      if (result.kind === 'ok' && transportBranchRef.current === branchId) {
        setBuses((current) => current.map((b) => (b.id === id ? result.data : b)))
      }
    },
    [activeBranchId, getAccessToken],
  )

  const removeBus = useCallback(
    async (id: string) => {
      const branchId = activeBranchId
      const result = await deactivateBus(getAccessToken, id)
      if (result.kind === 'ok' && transportBranchRef.current === branchId) {
        setBuses((current) => current.filter((b) => b.id !== id))
        // The server unpins every stop pointed at this bus in the same
        // transaction as the deactivation — mirror that locally rather
        // than re-fetching the whole stop list for one field.
        setStops((current) => current.map((s) => (s.pinnedBusId === id ? { ...s, pinnedBusId: null } : s)))
      }
    },
    [activeBranchId, getAccessToken],
  )

  const createStop = useCallback(
    async (input: { name: string; lat: number; lng: number; pinnedBusId?: string | null }) => {
      if (!activeBranchId) return
      const result = await apiCreateStop(getAccessToken, { branchId: activeBranchId, ...input })
      if (result.kind === 'ok' && transportBranchRef.current === activeBranchId) {
        setStops((current) => [...current, result.data])
      }
    },
    [activeBranchId, getAccessToken],
  )

  const updateStop = useCallback(
    async (id: string, patch: { name?: string; lat?: number; lng?: number; pinnedBusId?: string | null }) => {
      const branchId = activeBranchId
      const result = await apiUpdateStop(getAccessToken, id, patch)
      if (result.kind === 'ok' && transportBranchRef.current === branchId) {
        setStops((current) => current.map((s) => (s.id === id ? result.data : s)))
      }
    },
    [activeBranchId, getAccessToken],
  )

  const removeStop = useCallback(
    async (id: string) => {
      const branchId = activeBranchId
      const result = await deactivateStop(getAccessToken, id)
      if (result.kind === 'ok' && transportBranchRef.current === branchId) {
        setStops((current) => current.filter((s) => s.id !== id))
      }
    },
    [activeBranchId, getAccessToken],
  )

  /** Updates the shared local copy instantly (typing feels the same as the
   * old local-only draft did) — the debounced effect below is what actually
   * persists it, same split as `problem`'s own autosave. */
  const updateTransportSettingsFn = useCallback((patch: Partial<TransportSettings>) => {
    setTransportSettings((current) => ({ ...current, ...patch }))
  }, [])

  // Debounced save, mirroring the `problem` autosave effect further down:
  // a burst of typing (or a settings row just being fetched) writes once,
  // 600ms after it settles, not on every keystroke.
  useEffect(() => {
    if (transportSettingsHydrating.current) {
      transportSettingsHydrating.current = false
      return
    }
    if (!activeBranchId) return
    // `transportSettings` state still holds the branch we last fetched it
    // for, not necessarily `activeBranchId` — e.g. mid branch-switch, before
    // the new branch's GET has resolved. Writing here would PUT (a full
    // replace) the wrong branch's data onto `activeBranchId`'s settings row.
    if (transportSettingsBranchRef.current !== activeBranchId) return
    const branchId = activeBranchId
    const timer = setTimeout(() => {
      void apiUpdateTransportSettings(getAccessToken, branchId, transportSettings)
    }, 600)
    return () => clearTimeout(timer)
  }, [transportSettings, activeBranchId, getAccessToken])

  const [syncSettings, setSyncSettingsState] = useState<SyncSettings>(loadSyncSettings)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    state: isConfigured(loadSyncSettings()) ? 'idle' : 'unconfigured',
    lastSyncedAt: null,
    serverRevision: null,
    message: null,
  })

  const { solution, progress, solving, error, run, stop } = useSolver()
  const firstRender = useRef(true)

  // Solve whatever we booted with so the board is never empty.
  useEffect(() => {
    run(restored?.problem ?? sampleProblem(), 5000, 1337)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    setDirty(true)
  }, [problem])

  useEffect(() => {
    if (solution) setDirty(false)
  }, [solution])

  // Autosave, debounced so a burst of typing writes once.
  useEffect(() => {
    if (firstRender.current) return
    const timer = setTimeout(() => {
      const record = saveDataset(problem, revision + 1, tenant?.id ?? ownerRef.current)
      if (record) {
        setRevision(record.revision)
        setSavedAt(record.savedAt)
      }
    }, 600)
    return () => clearTimeout(timer)
    // `revision` is intentionally omitted: including it would re-save forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Preference simply will not persist.
    }
  }, [])

  const setSyncSettings = useCallback((next: SyncSettings) => {
    setSyncSettingsState(next)
    saveSyncSettings(next)
    setSyncStatus((current) => ({
      ...current,
      state: isConfigured(next) ? 'idle' : 'unconfigured',
      message: null,
    }))
  }, [])

  const solve = useCallback(
    (nextSeed?: number) => run(problem, budget, nextSeed ?? seed),
    [problem, budget, seed, run],
  )

  const reseed = useCallback(() => {
    const next = (seed * 1103515245 + 12345) % 2147483647
    setSeed(next)
    run(problem, budget, next)
  }, [problem, budget, seed, run])

  const resetSample = useCallback(() => {
    clearDataset()
    setProblemState(sampleProblem())
    setRevision(1)
  }, [])

  const importProblem = useCallback((file: File, onDone: (message: string) => void) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Partial<Problem>
        if (!Array.isArray(parsed.lessons) || !Array.isArray(parsed.timeslots)) {
          onDone('NEEDS_ARRAYS')
          return
        }
        setProblemState(
          normalizeProblem({
            calendar: { ...DEFAULT_CALENDAR, ...(parsed.calendar ?? {}) },
            timeslots: parsed.timeslots,
            rooms: parsed.rooms ?? [],
            lessons: parsed.lessons,
            unavailability: parsed.unavailability ?? [],
            weights: { ...DEFAULT_WEIGHTS, ...(parsed.weights ?? {}) },
          }),
        )
        onDone(`OK:${parsed.lessons.length}`)
      } catch {
        onDone('FAILED')
      }
    }
    reader.readAsText(file)
  }, [])

  /** Push local work up. A 409 means someone else saved first. */
  const syncNow = useCallback(async () => {
    if (!isConfigured(syncSettings)) {
      setSyncStatus((c) => ({ ...c, state: 'unconfigured', message: null }))
      return
    }
    setSyncStatus((c) => ({ ...c, state: 'syncing', message: null }))
    const result = await pushDataset(syncSettings, problem, revision, getAccessToken)
    if (result.kind === 'pushed') {
      markEverSynced(syncSettings.schoolId)
      setSyncStatus({
        state: 'synced',
        lastSyncedAt: result.updatedAt ?? new Date().toISOString(),
        serverRevision: result.revision ?? null,
        message: null,
      })
    } else if (result.kind === 'conflict') {
      setSyncStatus((c) => ({
        ...c,
        state: 'conflict',
        serverRevision: result.revision ?? null,
        message: 'SERVER_AHEAD',
      }))
    } else {
      setSyncStatus((c) => ({ ...c, state: 'error', message: result.message ?? 'UNKNOWN' }))
    }
  }, [syncSettings, problem, revision, getAccessToken])

  /** Take the server copy, discarding local edits. */
  const pullFromServer = useCallback(async () => {
    if (!isConfigured(syncSettings)) {
      setSyncStatus((c) => ({ ...c, state: 'unconfigured', message: null }))
      return
    }
    setSyncStatus((c) => ({ ...c, state: 'syncing', message: null }))
    const result = await pullDataset(syncSettings, getAccessToken)
    if (result.kind === 'pulled' && result.problem) {
      setProblemState(result.problem)
      setRevision(result.revision ?? 1)
      markEverSynced(syncSettings.schoolId)
      setSyncStatus({
        state: 'synced',
        lastSyncedAt: result.updatedAt ?? new Date().toISOString(),
        serverRevision: result.revision ?? null,
        message: null,
      })
    } else if (result.kind === 'empty') {
      setSyncStatus((c) => ({ ...c, state: 'idle', message: 'SERVER_EMPTY' }))
    } else {
      setSyncStatus((c) => ({ ...c, state: 'error', message: result.message ?? 'UNKNOWN' }))
    }
  }, [syncSettings, getAccessToken])

  /**
   * Auto-hydration: a device/tenant pairing that has never completed a real
   * sync otherwise keeps showing the bundled sample `problem` (see
   * domain/sample.ts) indefinitely — nothing previously replaced it until
   * the user found the manual Sync/Pull button. Fires once, silently (no
   * `syncStatus` change — this isn't a user-initiated action), the first
   * time it's safe.
   *
   * `hasEverSynced` alone is NOT enough to call that safe: it only tracks
   * whether a real push/pull round-trip has ever completed on this device,
   * not whether the CURRENT local `problem` is still untouched — a user who
   * has been editing entirely offline (or whose every sync attempt failed)
   * would have `hasEverSynced === false` while sitting on a real, valuable,
   * unsynced draft. Silently overwriting that the moment they come online
   * would be a data-loss regression, not a fix. So this also requires the
   * current state to be byte-for-byte the bundled sample — the one case
   * where there is provably nothing local to lose.
   *
   * `empty` (nothing pushed for this school yet) intentionally does NOT mark
   * everSynced, so a later retry (next reload) can still pick up real data
   * once it exists.
   *
   * Keyed by schoolId, not a plain boolean: `syncSettings.schoolId` can
   * change mid-session (Settings has a free-text field for it) — a boolean
   * would permanently suppress the first-ever attempt for a newly-entered
   * school once the very first schoolId's attempt had already run.
   */
  // SAMS 12: another school's work never shows here — a different school
  // signing in starts from a clean slate and loads its own timetable.
  useEffect(() => {
    if (!tenant) return
    if (ownerRef.current && ownerRef.current !== tenant.id) {
      setProblemState(sampleProblem())
      setRevision(1)
      try {
        localStorage.removeItem(everSyncedKey(syncSettings.schoolId))
      } catch {
        // Best effort.
      }
      problemAutoPulled.current.clear()
    }
    ownerRef.current = tenant.id
  }, [tenant, syncSettings.schoolId])

  const problemAutoPulled = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!user || !isConfigured(syncSettings)) return
    if (problemAutoPulled.current.has(syncSettings.schoolId)) return
    if (hasEverSynced(syncSettings.schoolId)) return
    if (!isPristineProblem(problem)) return
    problemAutoPulled.current.add(syncSettings.schoolId)
    void (async () => {
      const result = await pullDataset(syncSettings, getAccessToken)
      if (result.kind === 'pulled' && result.problem) {
        setProblemState(result.problem)
        setRevision(result.revision ?? 1)
        markEverSynced(syncSettings.schoolId)
      } else if (result.kind === 'empty') {
        // A school with no timetable yet sees an empty one, not the demo.
        setProblemState(emptyProblem())
      }
    })()
  }, [user, syncSettings, getAccessToken, problem])

  /**
   * The bus-routing roster (`students`) has no offline-draft concept — every
   * edit already goes straight to the server (see studentsApi.ts), so unlike
   * `problem` there's no local work to risk discarding, and this can just
   * always fetch. Previously only StudentsPage did this fetch, so a page
   * that reads `students` without ever visiting Students first (Bus Routes'
   * roster) could show stale or empty data indefinitely.
   */
  useEffect(() => {
    if (!user) return
    let cancelled = false
    void (async () => {
      const token = await getAccessToken()
      if (!token || cancelled) return
      const result = await listStudents(getAccessToken, activeBranchId ? { branchId: activeBranchId } : {})
      if (!cancelled && result.kind === 'ok') setStudentsState(result.data)
    })()
    return () => {
      cancelled = true
    }
  }, [user, activeBranchId, getAccessToken])

  const value = useMemo<AppValue>(
    () => ({
      problem,
      setProblem: setProblemState,
      solution,
      progress,
      solving,
      error,
      shownScore: solving ? progress?.best : solution?.score,
      dirty,
      budget,
      setBudget,
      seed,
      solve,
      reseed,
      stop,
      resetSample,
      importProblem,
      theme,
      setTheme,
      fleet,
      transportLoading,
      buses,
      setBuses,
      stops,
      setStops,
      createBus,
      updateBus,
      removeBus,
      createStop,
      updateStop,
      removeStop,
      updateTransportSettings: updateTransportSettingsFn,
      students,
      setStudents: setStudentsState,
      branches,
      activeBranchId,
      setActiveBranchId,
      reloadBranches,
      savedAt,
      syncSettings,
      setSyncSettings,
      syncStatus,
      syncNow,
      pullFromServer,
      syncConfigured: isConfigured(syncSettings),
    }),
    [
      problem,
      solution,
      progress,
      solving,
      error,
      dirty,
      budget,
      seed,
      solve,
      reseed,
      stop,
      resetSample,
      importProblem,
      theme,
      setTheme,
      fleet,
      transportLoading,
      buses,
      stops,
      createBus,
      updateBus,
      removeBus,
      createStop,
      updateStop,
      removeStop,
      updateTransportSettingsFn,
      students,
      branches,
      activeBranchId,
      setActiveBranchId,
      reloadBranches,
      savedAt,
      syncSettings,
      setSyncSettings,
      syncStatus,
      syncNow,
      pullFromServer,
    ],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used inside an AppProvider')
  return value
}
