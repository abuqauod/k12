import type { Problem } from '../domain/types'
import { DEFAULT_WEIGHTS } from '../domain/types'
import { DEFAULT_CALENDAR } from '../domain/calendar'

/**
 * Local persistence for the working dataset.
 *
 * The dataset is the user's work, so it survives a reload. `SCHEMA` is bumped
 * whenever the stored shape changes so an old payload is discarded rather than
 * loaded into a model that no longer matches it.
 */
const KEY = 'timetable.dataset'
const SCHEMA = 1

export interface StoredDataset {
  schema: number
  savedAt: string
  /** Bumped on every local edit; the server uses it to detect divergence. */
  revision: number
  problem: Problem
}

export function loadDataset(): StoredDataset | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredDataset>
    if (parsed.schema !== SCHEMA || !parsed.problem) return null
    const problem = parsed.problem
    if (!Array.isArray(problem.lessons) || !Array.isArray(problem.timeslots)) return null
    return {
      schema: SCHEMA,
      savedAt: parsed.savedAt ?? new Date().toISOString(),
      revision: parsed.revision ?? 1,
      problem: {
        calendar: { ...DEFAULT_CALENDAR, ...(problem.calendar ?? {}) },
        timeslots: problem.timeslots,
        rooms: problem.rooms ?? [],
        lessons: problem.lessons,
        unavailability: problem.unavailability ?? [],
        weights: { ...DEFAULT_WEIGHTS, ...(problem.weights ?? {}) },
      },
    }
  } catch {
    // Corrupt or unreadable payload: fall back to the sample rather than crash.
    return null
  }
}

export function saveDataset(problem: Problem, revision: number): StoredDataset | null {
  const record: StoredDataset = {
    schema: SCHEMA,
    savedAt: new Date().toISOString(),
    revision,
    problem,
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(record))
    return record
  } catch {
    // Quota exceeded or storage blocked — the app keeps working in memory.
    return null
  }
}

export function clearDataset(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}
