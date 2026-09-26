import { randomUUID } from 'node:crypto'
import { withoutTenant, withTenant } from '../db.js'
import { tenantHasModule } from '../billing/usage.js'
import type { ReportFrequency, ReportRunDoc, ReportScheduleDoc } from '../db.js'
import { config } from '../config.js'
import { withLock } from '../lock.js'
import { recordAudit } from '../audit.js'
import { gridFsStore } from '../documents/store.js'
import { emailStaff, notifyUser, nudgeQueue, schoolName } from '../notifications/messages.js'
import { loadTemplate, render } from '../notifications/templates.js'
import { canRun, findReport, isRunFailure, runReport } from './catalog.js'
import { addDays, coversBranches, resolveRange, viewerForMember } from './common.js'
import { exportDoc } from './describe.js'
import { exportFileName, MIME, toCsv, toXlsx } from './export.js'

/**
 * SAMS 7.4: scheduled report exports. A schedule runs one catalog report
 * on a timetable as its owner — the owner's scopes and branches as they
 * are on the day, so a member who lost access stops getting data. The file
 * goes to the document store; each recipient who could run the same report
 * over the same branches gets an inbox item and an email (the Phase 6
 * queue) with a link to download it. A scheduled run is keyed by
 * schedule and day, so two instances never produce it twice.
 */

/** How many files each schedule keeps; older ones are removed. */
const KEEP_RUNS = 12

/** The first day on or after `from` the schedule runs. */
export function nextOccurrence(
  s: Pick<ReportScheduleDoc, 'frequency' | 'weekday' | 'monthDay'>,
  from: string,
): string {
  let d = from
  for (let i = 0; i < 62; i++, d = addDays(d, 1)) {
    const date = new Date(`${d}T00:00:00Z`)
    if (s.frequency === 'daily') return d
    if (s.frequency === 'weekly' && date.getUTCDay() === (s.weekday ?? 1)) return d
    if (s.frequency === 'monthly' && date.getUTCDate() === (s.monthDay ?? 1)) return d
  }
  return d
}

export const FREQUENCIES: ReportFrequency[] = ['daily', 'weekly', 'monthly']

export type ScheduleRunOutcome =
  | { ok: true; run: ReportRunDoc; notified: number; skippedRecipients: number }
  | { ok: false; error: string }

/** Runs one schedule now. `manual` (the "run now" button) makes a new file
 * every time and leaves the timetable alone. */
export async function runSchedule(
  schedule: ReportScheduleDoc,
  today: string,
  trigger: 'scheduled' | 'manual',
  actorId: string | null = null,
): Promise<ScheduleRunOutcome> {
  const tenantId = schedule.tenantId
  const fail = async (error: string): Promise<ScheduleRunOutcome> => {
    await withTenant(tenantId, (ctx) =>
      ctx.reportSchedules.findOneAndUpdate(
        { _id: schedule._id },
        {
          $set: {
            lastError: error,
            lastRunAt: new Date(),
            updatedAt: new Date(),
            ...(trigger === 'scheduled' ? { nextRunDate: nextOccurrence(schedule, addDays(today, 1)) } : {}),
          },
        },
      ),
    )
    return { ok: false, error }
  }

  const owner = await viewerForMember(tenantId, schedule.ownerId)
  if (!owner) return fail('OWNER_REMOVED')
  if (!owner.scopes.has('reports.schedule')) return fail('OWNER_NO_ACCESS')
  const year = await withTenant(tenantId, (ctx) =>
    schedule.filters.academicYearId
      ? ctx.academicYears.findOne({ _id: schedule.filters.academicYearId })
      : ctx.academicYears.findOne({ current: true }),
  )
  const range = resolveRange(schedule.range, today, year)
  const result = await runReport(owner, {
    key: schedule.reportKey,
    filters: schedule.filters,
    from: range.from,
    to: range.to,
    lang: schedule.language,
    today,
  })
  if (isRunFailure(result)) return fail(result.error === 'FORBIDDEN' ? 'OWNER_NO_ACCESS' : result.error)

  const runId = trigger === 'scheduled' ? `${schedule._id}:${today}` : `${schedule._id}:${today}:${randomUUID().slice(0, 8)}`
  const existing = await withTenant(tenantId, (ctx) => ctx.reportRuns.findOne({ _id: runId }))
  if (existing) {
    // Made already today (another instance, or a retry): just move on.
    if (trigger === 'scheduled') {
      await withTenant(tenantId, (ctx) =>
        ctx.reportSchedules.findOneAndUpdate(
          { _id: schedule._id },
          { $set: { nextRunDate: nextOccurrence(schedule, addDays(today, 1)), updatedAt: new Date() } },
        ),
      )
    }
    return { ok: true, run: existing, notified: 0, skippedRecipients: 0 }
  }

  // Recipients who may see this data: the report's scopes, and branches
  // covering what the file covers. The owner always gets it.
  const recipients: string[] = []
  let skippedRecipients = 0
  for (const userId of new Set([schedule.ownerId, ...schedule.recipients])) {
    const v = userId === schedule.ownerId ? owner : await viewerForMember(tenantId, userId)
    if (v && canRun(v, result.definition) && coversBranches(v.branchIds, result.branchIds)) recipients.push(userId)
    else skippedRecipients++
  }

  const doc = await exportDoc(tenantId, result, schedule.language, today)
  const data = schedule.format === 'xlsx' ? toXlsx(doc) : toCsv(doc)
  const fileName = exportFileName(schedule.reportKey, result.from, result.to ?? today, schedule.format)
  const stored = await gridFsStore.put(tenantId, data, { fileName, mime: MIME[schedule.format] })

  const run: ReportRunDoc = {
    _id: runId,
    tenantId,
    scheduleId: schedule._id,
    reportKey: schedule.reportKey,
    title: schedule.name || result.title,
    filters: result.applied,
    from: result.from,
    to: result.to,
    branchIds: result.branchIds,
    format: schedule.format,
    language: schedule.language,
    fileId: stored.fileId,
    fileName,
    size: stored.size,
    rows: result.table.rows.length,
    recipients,
    ownerId: schedule.ownerId,
    createdAt: new Date(),
  }

  const school = await schoolName(tenantId)
  const users = await withoutTenant((db) => db.users.find({ _id: { $in: recipients } }).toArray())
  // Its own transaction: a clash (another instance made the same run)
  // aborts only this insert.
  const { tenantId: _tenant, ...row } = run
  void _tenant
  const inserted = await withTenant(tenantId, (ctx) => ctx.reportRuns.insertOne(row))
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as { code?: number }).code === 11000) return false
      throw error
    })
  if (!inserted) {
    await gridFsStore.remove(tenantId, stored.fileId)
    const winner = await withTenant(tenantId, (ctx) => ctx.reportRuns.findOne({ _id: runId }))
    return winner ? { ok: true, run: winner, notified: 0, skippedRecipients } : { ok: false, error: 'FAILED' }
  }

  let notified = 0
  await withTenant(tenantId, async (ctx) => {
    const text = await loadTemplate(ctx, tenantId, 'report_ready')
    const period = result.from ? (result.from === result.to ? result.from : `${result.from} – ${result.to}`) : today
    const link = `${config.appUrl}/reports?tab=exports&run=${encodeURIComponent(runId)}`
    for (const user of users) {
      const tokens = { report: run.title, period, rows: String(run.rows), link, schoolName: school }
      if (!text.enabled) break
      const inApp = render(text, 'in_app', schedule.language, tokens)
      if (
        await notifyUser(ctx, tenantId, {
          userId: user._id,
          kind: 'report_ready',
          sourceId: runId,
          title: inApp.subject,
          body: inApp.body.replace(link, '').replace(/\n{3,}/g, '\n\n').trim(),
          link: `/reports?tab=exports&run=${encodeURIComponent(runId)}`,
        })
      )
        notified++
      const mail = render(text, 'email', schedule.language, tokens)
      await emailStaff(ctx, tenantId, {
        kind: 'report_ready',
        sourceId: runId,
        branchId: result.branchIds?.[0] ?? '',
        userId: user._id,
        name: user.displayName,
        email: user.email,
        language: schedule.language,
        subject: mail.subject,
        body: mail.body,
      })
    }
    await ctx.reportSchedules.findOneAndUpdate(
      { _id: schedule._id },
      {
        $set: {
          lastRunAt: run.createdAt,
          lastRunId: runId,
          lastError: null,
          updatedAt: new Date(),
          ...(trigger === 'scheduled' ? { nextRunDate: nextOccurrence(schedule, addDays(today, 1)) } : {}),
        },
      },
    )
    await recordAudit(ctx.auditLog, {
      actorId,
      action: 'report.export',
      entity: 'reportSchedule',
      entityId: schedule._id,
      branchId: result.branchIds?.length === 1 ? result.branchIds[0] : null,
      meta: { runId, reportKey: schedule.reportKey, rows: run.rows, recipients: recipients.length, trigger },
    })
  })
  await pruneRuns(tenantId, schedule._id)
  nudgeQueue()
  return { ok: true, run, notified, skippedRecipients }
}

/** Keeps the newest files of a schedule; removes the rest with their bytes. */
async function pruneRuns(tenantId: string, scheduleId: string): Promise<void> {
  const old = await withTenant(tenantId, async (ctx) => {
    const runs = await ctx.reportRuns.find({ scheduleId }).sort({ createdAt: -1 }).toArray()
    const drop = runs.slice(KEEP_RUNS)
    if (drop.length) await ctx.reportRuns.deleteMany({ _id: { $in: drop.map((r) => r._id) } })
    return drop
  })
  for (const r of old) await gridFsStore.remove(tenantId, r.fileId).catch(() => undefined)
}

/** Every schedule due today, across tenants (the sweep calls this). */
export async function runDueSchedules(today = new Date().toISOString().slice(0, 10)): Promise<void> {
  await withLock('report-schedules', 15 * 60_000, async () => {
    const due = await withoutTenant((db) => db.reportSchedules.find({ active: true, nextRunDate: { $lte: today } }).toArray())
    for (const schedule of due) {
      // Kept, not run, while the school's plan lacks scheduled reports.
      if (!(await tenantHasModule(schedule.tenantId, 'scheduledReports'))) continue
      try {
        await runSchedule(schedule, today, 'scheduled')
      } catch (error) {
        console.error(`scheduled report ${schedule._id} failed`, error)
        await withTenant(schedule.tenantId, (ctx) =>
          ctx.reportSchedules.findOneAndUpdate(
            { _id: schedule._id },
            { $set: { lastError: 'FAILED', nextRunDate: nextOccurrence(schedule, addDays(today, 1)), updatedAt: new Date() } },
          ),
        ).catch(() => undefined)
      }
    }
  })
}

/** Whether `userId` may download a run: named on it (or its owner), and
 * still able to run that report over those branches. */
export async function canDownload(run: ReportRunDoc, userId: string): Promise<boolean> {
  if (!run.recipients.includes(userId) && run.ownerId !== userId) return false
  const def = findReport(run.reportKey)
  const viewer = await viewerForMember(run.tenantId, userId)
  return !!def && !!viewer && canRun(viewer, def) && coversBranches(viewer.branchIds, run.branchIds)
}
