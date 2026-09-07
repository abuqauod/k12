import type { BreakRule, Calendar, DayOfWeek, Problem, Timeslot } from './types'
import { DAYS_OF_WEEK } from './types'

/** The seven days rotated so `weekStart` comes first. */
export function weekOrder(weekStart: DayOfWeek): DayOfWeek[] {
  const start = DAYS_OF_WEEK.indexOf(weekStart)
  return Array.from({ length: 7 }, (_, i) => DAYS_OF_WEEK[(start + i) % 7])
}

/** The teaching days of the week, in order. */
export function schoolDays(calendar: Calendar): DayOfWeek[] {
  return weekOrder(calendar.weekStart).slice(0, Math.max(1, Math.min(7, calendar.schoolDays)))
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':')
  return Number(hours) * 60 + Number(minutes)
}

function toClock(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0')
  const mm = String(wrapped % 60).padStart(2, '0')
  return `${hh}:${mm}:00`
}

/** Total CLOCK-break minutes inserted after each 1-based period. */
export function clockGaps(calendar: Calendar): Map<number, BreakRule[]> {
  const map = new Map<number, BreakRule[]>()
  for (const rule of calendar.breaks) {
    if (rule.kind !== 'CLOCK') continue
    const list = map.get(rule.period)
    if (list) list.push(rule)
    else map.set(rule.period, [rule])
  }
  return map
}

/**
 * Lays the week out from the calendar. Timeslot ids are keyed to day index and
 * period number, so they survive a change of `weekStart`.
 */
export function generateTimeslots(calendar: Calendar): Timeslot[] {
  const days = schoolDays(calendar)
  const gaps = clockGaps(calendar)
  const periods = Math.max(1, Math.min(32, calendar.periodsPerDay))
  const length = Math.max(5, calendar.periodMinutes)
  const slots: Timeslot[] = []

  days.forEach((day, dayIndex) => {
    let cursor = toMinutes(calendar.dayStart)
    for (let period = 1; period <= periods; period++) {
      slots.push({
        id: `TS-${dayIndex + 1}${String(period).padStart(2, '0')}`,
        dayOfWeek: day,
        startTime: toClock(cursor),
        endTime: toClock(cursor + length),
      })
      cursor += length
      for (const rule of gaps.get(period) ?? []) cursor += Math.max(0, rule.minutes)
    }
  })

  return slots
}

/** The PERIOD break covering `studentGroup` at a 0-based period index, if any. */
export function breakAt(
  calendar: Calendar,
  studentGroup: string,
  periodIndex: number,
): BreakRule | undefined {
  return calendar.breaks.find(
    (rule) =>
      rule.kind === 'PERIOD' &&
      rule.period === periodIndex + 1 &&
      (rule.studentGroups.length === 0 || rule.studentGroups.includes(studentGroup)),
  )
}

/** A PERIOD break that covers every cohort at a 0-based period index. */
export function wholeSchoolBreakAt(
  calendar: Calendar,
  periodIndex: number,
): BreakRule | undefined {
  return calendar.breaks.find(
    (rule) =>
      rule.kind === 'PERIOD' && rule.period === periodIndex + 1 && rule.studentGroups.length === 0,
  )
}

/**
 * Rebuilds the timeslots from the calendar and drops references that the new
 * layout no longer contains.
 */
export function applyCalendar(problem: Problem, calendar: Calendar): Problem {
  const timeslots = generateTimeslots(calendar)
  const ids = new Set(timeslots.map((slot) => slot.id))
  return {
    ...problem,
    calendar,
    timeslots,
    unavailability: problem.unavailability.filter((entry) => ids.has(entry.timeslotId)),
    lessons: problem.lessons.map((lesson) =>
      lesson.pinnedTimeslotId && !ids.has(lesson.pinnedTimeslotId)
        ? { ...lesson, pinnedTimeslotId: undefined }
        : lesson,
    ),
  }
}

/** How many teaching slots a cohort actually has once its breaks are removed. */
export function teachingSlotsFor(
  calendar: Calendar,
  timeslots: Timeslot[],
  studentGroup: string,
): number {
  const periods = Math.max(1, calendar.periodsPerDay)
  let reservedPerDay = 0
  for (let period = 0; period < periods; period++) {
    if (breakAt(calendar, studentGroup, period)) reservedPerDay++
  }
  const days = new Set(timeslots.map((slot) => slot.dayOfWeek)).size
  return Math.max(0, timeslots.length - reservedPerDay * days)
}

export const DEFAULT_CALENDAR: Calendar = {
  weekStart: 'SUNDAY',
  schoolDays: 5,
  dayStart: '08:00:00',
  periodMinutes: 45,
  periodsPerDay: 7,
  breaks: [
    {
      id: 'BR-1',
      name: 'Morning break',
      kind: 'CLOCK',
      period: 2,
      minutes: 20,
      studentGroups: [],
    },
    {
      id: 'BR-2',
      name: 'Lunch',
      kind: 'PERIOD',
      period: 5,
      minutes: 0,
      studentGroups: [],
    },
  ],
}
