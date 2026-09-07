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
const FLEET_KEY = 'timetable.fleet'
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

export function AppProvider({ children }: { children: ReactNode }) {
  // Restore the saved dataset; only fall back to the sample on a fresh install.
  const restored = useRef(loadDataset()).current
  const [problem, setProblemState] = useState<Problem>(() => restored?.problem ?? sampleProblem())
  const [revision, setRevision] = useState(restored?.revision ?? 1)
  const [savedAt, setSavedAt] = useState<string | null>(restored?.savedAt ?? null)

  const [budget, setBudget] = useState(5000)
  const [seed, setSeed] = useState(1337)
  const [dirty, setDirty] = useState(false)
  const [theme, setThemeState] = useState<Theme>(readTheme)
  const [fleet, setFleetState] = useState<FleetProblem>(() => {
    // Merge over the defaults rather than replacing them: a fleet saved before
    // a settings field existed must not load that field as undefined.
    const base = sampleFleet()
    const stored = readJson<FleetProblem | null>(
      FLEET_KEY,
      () => null,
      (v) => Array.isArray((v as FleetProblem)?.stops),
    )
    return stored
      ? { ...base, ...stored, settings: { ...base.settings, ...stored.settings } }
      : base
  })
  const [students, setStudentsState] = useState<Student[]>(() =>
    readJson(STUDENTS_KEY, sampleStudents, (v) => Array.isArray(v)),
  )

  useEffect(() => {
    try {
      localStorage.setItem(FLEET_KEY, JSON.stringify(fleet))
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

  /** Push local work up. A 409 means someone else saved first. */
  const syncNow = useCallback(async () => {
    if (!isConfigured(syncSettings)) {
      setSyncStatus((c) => ({ ...c, state: 'unconfigured', message: null }))
      return
    }
    setSyncStatus((c) => ({ ...c, state: 'syncing', message: null }))
    const result = await pushDataset(syncSettings, problem, revision)
    if (result.kind === 'pushed') {
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
  }, [syncSettings, problem, revision])

  /** Take the server copy, discarding local edits. */
  const pullFromServer = useCallback(async () => {
    if (!isConfigured(syncSettings)) {
      setSyncStatus((c) => ({ ...c, state: 'unconfigured', message: null }))
      return
    }
    setSyncStatus((c) => ({ ...c, state: 'syncing', message: null }))
    const result = await pullDataset(syncSettings)
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
  }, [syncSettings])

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
