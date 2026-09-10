import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { NotificationJobDoc } from '../db.js'
import {
  authenticate,
  callerCanUseBranch,
  requireActiveSubscription,
  requireRole,
} from '../auth/guard.js'
import { DEFAULT_WORKING_DAYS } from '../calendar.js'
import { runAbsenceNotifications } from './service.js'
import { effectiveSettings } from './settings.js'

/**
 * Per-branch absence-notification settings, the per-branch school calendar,
 * the delivery log (one row per queued job) and the manual "notify now"
 * trigger. The scheduled sweep enqueues into the same queue this trigger
 * does.
 */

const settingsBody = z.object({
  absenceNotifyEnabled: z.boolean(),
  cutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm'),
  channels: z.array(z.enum(['email', 'sms'])).min(1).max(2),
  notifyOnUnmarked: z.boolean(),
  emailSubject: z.string().min(1).max(200),
  emailBody: z.string().min(1).max(4000),
  smsBody: z.string().min(1).max(600),
  emailSubjectAr: z.string().max(200).default(''),
  emailBodyAr: z.string().max(4000).default(''),
  smsBodyAr: z.string().max(600).default(''),
})

const calendarBody = z.object({
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  holidays: z
    .array(z.object({ date: z.string().date(), name: z.string().min(1).max(120) }))
    .max(200)
    .default([]),
})

const runBody = z.object({
  branchId: z.string().min(1),
  date: z.string().date().optional(),
  studentId: z.string().min(1).optional(),
})

const logQuery = z.object({
  branchId: z.string().optional(),
  date: z.string().date().optional(),
  studentId: z.string().optional(),
  status: z.enum(['pending', 'processing', 'sent', 'failed', 'dead', 'skipped']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

export function registerNotificationRoutes(app: FastifyInstance): void {
  const adminGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('admin')] }
  const runGuard = { preHandler: [authenticate, requireActiveSubscription, requireRole('scheduler')] }

  app.get('/branches/:branchId/notification-settings', adminGuard, async (request, reply) => {
    const { branchId } = request.params as { branchId: string }
    if (!(await callerCanUseBranch(request, branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    const tenantId = request.auth!.tenantId!
    const { branch, doc } = await withTenant(tenantId, async (ctx) => {
      const branch = await ctx.branches.findOne({ _id: branchId })
      const doc = await ctx.notificationSettings.findOne({ _id: `${tenantId}:${branchId}` })
      return { branch, doc }
    })
    if (!branch) return reply.code(404).send({ error: 'UNKNOWN_BRANCH' })
    return reply.send({ ...effectiveSettings(doc), lastSweptDate: doc?.lastSweptDate ?? null })
  })

  app.put('/branches/:branchId/notification-settings', adminGuard, async (request, reply) => {
    const { branchId } = request.params as { branchId: string }
    const parsed = settingsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const tenantId = request.auth!.tenantId!
    const ok = await withTenant(tenantId, async (ctx) => {
      const branch = await ctx.branches.findOne({ _id: branchId })
      if (!branch) return false
      await ctx.notificationSettings.findOneAndUpdate(
        { _id: `${tenantId}:${branchId}` },
        {
          $set: { branchId, ...parsed.data, updatedAt: new Date() },
          $setOnInsert: { lastSweptDate: null },
        },
        { upsert: true },
      )
      return true
    })
    if (!ok) return reply.code(404).send({ error: 'UNKNOWN_BRANCH' })
    return reply.send({ ok: true })
  })

  app.get('/branches/:branchId/calendar', adminGuard, async (request, reply) => {
    const { branchId } = request.params as { branchId: string }
    if (!(await callerCanUseBranch(request, branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }
    const tenantId = request.auth!.tenantId!
    const { branch, doc } = await withTenant(tenantId, async (ctx) => {
      const branch = await ctx.branches.findOne({ _id: branchId })
      const doc = await ctx.schoolCalendars.findOne({ _id: `${tenantId}:${branchId}` })
      return { branch, doc }
    })
    if (!branch) return reply.code(404).send({ error: 'UNKNOWN_BRANCH' })
    return reply.send({
      workingDays: doc?.workingDays ?? DEFAULT_WORKING_DAYS,
      holidays: doc?.holidays ?? [],
    })
  })

  app.put('/branches/:branchId/calendar', adminGuard, async (request, reply) => {
    const { branchId } = request.params as { branchId: string }
    const parsed = calendarBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const tenantId = request.auth!.tenantId!
    const ok = await withTenant(tenantId, async (ctx) => {
      const branch = await ctx.branches.findOne({ _id: branchId })
      if (!branch) return false
      await ctx.schoolCalendars.findOneAndUpdate(
        { _id: `${tenantId}:${branchId}` },
        {
          $set: {
            branchId,
            workingDays: parsed.data.workingDays,
            holidays: parsed.data.holidays,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      )
      return true
    })
    if (!ok) return reply.code(404).send({ error: 'UNKNOWN_BRANCH' })
    return reply.send({ ok: true })
  })

  app.get('/notifications', adminGuard, async (request, reply) => {
    const parsed = logQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { branchId, date, studentId, status, limit } = parsed.data
    if (branchId && !(await callerCanUseBranch(request, branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const filter: Filter<NotificationJobDoc> = {}
    if (branchId) filter.branchId = branchId
    if (date) filter.date = date
    if (studentId) filter.studentId = studentId
    if (status) filter.status = status

    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.notificationJobs.find(filter).sort({ createdAt: -1 }).limit(limit).toArray(),
    )
    return reply.send({
      entries: rows.map((r) => ({
        id: r._id,
        branchId: r.branchId,
        studentId: r.studentId,
        guardianId: r.guardianId,
        date: r.date,
        channel: r.channel,
        to: r.to,
        guardianName: r.guardianName,
        language: r.language,
        status: r.status,
        attempts: r.attempts,
        error: r.lastError,
        providerMessageId: r.providerMessageId,
        trigger: r.trigger,
        actorId: r.actorId,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    })
  })

  app.post('/notifications/run', runGuard, async (request, reply) => {
    const parsed = runBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    if (!(await callerCanUseBranch(request, parsed.data.branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const date = parsed.data.date ?? new Date().toISOString().slice(0, 10)
    const outcome = await runAbsenceNotifications({
      tenantId: request.auth!.tenantId!,
      branchId: parsed.data.branchId,
      date,
      actorId: request.auth!.sub,
      studentId: parsed.data.studentId,
    })
    return reply.send(outcome)
  })
}
