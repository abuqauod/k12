import { withoutTenant } from '../db.js'
import { notifyAbsentees } from './service.js'

/**
 * The scheduled side of absence notifications. Every few minutes the server
 * asks: which branches, across every tenant, have the feature on, and is it
 * now past their cutoff time on a school day, and have they not already been
 * swept today? For each, run `notifyAbsentees` — which records
 * `lastSweptDate` so it won't fire again until tomorrow.
 *
 * "Now" is evaluated in each branch's own timezone, so a 10:00 cutoff means
 * 10:00 where that campus is, not on the server.
 */

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function nowInZone(timezone: string): { date: string; time: string; weekday: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(new Date())
  } catch {
    // An unknown timezone string: fall back to UTC rather than throw and
    // stall the whole sweep.
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(new Date())
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
    weekday: WEEKDAY[get('weekday')] ?? 0,
  }
}

export async function runDueSweeps(): Promise<void> {
  const branches = await withoutTenant(async (db) => {
    const settings = await db.notificationSettings.find({ absenceNotifyEnabled: true }).toArray()
    if (settings.length === 0) return []
    const ids = settings.map((s) => s.branchId)
    const branchDocs = await db.branches.find({ _id: { $in: ids } }).toArray()
    const byId = new Map(branchDocs.map((b) => [b._id, b]))
    return settings
      .map((s) => ({ settings: s, branch: byId.get(s.branchId) }))
      .filter((row): row is { settings: (typeof settings)[number]; branch: (typeof branchDocs)[number] } =>
        Boolean(row.branch),
      )
  })

  for (const { settings, branch } of branches) {
    if (!branch.active) continue
    const { date, time, weekday } = nowInZone(branch.timezone)
    if (!settings.schoolDays.includes(weekday)) continue
    if (time < settings.cutoffTime) continue
    if (settings.lastSweptDate === date) continue
    try {
      await notifyAbsentees({
        tenantId: settings.tenantId,
        branchId: settings.branchId,
        date,
        trigger: 'auto',
        actorId: null,
      })
    } catch (error) {
      console.error(`absence sweep failed for branch ${settings.branchId}`, error)
    }
  }
}

/** Start the interval loop. Called once from the server entrypoint, not from
 * `buildServer()`, so tests and smoke runs don't spawn a timer. */
export function startAbsenceSweeper(): () => void {
  const everyMs = Number(process.env.ABSENCE_SWEEP_INTERVAL_MS ?? 5 * 60_000)
  const timer = setInterval(() => {
    void runDueSweeps().catch((error) => console.error('absence sweep tick failed', error))
  }, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
