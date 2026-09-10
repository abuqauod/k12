import { withoutTenant } from '../db.js'
import { isSessionDay } from '../calendar.js'
import { withLock } from '../lock.js'
import { enqueueAbsenceNotifications, processQueue } from './queue.js'

/**
 * The scheduled side of absence notifications. On each tick:
 *
 *  1. take the `absence-sweep` advisory lock (so several app instances don't
 *     each run the scan), and for every branch that is past its cutoff on a
 *     session day and hasn't been swept today, ENQUEUE jobs;
 *  2. drain the queue with `processQueue` (this part needs no lock — jobs
 *     are claimed atomically, so instances share the work).
 *
 * "Now" is evaluated in each branch's own timezone, so a 10:00 cutoff means
 * 10:00 where that campus is.
 */

function nowInZone(timezone: string): { date: string; time: string } {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date())
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = fmt(timezone)
  } catch {
    parts = fmt('UTC')
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` }
}

/** Enqueue for every branch that is due, under the sweep lock. */
export async function runDueSweeps(): Promise<void> {
  await withLock('absence-sweep', 4 * 60_000, async () => {
    const due = await withoutTenant(async (db) => {
      const settings = await db.notificationSettings.find({ absenceNotifyEnabled: true }).toArray()
      if (settings.length === 0) return []
      const branchIds = settings.map((s) => s.branchId)
      const [branches, calendars] = await Promise.all([
        db.branches.find({ _id: { $in: branchIds } }).toArray(),
        db.schoolCalendars.find({ branchId: { $in: branchIds } }).toArray(),
      ])
      const branchById = new Map(branches.map((b) => [b._id, b]))
      const calByBranch = new Map(calendars.map((c) => [c.branchId, c]))
      return settings.flatMap((s) => {
        const branch = branchById.get(s.branchId)
        if (!branch || !branch.active) return []
        return [{ settings: s, branch, calendar: calByBranch.get(s.branchId) ?? null }]
      })
    })

    for (const { settings, branch, calendar } of due) {
      const { date, time } = nowInZone(branch.timezone)
      if (!isSessionDay(calendar, date)) continue
      if (time < settings.cutoffTime) continue
      if (settings.lastSweptDate === date) continue
      try {
        await enqueueAbsenceNotifications({
          tenantId: settings.tenantId,
          branchId: settings.branchId,
          date,
          trigger: 'auto',
          actorId: null,
          respectEnabledFlag: true,
        })
      } catch (error) {
        console.error(`absence sweep failed for branch ${settings.branchId}`, error)
      }
    }
  })
}

/** One full tick: enqueue what's due, then process the queue. */
export async function sweepTick(): Promise<void> {
  await runDueSweeps()
  await processQueue()
}

/**
 * Start the loop. Called once from the server entrypoint, not from
 * `buildServer()`, so tests and smoke runs don't spawn a timer.
 */
export function startAbsenceSweeper(): () => void {
  const everyMs = Number(process.env.ABSENCE_SWEEP_INTERVAL_MS ?? 5 * 60_000)
  const timer = setInterval(() => {
    void sweepTick().catch((error) => console.error('absence sweep tick failed', error))
  }, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
