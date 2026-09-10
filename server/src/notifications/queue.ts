import { randomUUID } from 'node:crypto'
import { withoutTenant, withTenant } from '../db.js'
import type { GuardianLanguage, NotificationJobDoc } from '../db.js'
import { isSessionDay } from '../calendar.js'
import { recordAudit } from '../audit.js'
import { deliver, deliveryErrorCode, isPermanent } from './channels.js'
import { effectiveSettings, renderMessage } from './settings.js'

/**
 * Absence notifications are a queue. `enqueueAbsenceNotifications` scans a
 * branch/day and writes one PENDING `NotificationJobDoc` per (absent
 * student × opted-in active guardian × enabled channel). `processQueue`
 * drains it — one `NotificationAttemptDoc` per try, exponential backoff
 * between retries, `dead` after `maxAttempts` or a permanent error.
 *
 *   - Enqueue is fast and never blocked by a slow/failing provider.
 *   - Jobs have a deterministic `_id`, so re-running a sweep for the same
 *     day re-touches the same jobs (`$setOnInsert`) instead of duplicating —
 *     this is what makes it safe for the sweep to run on several instances.
 *   - `processQueue` claims each job atomically (pending/failed -> processing),
 *     so parallel workers never double-send one job.
 */

const MAX_ATTEMPTS = Number(process.env.NOTIFY_MAX_ATTEMPTS ?? 3)

/** 2 min, 4 min, 8 min … capped at 1 hour. */
export function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 60_000, 3_600_000)
}

export interface EnqueueOutcome {
  branchId: string
  date: string
  absentees: number
  enqueued: number
  alreadyQueued: number
  noGuardian: number
}

export async function enqueueAbsenceNotifications(params: {
  tenantId: string
  branchId: string
  date: string
  trigger: 'auto' | 'manual'
  actorId: string | null
  /** Limit to one student — the per-row "notify" button. */
  studentId?: string
  /** Auto respects the enabled flag; a manual press does not. */
  respectEnabledFlag: boolean
}): Promise<EnqueueOutcome> {
  const { tenantId, branchId, date, trigger, actorId } = params
  const zero: EnqueueOutcome = {
    branchId,
    date,
    absentees: 0,
    enqueued: 0,
    alreadyQueued: 0,
    noGuardian: 0,
  }

  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
  if (!tenant) return zero

  return withTenant(tenantId, async (ctx) => {
    const branch = await ctx.branches.findOne({ _id: branchId })
    if (!branch) return zero

    const settingsDoc = await ctx.notificationSettings.findOne({ _id: `${tenantId}:${branchId}` })
    const settings = effectiveSettings(settingsDoc)
    if (params.respectEnabledFlag && !settings.absenceNotifyEnabled) return zero

    const calendar = await ctx.schoolCalendars.findOne({ _id: `${tenantId}:${branchId}` })
    if (!isSessionDay(calendar, date)) return zero

    const roster = await ctx.students.find({ branchId, status: 'enrolled' }).toArray()
    const records = await ctx.attendance.find({ branchId, date }).toArray()
    const statusByStudent = new Map(records.map((r) => [r.studentId, r.status]))

    const absentees = roster.filter((s) => {
      if (params.studentId && s._id !== params.studentId) return false
      const status = statusByStudent.get(s._id)
      if (status === 'absent') return true
      return status === undefined && settings.notifyOnUnmarked
    })

    const now = new Date()
    const outcome: EnqueueOutcome = { ...zero, absentees: absentees.length }

    for (const student of absentees) {
      const guardians = student.guardians.filter((g) => g.active)
      const studentName = `${student.givenName} ${student.familyName}`.trim()
      const tokens = { studentName, date, schoolName: tenant.name, branchName: branch.name }

      let sentToAny = false
      for (const guardian of guardians) {
        for (const channel of settings.channels) {
          const wants = channel === 'email' ? guardian.notifyByEmail : guardian.notifyBySms
          if (!wants) continue
          const to = channel === 'email' ? (guardian.email ?? '') : (guardian.phone ?? '')
          if (!to) continue
          sentToAny = true

          const language: GuardianLanguage = guardian.preferredLanguage
          const msg = renderMessage(settings, channel, language, tokens)
          const _id = `${tenantId}:${branchId}:${student._id}:${date}:${channel}:${guardian.id}`
          const job: Omit<NotificationJobDoc, '_id' | 'tenantId'> = {
            branchId,
            studentId: student._id,
            guardianId: guardian.id,
            date,
            channel,
            to,
            guardianName: guardian.name,
            language,
            subject: msg.subject,
            body: msg.body,
            status: 'pending',
            attempts: 0,
            maxAttempts: MAX_ATTEMPTS,
            nextAttemptAt: now,
            lastError: null,
            providerMessageId: null,
            trigger,
            actorId,
            createdAt: now,
            updatedAt: now,
          }
          const res = await ctx.notificationJobs.findOneAndUpdate(
            { _id },
            { $setOnInsert: job },
            { upsert: true, returnDocument: 'before' },
          )
          if (res) outcome.alreadyQueued++
          else outcome.enqueued++
        }
      }
      if (!sentToAny) outcome.noGuardian++
    }

    if (trigger === 'auto') {
      await ctx.notificationSettings.findOneAndUpdate(
        { _id: `${tenantId}:${branchId}` },
        { $set: { lastSweptDate: date, updatedAt: now } },
      )
    }

    if (outcome.enqueued > 0) {
      await recordAudit(ctx.auditLog, {
        actorId,
        action: trigger === 'auto' ? 'notifications.sweep' : 'notifications.run',
        entity: 'branch',
        entityId: branchId,
        meta: { ...outcome },
      })
    }
    return outcome
  })
}

export interface ProcessOutcome {
  claimed: number
  sent: number
  retried: number
  dead: number
}

/**
 * Drain up to `limit` due jobs across every tenant. Safe to run on several
 * instances at once — each job is claimed by an atomic status transition.
 */
export async function processQueue(limit = 25): Promise<ProcessOutcome> {
  const outcome: ProcessOutcome = { claimed: 0, sent: 0, retried: 0, dead: 0 }

  for (let i = 0; i < limit; i++) {
    const now = new Date()
    const job = await withoutTenant((db) =>
      db.notificationJobs.findOneAndUpdate(
        { status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: now } },
        { $set: { status: 'processing', updatedAt: now } },
        { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
      ),
    )
    if (!job) break
    outcome.claimed++

    const attemptNo = job.attempts + 1
    const startedAt = new Date()
    let attemptStatus: 'sent' | 'failed' = 'failed'
    let providerMessageId: string | null = null
    let error: string | null = null
    let permanent = false

    try {
      const res = await deliver({
        channel: job.channel,
        to: job.to,
        subject: job.subject,
        body: job.body,
      })
      attemptStatus = 'sent'
      providerMessageId = res.providerMessageId
    } catch (err) {
      error = deliveryErrorCode(err)
      permanent = isPermanent(err)
    }
    const finishedAt = new Date()

    await withoutTenant((db) =>
      db.notificationAttempts.insertOne({
        _id: randomUUID(),
        tenantId: job.tenantId,
        jobId: job._id,
        channel: job.channel,
        attemptNo,
        status: attemptStatus,
        providerMessageId,
        error,
        startedAt,
        finishedAt,
      }),
    )

    if (attemptStatus === 'sent') {
      await withoutTenant((db) =>
        db.notificationJobs.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'sent',
              attempts: attemptNo,
              providerMessageId,
              nextAttemptAt: null,
              lastError: null,
              updatedAt: new Date(),
            },
          },
        ),
      )
      outcome.sent++
      continue
    }

    const giveUp = permanent || attemptNo >= job.maxAttempts
    await withoutTenant((db) =>
      db.notificationJobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: giveUp ? 'dead' : 'failed',
            attempts: attemptNo,
            lastError: error,
            nextAttemptAt: giveUp ? null : new Date(Date.now() + backoffMs(attemptNo)),
            updatedAt: new Date(),
          },
        },
      ),
    )
    if (giveUp) outcome.dead++
    else outcome.retried++
  }

  return outcome
}
