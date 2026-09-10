import { withoutTenant, withTenant } from '../db.js'
import type { NotificationLogDoc, NotifyChannel } from '../db.js'
import { deliver, deliveryErrorCode } from './channels.js'
import { effectiveSettings, renderTemplate } from './settings.js'

/**
 * Send the unexplained-absence notice to the guardians of every student in a
 * branch who, for `date`, is marked absent (or has no record at all, when
 * the branch's settings say an unmarked student counts). Used by both the
 * manual button and the scheduled sweep.
 *
 * Shape: read everything needed in one tenant transaction, do the actual
 * sends OUTSIDE any transaction (they're slow, external and can't roll
 * back), then write the log rows in a second transaction. The log is also
 * the idempotency record — a student with a 'sent' row for this date and
 * channel is not contacted again.
 */

export interface NotifyOutcome {
  branchId: string
  date: string
  attempted: number
  sent: number
  failed: number
  skipped: number
}

interface PendingSend {
  studentId: string
  channel: NotifyChannel
  to: string
  guardianName: string
  subject: string
  body: string
}

export async function notifyAbsentees(params: {
  tenantId: string
  branchId: string
  date: string
  trigger: 'auto' | 'manual'
  actorId: string | null
  /** Limit to one student — the per-row "notify" button. */
  studentId?: string
}): Promise<NotifyOutcome> {
  const { tenantId, branchId, date, trigger, actorId } = params
  const zero: NotifyOutcome = { branchId, date, attempted: 0, sent: 0, failed: 0, skipped: 0 }

  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
  if (!tenant) return zero

  const read = await withTenant(tenantId, async (ctx) => {
    const branch = await ctx.branches.findOne({ _id: branchId })
    if (!branch) return null
    const settingsDoc = await ctx.notificationSettings.findOne({ _id: `${tenantId}:${branchId}` })
    const roster = await ctx.students.find({ branchId, status: 'enrolled' }).toArray()
    const records = await ctx.attendance.find({ branchId, date }).toArray()
    const priorLog = await ctx.notificationLog.find({ branchId, date }).toArray()
    return { branch, settings: effectiveSettings(settingsDoc), roster, records, priorLog }
  })
  if (!read) return zero

  const { branch, settings, roster, records, priorLog } = read
  const statusByStudent = new Map(records.map((r) => [r.studentId, r.status]))
  const alreadySent = new Set(
    priorLog.filter((l) => l.status === 'sent').map((l) => `${l.studentId}:${l.channel}`),
  )

  const targets = roster.filter((s) => {
    if (params.studentId && s._id !== params.studentId) return false
    const status = statusByStudent.get(s._id)
    if (status === 'absent') return true
    return status === undefined && settings.notifyOnUnmarked
  })

  const now = new Date()
  const pending: PendingSend[] = []
  const logRows: NotificationLogDoc[] = []
  const outcome: NotifyOutcome = { ...zero }

  for (const student of targets) {
    const guardian =
      student.guardians.find((g) => g.isPrimary) ?? student.guardians[0] ?? null
    const studentName = `${student.givenName} ${student.familyName}`.trim()
    const tokens = {
      studentName,
      date,
      schoolName: tenant.name,
      branchName: branch.name,
    }

    for (const channel of settings.channels) {
      if (alreadySent.has(`${student._id}:${channel}`)) {
        outcome.skipped++
        continue
      }
      outcome.attempted++
      const to = channel === 'email' ? (guardian?.email ?? '') : (guardian?.phone ?? '')
      const base = {
        _id: `${tenantId}:${branchId}:${student._id}:${date}:${channel}`,
        tenantId,
        branchId,
        studentId: student._id,
        date,
        channel,
        to,
        guardianName: guardian?.name ?? '',
        trigger,
        actorId,
        createdAt: now,
      }
      if (!guardian || !to) {
        logRows.push({ ...base, status: 'failed', error: 'NO_GUARDIAN_CONTACT' })
        outcome.failed++
        continue
      }
      pending.push({
        studentId: student._id,
        channel,
        to,
        guardianName: guardian.name,
        subject: renderTemplate(settings.emailSubject, tokens),
        body: renderTemplate(channel === 'email' ? settings.emailBody : settings.smsBody, tokens),
      })
    }
  }

  // The slow part — no transaction held open across it.
  for (const send of pending) {
    const base = {
      _id: `${tenantId}:${branchId}:${send.studentId}:${date}:${send.channel}`,
      tenantId,
      branchId,
      studentId: send.studentId,
      date,
      channel: send.channel,
      to: send.to,
      guardianName: send.guardianName,
      trigger,
      actorId,
      createdAt: now,
    }
    try {
      await deliver({ channel: send.channel, to: send.to, subject: send.subject, body: send.body })
      logRows.push({ ...base, status: 'sent', error: null })
      outcome.sent++
    } catch (error) {
      logRows.push({ ...base, status: 'failed', error: deliveryErrorCode(error) })
      outcome.failed++
    }
  }

  await withTenant(tenantId, async (ctx) => {
    for (const row of logRows) {
      await ctx.notificationLog.findOneAndUpdate(
        { _id: row._id },
        {
          $set: {
            branchId: row.branchId,
            studentId: row.studentId,
            date: row.date,
            channel: row.channel,
            to: row.to,
            guardianName: row.guardianName,
            status: row.status,
            error: row.error,
            trigger: row.trigger,
            actorId: row.actorId,
            createdAt: row.createdAt,
          },
        },
        { upsert: true },
      )
    }
    if (trigger === 'auto') {
      await ctx.notificationSettings.findOneAndUpdate(
        { _id: `${tenantId}:${branchId}` },
        { $set: { lastSweptDate: date, updatedAt: now } },
      )
    }
  })

  return outcome
}
