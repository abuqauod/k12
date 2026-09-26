import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { IncidentDoc, StudentDoc, TenantContext } from '../db.js'
import { callerBranchIds, callerHasPermission } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { Abort, isFailure, scoped, sendFailure, transact } from '../records.js'
import { nextNumber } from '../numbering.js'
import { checkCode } from '../ops/common.js'
import { notifyFamilies, nudgeQueue, schoolName } from '../notifications/messages.js'
import { ensureDefaults } from '../settings/lookups.js'

/**
 * Backlog: behaviour incidents.
 *
 *  - `discipline.report` (every teacher, reception, the nurse) logs an
 *    incident about one or more students of a branch they work in, and
 *    sees the incidents they logged.
 *  - `discipline.manage` (admins, registrar) sees every incident in their
 *    branches, records what the school did about each student (a
 *    `disciplineAction` code: warning, detention, suspension…), tells the
 *    families (the `incident` template) and closes it.
 * Types and actions are settings lists; an incident is never deleted, it
 * is dismissed.
 */

const SEVERITIES = ['minor', 'moderate', 'major'] as const

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => v || null)

const createBody = z.object({
  studentIds: z.array(z.string()).min(1).max(20),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  location: text(120),
  typeCode: z.string(),
  severity: z.enum(SEVERITIES),
  description: z.string().trim().min(3).max(3000),
  witnesses: text(500),
})

const actionBody = z
  .object({
    studentId: z.string(),
    code: z.string(),
    note: text(1000),
    startDate: z.string().date().nullable().default(null),
    endDate: z.string().date().nullable().default(null),
  })
  .refine((b) => !b.startDate || !b.endDate || b.startDate <= b.endDate, { message: 'dates' })

const closeBody = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']),
  resolution: text(2000),
})

const notifyBody = z.object({ studentIds: z.array(z.string()).max(20).optional() })

const listQuery = z.object({
  branchId: z.string().optional(),
  studentId: z.string().optional(),
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

const studentName = (s: Pick<StudentDoc, 'givenName' | 'familyName'>) => `${s.givenName} ${s.familyName}`.trim()

async function studentsById(ctx: TenantContext, ids: string[]) {
  return new Map((await ctx.students.find({ _id: { $in: [...new Set(ids)] } }).toArray()).map((s) => [s._id, s]))
}

function incidentResponse(i: IncidentDoc, students: Map<string, StudentDoc>) {
  return {
    id: i._id,
    incidentNumber: i.incidentNumber,
    branchId: i.branchId,
    students: i.studentIds.map((id) => {
      const s = students.get(id)
      return { id, name: s ? studentName(s) : '', studentNumber: s?.studentNumber ?? '', studentGroup: s?.studentGroup ?? '' }
    }),
    occurredAt: i.occurredAt,
    location: i.location,
    typeCode: i.typeCode,
    severity: i.severity,
    description: i.description,
    witnesses: i.witnesses,
    status: i.status,
    actions: i.actions,
    parentsNotifiedAt: i.parentsNotifiedAt,
    resolution: i.resolution,
    reportedBy: i.reportedBy,
    createdAt: i.createdAt,
  }
}

/** Who may see this incident: a manager in its branch, or whoever logged it. */
async function canSee(request: FastifyRequest, i: IncidentDoc): Promise<boolean> {
  const branches = await callerBranchIds(request)
  if (branches !== null && !branches.includes(i.branchId)) return false
  return i.reportedBy === request.auth!.sub || (await callerHasPermission(request, 'discipline.manage'))
}

async function actionLabels(ctx: TenantContext, lang: 'en' | 'ar') {
  const rows = await ctx.lookups.find({ kind: { $in: ['disciplineAction', 'incidentType'] } }).toArray()
  const map = new Map(rows.map((r) => [`${r.kind}:${r.code}`, (lang === 'ar' && r.labelAr) || r.label]))
  return (kind: string, code: string) => map.get(`${kind}:${code}`) ?? code
}

export function registerDisciplineRoutes(app: FastifyInstance): void {
  app.post('/discipline/incidents', scoped('discipline.report'), async (request, reply) => {
    const parsed = createBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const b = parsed.data
    const tenantId = request.auth!.tenantId!
    if (!(await checkCode(tenantId, 'incidentType', b.typeCode))) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    const occurredAt = b.occurredAt ? new Date(b.occurredAt) : new Date()
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) return reply.code(400).send({ error: 'IN_THE_FUTURE' })
    const allowed = await callerBranchIds(request)
    const result = await transact(tenantId, async (ctx) => {
      const ids = [...new Set(b.studentIds)]
      const students = await ctx.students.find({ _id: { $in: ids } }).toArray()
      if (students.length !== ids.length) throw new Abort('UNKNOWN_STUDENT')
      const branchId = students[0]!.branchId
      if (students.some((s) => s.branchId !== branchId)) throw new Abort('STUDENTS_IN_DIFFERENT_BRANCHES')
      if (allowed !== null && !allowed.includes(branchId)) throw new Abort('BRANCH_FORBIDDEN')
      const now = new Date()
      const doc: IncidentDoc = {
        _id: randomUUID(),
        tenantId,
        incidentNumber: await nextNumber(ctx, tenantId, 'incidentNumber'),
        branchId,
        studentIds: ids,
        occurredAt,
        location: b.location,
        typeCode: b.typeCode,
        severity: b.severity,
        description: b.description,
        witnesses: b.witnesses,
        status: 'open',
        actions: [],
        parentsNotifiedAt: null,
        resolution: null,
        reportedBy: request.auth!.sub,
        createdAt: now,
        updatedAt: now,
      }
      const { tenantId: _t, ...row } = doc
      await ctx.incidents.insertOne(row)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'incident.report',
        entity: 'incident',
        entityId: doc._id,
        branchId,
        after: { incidentNumber: doc.incidentNumber, students: ids.length, typeCode: b.typeCode, severity: b.severity },
      })
      return incidentResponse(doc, new Map(students.map((s) => [s._id, s])))
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.code(201).send(result)
  })

  app.get('/discipline/incidents', scoped('discipline.report'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const q = parsed.data
    const allowed = await callerBranchIds(request)
    if (q.branchId && allowed !== null && !allowed.includes(q.branchId)) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const manager = await callerHasPermission(request, 'discipline.manage')
    const filter: Filter<IncidentDoc> = {
      ...(q.branchId ? { branchId: q.branchId } : allowed !== null ? { branchId: { $in: allowed } } : {}),
      ...(q.studentId ? { studentIds: q.studentId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(manager ? {} : { reportedBy: request.auth!.sub }),
    }
    if (q.from || q.to) {
      filter.occurredAt = {
        ...(q.from ? { $gte: new Date(`${q.from}T00:00:00Z`) } : {}),
        ...(q.to ? { $lte: new Date(`${q.to}T23:59:59.999Z`) } : {}),
      }
    }
    const data = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const rows = await ctx.incidents.find(filter).sort({ occurredAt: -1 }).limit(q.limit).toArray()
      return { rows, students: await studentsById(ctx, rows.flatMap((r) => r.studentIds)) }
    })
    return reply.send({ incidents: data.rows.map((r) => incidentResponse(r, data.students)), canManage: manager })
  })

  app.get('/discipline/incidents/:id', scoped('discipline.report'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const data = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const incident = await ctx.incidents.findOne({ _id: id })
      return incident ? { incident, students: await studentsById(ctx, incident.studentIds) } : null
    })
    if (!data || !(await canSee(request, data.incident))) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(incidentResponse(data.incident, data.students))
  })

  /** Loads an incident a manager may act on, inside a transaction. */
  const managed = async (request: FastifyRequest, ctx: TenantContext, id: string) => {
    const incident = await ctx.incidents.findOne({ _id: id })
    if (!incident) throw new Abort('NOT_FOUND')
    const allowed = await callerBranchIds(request)
    if (allowed !== null && !allowed.includes(incident.branchId)) throw new Abort('NOT_FOUND')
    return incident
  }

  app.post('/discipline/incidents/:id/actions', scoped('discipline.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = actionBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const b = parsed.data
    const tenantId = request.auth!.tenantId!
    if (!(await checkCode(tenantId, 'disciplineAction', b.code))) return reply.code(400).send({ error: 'INVALID_CATEGORY' })
    const result = await transact(tenantId, async (ctx) => {
      const incident = await managed(request, ctx, id)
      if (!incident.studentIds.includes(b.studentId)) throw new Abort('UNKNOWN_STUDENT')
      if (incident.status !== 'open') throw new Abort('NOT_OPEN')
      const action = { id: randomUUID(), ...b, decidedBy: request.auth!.sub, decidedAt: new Date() }
      const after = await ctx.incidents.findOneAndUpdate(
        { _id: id },
        { $set: { actions: [...incident.actions, action], updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'incident.action',
        entity: 'incident',
        entityId: id,
        branchId: incident.branchId,
        meta: { studentId: b.studentId, code: b.code },
      })
      return incidentResponse(after!, await studentsById(ctx, after!.studentIds))
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(result)
  })

  app.post('/discipline/incidents/:id/status', scoped('discipline.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = closeBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const result = await transact(request.auth!.tenantId!, async (ctx) => {
      const incident = await managed(request, ctx, id)
      if (parsed.data.status !== 'open' && !parsed.data.resolution) throw new Abort('REASON_REQUIRED')
      const after = await ctx.incidents.findOneAndUpdate(
        { _id: id },
        { $set: { status: parsed.data.status, resolution: parsed.data.resolution, updatedAt: new Date() } },
        { returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: `incident.${parsed.data.status === 'open' ? 'reopen' : parsed.data.status}`,
        entity: 'incident',
        entityId: id,
        branchId: incident.branchId,
        before: { status: incident.status },
        after: { status: parsed.data.status },
      })
      return incidentResponse(after!, await studentsById(ctx, after!.studentIds))
    })
    if (isFailure(result)) return sendFailure(reply, result)
    return reply.send(result)
  })

  /** Tells the families of the students asked for (default: all of them)
   * what happened and what the school decided. A family can be told again
   * once a new action is recorded. */
  app.post('/discipline/incidents/:id/notify', scoped('discipline.manage'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = notifyBody.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    await ensureDefaults(tenantId, 'disciplineAction')
    await ensureDefaults(tenantId, 'incidentType')
    const school = await schoolName(tenantId)
    const result = await transact(tenantId, async (ctx) => {
      const incident = await managed(request, ctx, id)
      const ids = parsed.data.studentIds?.length ? parsed.data.studentIds : incident.studentIds
      if (ids.some((s) => !incident.studentIds.includes(s))) throw new Abort('UNKNOWN_STUDENT')
      const label = { en: await actionLabels(ctx, 'en'), ar: await actionLabels(ctx, 'ar') }
      const delivered = await notifyFamilies(ctx, tenantId, {
        kind: 'incident',
        sourceId: incident._id,
        dedupe: String(incident.actions.length),
        studentIds: ids,
        recipients: 'all',
        tokens: (student, parent) => {
          const lang = parent.preferredLanguage === 'ar' ? 'ar' : 'en'
          const actions = incident.actions.filter((a) => a.studentId === student._id)
          return {
            parentName: parent.fullName,
            studentName: studentName(student),
            date: incident.occurredAt.toISOString().slice(0, 10),
            type: label[lang]('incidentType', incident.typeCode),
            description: incident.description,
            action: actions.length
              ? actions
                  .map((a) => `${label[lang]('disciplineAction', a.code)}${a.startDate ? ` (${a.startDate}${a.endDate ? ` – ${a.endDate}` : ''})` : ''}`)
                  .join(', ')
              : lang === 'ar'
                ? 'لم يُتخذ إجراء بعد'
                : 'none yet',
            schoolName: school,
          }
        },
        trigger: 'manual',
        actorId: request.auth!.sub,
      })
      const reached = delivered.inApp + delivered.email + delivered.sms > 0
      if (reached) await ctx.incidents.findOneAndUpdate({ _id: id }, { $set: { parentsNotifiedAt: new Date(), updatedAt: new Date() } })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'incident.notify',
        entity: 'incident',
        entityId: id,
        branchId: incident.branchId,
        meta: { students: ids.length, ...delivered },
      })
      return delivered
    })
    if (isFailure(result)) return sendFailure(reply, result)
    nudgeQueue()
    return reply.send(result)
  })
}
