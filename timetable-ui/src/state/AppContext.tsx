import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Problem, Score, Solution } from '../domain/types'
import { DEFAULT_WEIGHTS } from '../domain/types'
import { DEFAULT_CALENDAR } from '../domain/calendar'
import { sampleProblem } from '../domain/sample'
import type { FleetProblem } from '../domain/fleet'
import { sampleFleet } from '../domain/fleet'
import type { Student } from '../domain/students'
import { sampleStudents } from '../domain/students'
import type { Branch } from '../domain/branches'
import { listBranches } from '../lib/branchesApi'
import { useSolver } from '../lib/useSolver'
import type { SolverProgress } from '../lib/useSolver'
import { clearDataset, loadDataset, saveDataset } from '../lib/storage'
import {
  isConfigured,
  loadSyncSettings,
  pullDataset,
  pullDocument,
  pushDataset,
  pushDocument,
  saveSyncSettings,
} from '../lib/sync'
import type { SyncSettings, SyncStatus } from '../lib/sync'
import { useAuth } from '../auth/AuthContext'

export type Theme = 'auto' | 'light' | 'dark'

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
  fleet: FleetProblem
  setFleet: (next: FleetProblem) => void
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
/** Pre-branch-scoping key — a school used to have exactly one fleet
 * regardless of how many campuses it had. Kept only as a one-time seed: a
 * branch with no fleet of its own yet reads this once (see
 * `legacyFleetSeed`/`pullFleet` below) rather than starting from the sample
 * data and losing whatever routing setup already existed. */
const LEGACY_FLEET_KEY = 'timetable.fleet'
const LEGACY_FLEET_DATASET_KEY = 'fleet'
const STUDENTS_KEY = 'timetable.students'

/** Each branch (campus) gets its own bus depot, fleet and stops — a shared
 * fleet across campuses would show one school's buses overlaid on another
 * campus's map. Keyed by branch id; `null` (branch not yet known, e.g. the
 * moment right after sign-in) falls back to a `'default'` bucket so the app
 * never has no fleet to show. */
function fleetStorageKey(branchId: string | null): string {
  return `timetable.fleet.${branchId ?? 'default'}`
}
function fleetRevisionKey(branchId: string | null): string {
  return `timetable.fleet.revision.${branchId ?? 'default'}`
}
/** See server/src/datasets/routes.ts for why `:key` can hold any JSON shape
 * — this reuses the same generic document store, one document per branch
 * instead of one for the whole tenant. */
function fleetDatasetKey(branchId: string | null): string {
  return `fleet:${branchId ?? 'default'}`
}

function readRevision(key: string): number {
  try {
    const raw = localStorage.getItem(key)
    const n = raw ? Number(raw) : 1
    return Number.isFinite(n) && n > 0 ? n : 1
  } catch {
    return 1
  }
}

function writeRevision(key: string, revision: number): void {
  try {
    localStorage.setItem(key, String(revision))
  } catch {
    // Preference simply will not persist.
  }
}

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

const ACTIVE_BRANCH_KEY = 'timetable.activeBranch'

export function AppProvider({ children }: { children: ReactNode }) {
  // Sync authenticates as the signed-in user — no separate token setting.
  const { getAccessToken, user } = useAuth()

  // Restore the saved dataset; only fall back to the sample on a fresh install.
  const restored = useRef(loadDataset()).current
  const [problem, setProblemState] = useState<Problem>(() => restored?.problem ?? sampleProblem())
  const [revision, setRevision] = useState(restored?.revision ?? 1)
  const [savedAt, setSavedAt] = useState<string | null>(restored?.savedAt ?? null)

  const [budget, setBudget] = useState(5000)
  const [seed, setSeed] = useState(1337)
  const [dirty, setDirty] = useState(false)
  const [theme, setThemeState] = useState<Theme>(readTheme)

  // Declared before `fleet` so its initial value is available to read the
  // right per-branch storage key on first render.
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

  /** A branch with no fleet of its own yet reads the old tenant-wide blob
   * once, so switching from the pre-branch-scoping shape doesn't lose an
   * existing routing setup — each branch seeds independently from it and
   * then diverges as it's edited. Absent legacy data, the bundled sample. */
  const legacyFleetSeed = () =>
    readJson<FleetProblem | null>(
      LEGACY_FLEET_KEY,
      () => null,
      (v) => Array.isArray((v as FleetProblem)?.stops),
    )

  const loadFleet = (branchId: string | null): FleetProblem => {
    // Merge over the defaults rather than replacing them: a fleet saved before
    // a settings field existed must not load that field as undefined.
    const base = sampleFleet()
    const stored = readJson<FleetProblem | null>(
      fleetStorageKey(branchId),
      legacyFleetSeed,
      (v) => Array.isArray((v as FleetProblem)?.stops),
    )
    return stored
      ? { ...base, ...stored, settings: { ...base.settings, ...stored.settings } }
      : base
  }

  const [fleet, setFleetState] = useState<FleetProblem>(() => loadFleet(activeBranchId))
  const [students, setStudentsState] = useState<Student[]>(() =>
    readJson(STUDENTS_KEY, sampleStudents, (v) => Array.isArray(v)),
  )
  const [fleetRevision, setFleetRevision] = useState(() => readRevision(fleetRevisionKey(activeBranchId)))

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

  // Which branch the current `fleet` state actually belongs to — updated in
  // lockstep with `setFleetState` (never on its own), so the autosave effect
  // below can always pair fleet content with its correct storage key, even
  // on the render where `activeBranchId` has changed but `fleet` hasn't been
  // swapped in yet. Without this, that in-between render would write the
  // OLD branch's fleet under the NEW branch's key (self-correcting one
  // render later, but a real transient bad write — see fleetBranchRef writes
  // below for where it's kept in sync).
  const fleetBranchRef = useRef(activeBranchId)

  // Switching campuses swaps in that campus's own fleet — buses and stops
  // for one branch have no business appearing on another's map. Skips the
  // very first render: the `fleet`/`fleetRevision` initializers above
  // already loaded the right branch's data for that render.
  const firstBranchRender = useRef(true)
  useEffect(() => {
    if (firstBranchRender.current) {
      firstBranchRender.current = false
      return
    }
    setFleetState(loadFleet(activeBranchId))
    setFleetRevision(readRevision(fleetRevisionKey(activeBranchId)))
    fleetBranchRef.current = activeBranchId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBranchId])

  useEffect(() => {
    try {
      localStorage.setItem(fleetStorageKey(fleetBranchRef.current), JSON.stringify(fleet))
    } catch {
      // Preference simply will not persist.
    }
  }, [fleet])

  useEffect(() => {
    try {
      localStorage.setItem(STUDENTS_KEY, JSON.stringify(students))
    } catch {
      // Preference simply will not persist.
    }
  }, [students])

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
      const record = saveDataset(problem, revision + 1)
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
        setProblemState({
          calendar: { ...DEFAULT_CALENDAR, ...(parsed.calendar ?? {}) },
          timeslots: parsed.timeslots,
          rooms: parsed.rooms ?? [],
          lessons: parsed.lessons,
          unavailability: parsed.unavailability ?? [],
          weights: { ...DEFAULT_WEIGHTS, ...(parsed.weights ?? {}) },
        })
        onDone(`OK:${parsed.lessons.length}`)
      } catch {
        onDone('FAILED')
      }
    }
    reader.readAsText(file)
  }, [])

  /**
   * The fleet rides along with every "Sync now" / "Pull from server", under
   * its own dataset key — one document per branch (`fleet:<branchId>`)
   * rather than the timetable's own, since a campus's bus routing has
   * nothing to do with how many timetable drafts the school keeps. Best-
   * effort: a conflict or error here is folded into the main sync's status
   * message rather than blocking it or opening a second conflict UI — the
   * next pull picks up whatever didn't push. The roster no longer rides
   * along here — see the comment on `fleetDatasetKey` above.
   */
  const pushFleet = useCallback(async (): Promise<string | null> => {
    const fleetResult = await pushDocument(
      syncSettings,
      fleetDatasetKey(activeBranchId),
      fleet,
      fleetRevision,
      getAccessToken,
    )
    if (fleetResult.kind === 'pushed' && fleetResult.revision) {
      setFleetRevision(fleetResult.revision)
      writeRevision(fleetRevisionKey(activeBranchId), fleetResult.revision)
      return null
    }
    if (fleetResult.kind !== 'pushed') {
      return `fleet: ${fleetResult.kind === 'conflict' ? 'SERVER_AHEAD' : (fleetResult.message ?? 'UNKNOWN')}`
    }
    return null
  }, [syncSettings, fleet, fleetRevision, activeBranchId, getAccessToken])

  const pullFleet = useCallback(async (): Promise<void> => {
    let fleetResult = await pullDocument<FleetProblem>(syncSettings, fleetDatasetKey(activeBranchId), getAccessToken)
    // Same one-time migration as the local read: a branch that has never
    // pushed its own fleet yet reads the old tenant-wide document once,
    // rather than pulling nothing and silently reverting to the sample.
    if (fleetResult.kind === 'empty') {
      fleetResult = await pullDocument<FleetProblem>(syncSettings, LEGACY_FLEET_DATASET_KEY, getAccessToken)
    }
    if (fleetResult.kind === 'pulled' && fleetResult.data) {
      const server = fleetResult.data
      setFleetState((base) => ({ ...base, ...server, settings: { ...base.settings, ...server.settings } }))
      setFleetRevision(fleetResult.revision ?? 1)
      writeRevision(fleetRevisionKey(activeBranchId), fleetResult.revision ?? 1)
    }
  }, [syncSettings, activeBranchId, getAccessToken])

  /** Push local work up. A 409 means someone else saved first. */
  const syncNow = useCallback(async () => {
    if (!isConfigured(syncSettings)) {
      setSyncStatus((c) => ({ ...c, state: 'unconfigured', message: null }))
      return
    }
    setSyncStatus((c) => ({ ...c, state: 'syncing', message: null }))
    const [result, fleetStudentsNote] = await Promise.all([
      pushDataset(syncSettings, problem, revision, getAccessToken),
      pushFleet(),
    ])
    if (result.kind === 'pushed') {
      setSyncStatus({
        state: 'synced',
        lastSyncedAt: result.updatedAt ?? new Date().toISOString(),
        serverRevision: result.revision ?? null,
        message: fleetStudentsNote,
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
  }, [syncSettings, problem, revision, getAccessToken, pushFleet])

  /** Take the server copy, discarding local edits. */
  const pullFromServer = useCallback(async () => {
    if (!isConfigured(syncSettings)) {
      setSyncStatus((c) => ({ ...c, state: 'unconfigured', message: null }))
      return
    }
    setSyncStatus((c) => ({ ...c, state: 'syncing', message: null }))
    const [result] = await Promise.all([pullDataset(syncSettings, getAccessToken), pullFleet()])
    if (result.kind === 'pulled' && result.problem) {
      setProblemState(result.problem)
      setRevision(result.revision ?? 1)
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
  }, [syncSettings, getAccessToken, pullFleet])

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
      setFleet: setFleetState,
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
