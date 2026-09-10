import type { SchoolCalendarDoc } from './db.js'

/** The default working week where this is deployed: Sunday–Thursday. */
export const DEFAULT_WORKING_DAYS = [0, 1, 2, 3, 4]

/** 0 = Sunday … 6 = Saturday, for an ISO `yyyy-mm-dd`. Computed in UTC so it
 * is the calendar day's weekday, not shifted by the server's zone. */
export function weekdayOf(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay()
}

/**
 * Is `dateIso` a day this branch holds classes? A working weekday that is
 * not a listed holiday. With no calendar row we fall back to the default
 * working week and no holidays, so a branch that never configured one still
 * behaves sanely.
 */
export function isSessionDay(calendar: SchoolCalendarDoc | null, dateIso: string): boolean {
  const workingDays = calendar?.workingDays ?? DEFAULT_WORKING_DAYS
  if (!workingDays.includes(weekdayOf(dateIso))) return false
  if (calendar?.holidays.some((h) => h.date === dateIso)) return false
  return true
}
