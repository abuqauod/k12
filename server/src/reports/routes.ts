import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { withoutTenant, withTenant } from '../db.js'
import type { ReportFilters, ReportScheduleDoc } from '../db.js'
import { PARENT_ROLE_KEY } from '../auth/scopes.js'
import { callerHasPermission } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { gridFsStore } from '../documents/store.js'
import { scoped, todayIso } from '../records.js'
import { canRun, catalogFor, findReport, isRunFailure, runReport, type RunResult } from './catalog.js'
import { addDays, coversBranches, reportBranches, viewerForMember, viewerFromRequest, type Lang } from './common.js'
import { describeRun, exportDoc } from './describe.js'
import { exportFileName, MIME, toCsv, toPrintHtml, toXlsx } from './export.js'
import { canDownload, nextOccurrence, runSchedule } from './schedules.js'

/**
 * SAMS 7.2–7.4 routes:
 *  - `/reports/catalog`: the reports the caller may run;
 *  - `/reports/:key`: one report as a table, `/reports/:key/export` as a
 *    CSV, Excel or print file;
 *  - `/reports/schedules`: scheduled exports (`reports.schedule`), and
 *    `/reports/runs`: the files they made for the caller.
 * Every read runs through the catalog, so the scopes and branches checked
 * are the same for the table, the file and the schedule.
 */

const opt = z
  .string()
  .trim()
  .max(120)
  .optional()
  .transform((v) => v || null)

const runQuery = z.object({
  branchId: opt,
  academicYearId: opt,
  gradeLevel: opt,
  classId: opt,
  status: opt,
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  lang: z.enum(['en', 'ar']).default('en'),
})
const exportQuery = runQuery.extend({
  format: z.enum(['csv', 'xlsx', 'html']),
  autoprint: z.enum(['0', '1']).optional(),
})

const filterOf = (q: z.infer<typeof runQuery>): ReportFilters => ({
  branchId: q.branchId,
  academicYearId: q.academicYearId,
  gradeLevel: q.gradeLevel,
  classId: q.classId,
  status: q.status,
})

const ERROR_STATUS: Record<string, number> = {
  UNKNOWN_REPORT: 404,
  FORBIDDEN: 403,
  BRANCH_FORBIDDEN: 403,
  NOT_FOUND: 404,
}
const fail = (reply: FastifyReply, error: string, extra: Record<string, unknown> = {}) =>
  reply.code(ERROR_STATUS[error] ?? 400).send({ error, ...extra })

function contentDisposition(fileName: string, download: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_')
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

const tableFor = (run: RunResult, lang: Lang) => ({
  key: run.definition.key,
  title: run.title,
  from: run.from,
  to: run.to,
  columns: run.table.columns.map((c) => ({ key: c.key, label: c.label[lang], type: c.type })),
  rows: run.table.rows,
  totals: run.table.totals,
  truncated: run.truncated,
})

// ------------------------------------------------------------ schedules --

const filtersBody = z
  .object({
    branchId: z.string().nullable().default(null),
    academicYearId: z.string().nullable().default(null),
    gradeLevel: z.string().trim().max(120).nullable().default(null),
    classId: z.string().nullable().default(null),
    status: z.string().max(60).nullable().default(null),
  })
  .default({})

const scheduleBody = z
  .object({
    name: z.string().trim().max(120).default(''),
    reportKey: z.string(),
    filters: filtersBody,
    range: z.enum(['yesterday', 'last_7_days', 'last_30_days', 'month_to_date', 'previous_month', 'year_to_date', 'academic_year']),
    format: z.enum(['csv', 'xlsx']),
    language: z.enum(['en', 'ar']),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    weekday: z.number().int().min(0).max(6).nullable().default(null),
    monthDay: z.number().int().min(1).max(28).nullable().default(null),
    recipients: z.array(z.string()).max(50).default([]),
    active: z.boolean().default(true),
  })
  .refine((b) => b.frequency !== 'weekly' || b.weekday !== null, { message: 'weekday' })
  .refine((b) => b.frequency !== 'monthly' || b.monthDay !== null, { message: 'monthDay' })

type ScheduleInput = z.infer<typeof scheduleBody>

/** Members who could receive `key` over `branchIds`: staff (never a parent
 * login) holding its scopes, with branches covering it. */
async function eligibleMembers(tenantId: string, key: string, branchIds: string[] | null) {
  const def = findReport(key)
  if (!def) return []
  const members = await withoutTenant((db) => db.memberships.find({ tenantId, roleKey: { $ne: PARENT_ROLE_KEY } }).toArray())
  const users = new Map(
    (await withoutTenant((db) => db.users.find({ _id: { $in: members.map((m) => m.userId) } }).toArray())).map((u) => [u._id, u]),
  )
  const out: { userId: string; name: string; email: string }[] = []
  for (const m of members) {
    const v = await viewerForMember(tenantId, m.userId)
    const u = users.get(m.userId)
    if (!v || !u || !u.active) continue
    if (canRun(v, def) && coversBranches(v.branchIds, branchIds)) out.push({ userId: u._id, name: u.displayName, email: u.email })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Checks a schedule the caller wants to save; the error code on failure. */
async function checkSchedule(request: FastifyRequest, body: ScheduleInput): Promise<string | null> {
  const viewer = await viewerFromRequest(request)
  const def = findReport(body.reportKey)
  if (!def) return 'UNKNOWN_REPORT'
  if (!canRun(viewer, def)) return 'FORBIDDEN'
  const branchIds = reportBranches(viewer, def.filters.includes('branch') ? body.filters.branchId : null)
  if (branchIds === false) return 'BRANCH_FORBIDDEN'
  if (body.filters.status && !(def.statuses ?? []).some((s) => s.value === body.filters.status)) return 'INVALID_STATUS'
  const allowed = new Set((await eligibleMembers(viewer.tenantId, body.reportKey, branchIds)).map((m) => m.userId))
  if (body.recipients.some((r) => !allowed.has(r))) return 'RECIPIENT_NO_ACCESS'
  return null
}

function scheduleResponse(s: ReportScheduleDoc) {
  const def = findReport(s.reportKey)
  return {
    id: s._id,
    name: s.name,
    reportKey: s.reportKey,
    reportTitle: def ? { en: def.title.en, ar: def.title.ar } : null,
    filters: s.filters,
    range: s.range,
    format: s.format,
    language: s.language,
    frequency: s.frequency,
    weekday: s.weekday,
    monthDay: s.monthDay,
    recipients: s.recipients,
    ownerId: s.ownerId,
    active: s.active,
    nextRunDate: s.nextRunDate,
    lastRunAt: s.lastRunAt,
    lastRunId: s.lastRunId,
    lastError: s.lastError,
    createdAt: s.createdAt,
  }
}

/** A schedule the caller may manage: their own, or any with
 * `memberships.manage` (a school admin looking after the team's). */
async function manageable(request: FastifyRequest, id: string): Promise<ReportScheduleDoc | null> {
  const s = await withTenant(request.auth!.tenantId!, (ctx) => ctx.reportSchedules.findOne({ _id: id }))
  if (!s) return null
  if (s.ownerId === request.auth!.sub || (await callerHasPermission(request, 'memberships.manage'))) return s
  return null
}

export function registerReportRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------ catalog --

  app.get('/reports/catalog', scoped('dashboard.read'), async (request, reply) => {
    const lang = z.enum(['en', 'ar']).catch('en').parse((request.query as { lang?: string }).lang)
    const viewer = await viewerFromRequest(request)
    return reply.send({ reports: catalogFor(viewer, lang), canSchedule: viewer.scopes.has('reports.schedule') })
  })

  // ---------------------------------------------------------- schedules --

  app.get('/reports/schedules', scoped('reports.schedule'), async (request, reply) => {
    const all = await callerHasPermission(request, 'memberships.manage')
    const rows = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.reportSchedules
        .find(all ? {} : { ownerId: request.auth!.sub })
        .sort({ createdAt: -1 })
        .toArray(),
    )
    const owners = await withoutTenant((db) => db.users.find({ _id: { $in: [...new Set(rows.map((r) => r.ownerId))] } }).toArray())
    const ownerName = new Map(owners.map((u) => [u._id, u.displayName]))
    return reply.send({ schedules: rows.map((s) => ({ ...scheduleResponse(s), ownerName: ownerName.get(s.ownerId) ?? '' })) })
  })

  app.get('/reports/recipients', scoped('reports.schedule'), async (request, reply) => {
    const q = z.object({ key: z.string(), branchId: opt }).safeParse(request.query)
    if (!q.success) return fail(reply, 'INVALID_QUERY')
    const viewer = await viewerFromRequest(request)
    const def = findReport(q.data.key)
    if (!def) return fail(reply, 'UNKNOWN_REPORT')
    const branchIds = reportBranches(viewer, def.filters.includes('branch') ? q.data.branchId : null)
    if (branchIds === false) return fail(reply, 'BRANCH_FORBIDDEN')
    return reply.send({ members: await eligibleMembers(viewer.tenantId, q.data.key, branchIds) })
  })

  app.post('/reports/schedules', scoped('reports.schedule'), async (request, reply) => {
    const parsed = scheduleBody.safeParse(request.body)
    if (!parsed.success) return fail(reply, 'INVALID_BODY', { issues: parsed.error.issues.map((i) => i.message) })
    const body = parsed.data
    const problem = await checkSchedule(request, body)
    if (problem) return fail(reply, problem)
    const now = new Date()
    const doc: ReportScheduleDoc = {
      _id: randomUUID(),
      tenantId: request.auth!.tenantId!,
      ...body,
      weekday: body.frequency === 'weekly' ? body.weekday : null,
      monthDay: body.frequency === 'monthly' ? body.monthDay : null,
      recipients: [...new Set(body.recipients.filter((r) => r !== request.auth!.sub))],
      ownerId: request.auth!.sub,
      nextRunDate: '',
      lastRunAt: null,
      lastRunId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    // From tomorrow: saving one never fires it at once ("run now" does).
    doc.nextRunDate = nextOccurrence(doc, addDays(todayIso(), 1))
    await withTenant(doc.tenantId, async (ctx) => {
      const { tenantId: _t, ...row } = doc
      void _t
      await ctx.reportSchedules.insertOne(row)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'reportSchedule.create',
        entity: 'reportSchedule',
        entityId: doc._id,
        after: { reportKey: doc.reportKey, frequency: doc.frequency, recipients: doc.recipients.length },
      })
    })
    return reply.code(201).send(scheduleResponse(doc))
  })

  app.patch('/reports/schedules/:id', scoped('reports.schedule'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await manageable(request, id)
    if (!existing) return fail(reply, 'NOT_FOUND')
    const parsed = scheduleBody.safeParse({ ...scheduleResponse(existing), ...(request.body as object) })
    if (!parsed.success) return fail(reply, 'INVALID_BODY', { issues: parsed.error.issues.map((i) => i.message) })
    const body = parsed.data
    // Checked as the caller; the run itself stays the owner's.
    const problem = await checkSchedule(request, body)
    if (problem) return fail(reply, problem)
    const set = {
      ...body,
      weekday: body.frequency === 'weekly' ? body.weekday : null,
      monthDay: body.frequency === 'monthly' ? body.monthDay : null,
      recipients: [...new Set(body.recipients.filter((r) => r !== existing.ownerId))],
      updatedAt: new Date(),
    }
    const timing = set.frequency !== existing.frequency || set.weekday !== existing.weekday || set.monthDay !== existing.monthDay
    const reactivated = set.active && !existing.active
    const nextRunDate = timing || reactivated ? nextOccurrence(set, addDays(todayIso(), 1)) : existing.nextRunDate
    const updated = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const after = await ctx.reportSchedules.findOneAndUpdate(
        { _id: id },
        { $set: { ...set, nextRunDate, ...(reactivated ? { lastError: null } : {}) } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'reportSchedule.update',
        entity: 'reportSchedule',
        entityId: id,
        after: { reportKey: set.reportKey, frequency: set.frequency, active: set.active, recipients: set.recipients.length },
      })
      return after
    })
    return reply.send(scheduleResponse(updated!))
  })

  app.delete('/reports/schedules/:id', scoped('reports.schedule'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await manageable(request, id)
    if (!existing) return fail(reply, 'NOT_FOUND')
    const tenantId = request.auth!.tenantId!
    const runs = await withTenant(tenantId, async (ctx) => {
      const runs = await ctx.reportRuns.find({ scheduleId: id }).toArray()
      await ctx.reportRuns.deleteMany({ scheduleId: id })
      await ctx.reportSchedules.deleteOne({ _id: id })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'reportSchedule.delete',
        entity: 'reportSchedule',
        entityId: id,
        before: { reportKey: existing.reportKey, name: existing.name },
      })
      return runs
    })
    for (const r of runs) await gridFsStore.remove(tenantId, r.fileId).catch(() => undefined)
    return reply.send({ ok: true })
  })

  app.post('/reports/schedules/:id/run', scoped('reports.schedule'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await manageable(request, id)
    if (!existing) return fail(reply, 'NOT_FOUND')
    const out = await runSchedule(existing, todayIso(), 'manual', request.auth!.sub)
    if (!out.ok) return reply.code(409).send({ error: out.error })
    return reply.send({ runId: out.run._id, rows: out.run.rows, notified: out.notified, skippedRecipients: out.skippedRecipients })
  })

  // --------------------------------------------------------------- runs --

  app.get('/reports/runs', scoped('dashboard.read'), async (request, reply) => {
    const me = request.auth!.sub
    const runs = await withTenant(request.auth!.tenantId!, (ctx) =>
      ctx.reportRuns
        .find({ $or: [{ recipients: me }, { ownerId: me }] })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray(),
    )
    return reply.send({
      runs: runs.map((r) => ({
        id: r._id,
        scheduleId: r.scheduleId,
        reportKey: r.reportKey,
        title: r.title,
        from: r.from,
        to: r.to,
        format: r.format,
        fileName: r.fileName,
        size: r.size,
        rows: r.rows,
        createdAt: r.createdAt,
      })),
    })
  })

  app.get('/reports/runs/:id/file', scoped('dashboard.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const run = await withTenant(tenantId, (ctx) => ctx.reportRuns.findOne({ _id: id }))
    if (!run || !(await canDownload(run, request.auth!.sub))) return fail(reply, 'NOT_FOUND')
    const file = await gridFsStore.open(tenantId, run.fileId)
    if (!file) return fail(reply, 'NOT_FOUND')
    await withTenant(tenantId, (ctx) =>
      recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'report.download',
        entity: 'reportRun',
        entityId: run._id,
        meta: { reportKey: run.reportKey, rows: run.rows },
      }),
    )
    return reply
      .header('Content-Type', MIME[run.format])
      .header('Content-Length', String(file.size))
      .header('Content-Disposition', contentDisposition(run.fileName, true))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(file.stream)
  })

  // ------------------------------------------------------ run / export --

  app.get('/reports/:key', scoped('dashboard.read'), async (request, reply) => {
    const q = runQuery.safeParse(request.query)
    if (!q.success) return fail(reply, 'INVALID_QUERY')
    const { key } = request.params as { key: string }
    const today = todayIso()
    const viewer = await viewerFromRequest(request)
    const run = await runReport(viewer, { key, filters: filterOf(q.data), from: q.data.from ?? null, to: q.data.to ?? null, lang: q.data.lang, today })
    if (isRunFailure(run)) return fail(reply, run.error)
    return reply.send({ ...tableFor(run, q.data.lang), meta: await describeRun(viewer.tenantId, run, q.data.lang, today) })
  })

  app.get('/reports/:key/export', scoped('dashboard.read'), async (request, reply) => {
    const q = exportQuery.safeParse(request.query)
    if (!q.success) return fail(reply, 'INVALID_QUERY')
    const { key } = request.params as { key: string }
    const today = todayIso()
    const viewer = await viewerFromRequest(request)
    const run = await runReport(viewer, { key, filters: filterOf(q.data), from: q.data.from ?? null, to: q.data.to ?? null, lang: q.data.lang, today })
    if (isRunFailure(run)) return fail(reply, run.error)
    const doc = await exportDoc(viewer.tenantId, run, q.data.lang, today)
    const format = q.data.format
    // A file leaving the system is worth a line in the audit log; a print
    // preview too, since it is one "Save as PDF" away from a file.
    await withTenant(viewer.tenantId, (ctx) =>
      recordAudit(ctx.auditLog, {
        actorId: viewer.userId,
        action: 'report.export',
        entity: 'report',
        entityId: key,
        branchId: run.branchIds?.length === 1 ? run.branchIds[0] : null,
        meta: { format, rows: run.table.rows.length, filters: run.applied, from: run.from, to: run.to },
      }),
    )
    const body = format === 'csv' ? toCsv(doc) : format === 'xlsx' ? toXlsx(doc) : toPrintHtml(doc, q.data.autoprint === '1')
    const fileName = exportFileName(key, run.from, run.to ?? today, format === 'html' ? 'html' : format)
    return reply
      .header('Content-Type', MIME[format])
      .header('Content-Disposition', contentDisposition(fileName, format !== 'html'))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(body)
  })
}
