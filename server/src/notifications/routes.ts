import type { FastifyInstance } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { NotificationLogDoc } from '../db.js'
import {
  authenticate,
  callerCanUseBranch,
  requireActiveSubscription,
  requireRole,
} from '../auth/guard.js'
import { notifyAbsentees } from './service.js'
import { effectiveSettings } from './settings.js'

/**
 * Per-branch absence-notification settings, the send log, and the manual
 * "notify now" trigger. The scheduled sweep (sweep.ts) calls the same
 * `notifyAbsentees` this route's POST does.
 */

const settingsBody = z.object({
  absenceNotifyEnabled: z.boolean(),
  cutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm'),
  channels: z.array(z.enum(['email', 'sms'])).min(1).max(2),
  notifyOnUnmarked: z.boolean(),
  schoolDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  emailSubject: z.string().min(1).max(200),
  emailBody: z.string().min(1).max(4000),
  smsBody: z.string().min(1).max(600),
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

  app.get('/notifications', adminGuard, async (request, reply) => {
    const parsed = logQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const { branchId, date, studentId, limit } = parsed.data
    if (branchId && !(await callerCanUseBranch(request, branchId))) {
      return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    }

    const filter: Filter<NotificationLogDoc> = {}
    if (branchId) filter.branchId = branchId
    if (date) filter.date = date
    if (studentId) filter.studentId = studentId

    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.notificationLog.find(filter).sort({ createdAt: -1 }).limit(limit).toArray(),
    )
    return reply.send({
      entries: rows.map((r) => ({
        id: r._id,
        branchId: r.branchId,
        studentId: r.studentId,
        date: r.date,
        channel: r.channel,
        to: r.to,
        guardianName: r.guardianName,
        status: r.status,
        error: r.error,
        trigger: r.trigger,
        actorId: r.actorId,
        createdAt: r.createdAt.toISOString(),
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
    const outcome = await notifyAbsentees({
      tenantId: request.auth!.tenantId!,
      branchId: parsed.data.branchId,
      date,
      trigger: 'manual',
      actorId: request.auth!.sub,
      studentId: parsed.data.studentId,
    })
    return reply.send(outcome)
  })
}
