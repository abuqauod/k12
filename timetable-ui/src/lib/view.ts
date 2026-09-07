import type {
  DayOfWeek,
  Lesson,
  Problem,
  Room,
  Solution,
  Timeslot,
  Violation,
} from '../domain/types'
import { DAYS_OF_WEEK } from '../domain/types'
import { teachingSlotsFor, weekOrder } from '../domain/calendar'

export interface PlacedLesson {
  lesson: Lesson
  timeslot: Timeslot | null
  room: Room | null
  dayOfWeek: DayOfWeek | null
  period: number
}

export type Dimension = 'studentGroup' | 'teacher' | 'room'

export interface GridAxes {
  days: DayOfWeek[]
  periods: Array<{ index: number; label: string; start: string; end: string }>
  /** `${day}|${periodIndex}` -> timeslot id */
  slotKeys: Map<string, string>
}

export const hhmm = (time: string) => time.slice(0, 5)

export function buildAxes(timeslots: Timeslot[], weekStart: DayOfWeek): GridAxes {
  const days = weekOrder(weekStart).filter((day) =>
    timeslots.some((slot) => slot.dayOfWeek === day),
  )
  const slotKeys = new Map<string, string>()
  let widest: Timeslot[] = []

  for (const day of days) {
    const ordered = timeslots
      .filter((slot) => slot.dayOfWeek === day)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
    ordered.forEach((slot, index) => slotKeys.set(`${day}|${index}`, slot.id))
    if (ordered.length > widest.length) widest = ordered
  }

  const periods = widest.map((slot, index) => ({
    index,
    label: `P${index + 1}`,
    start: hhmm(slot.startTime),
    end: hhmm(slot.endTime),
  }))

  return { days, periods, slotKeys }
}

export function placeLessons(problem: Problem, solution: Solution | null): PlacedLesson[] {
  const slotById = new Map(problem.timeslots.map((slot) => [slot.id, slot]))
  const roomById = new Map(problem.rooms.map((room) => [room.id, room]))
  const byLesson = new Map(
    (solution?.assignments ?? []).map((assignment) => [assignment.lessonId, assignment]),
  )
  const periodOf = periodIndexer(problem.timeslots)

  return problem.lessons.map((lesson) => {
    const assignment = byLesson.get(lesson.id)
    const timeslot = assignment?.timeslotId ? slotById.get(assignment.timeslotId) ?? null : null
    const room = assignment?.roomId ? roomById.get(assignment.roomId) ?? null : null
    return {
      lesson,
      timeslot,
      room,
      dayOfWeek: timeslot?.dayOfWeek ?? null,
      period: timeslot ? periodOf.get(timeslot.id) ?? -1 : -1,
    }
  })
}

function periodIndexer(timeslots: Timeslot[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const day of DAYS_OF_WEEK) {
    timeslots
      .filter((slot) => slot.dayOfWeek === day)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .forEach((slot, index) => out.set(slot.id, index))
  }
  return out
}

export function dimensionValue(placed: PlacedLesson, dimension: Dimension): string {
  if (dimension === 'studentGroup') return placed.lesson.studentGroup
  if (dimension === 'teacher') return placed.lesson.teacher
  return placed.room?.name ?? 'Unassigned'
}

export function dimensionOptions(problem: Problem, dimension: Dimension): string[] {
  if (dimension === 'studentGroup') {
    return unique(problem.lessons.map((lesson) => lesson.studentGroup)).sort(naturalCompare)
  }
  if (dimension === 'teacher') {
    return unique(problem.lessons.map((lesson) => lesson.teacher)).sort(naturalCompare)
  }
  return problem.rooms.map((room) => room.name).sort(naturalCompare)
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

/** "Grade 4-B" sorts after "Grade 2-A" rather than lexically. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/** Stable hue per subject so a subject keeps its colour across every view. */
export function subjectHue(subject: string): number {
  let hash = 0
  for (let i = 0; i < subject.length; i++) {
    hash = (hash * 31 + subject.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 360
}

export function violationLessonIds(violations: Violation[]): Set<string> {
  const out = new Set<string>()
  for (const violation of violations) {
    if (violation.level !== 'HARD') continue
    for (const id of violation.lessonIds) out.add(id)
  }
  return out
}

export interface Coverage {
  group: string
  scheduled: number
  capacity: number
}

/**
 * How full each cohort week is — a quick sanity read before solving. Capacity
 * excludes the periods that cohort has reserved as breaks.
 */
export function coverage(problem: Problem): Coverage[] {
  const counts = new Map<string, number>()
  for (const lesson of problem.lessons) {
    counts.set(lesson.studentGroup, (counts.get(lesson.studentGroup) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([group, scheduled]) => ({
      group,
      scheduled,
      capacity: teachingSlotsFor(problem.calendar, problem.timeslots, group),
    }))
    .sort((a, b) => naturalCompare(a.group, b.group))
}
