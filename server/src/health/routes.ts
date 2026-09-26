import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Filter } from 'mongodb'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { ClinicOutcome, ClinicVisitDoc, StudentDoc, StudentHealthDoc, TenantContext } from '../db.js'
import { callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { branchFilter, scoped } from '../records.js'
import { notifyFamilies, nudgeQueue, schoolName } from '../notifications/messages.js'

/**
 * Backlog: health and clinic. A student's health profile (allergies,
 * conditions, medication, doctor) and the clinic's visit log.
 *
 *  - Medical detail needs `health.read`; `health.write` edits the profile
 *    and records visits. Items marked as an alert (a severe allergy) are
 *    shown to anyone who can see the student, through `/students/:id/alerts`.
 *  - A visit that ends with the child sent home, referred or taken to
 *    emergency tells the family (the `clinic_visit` template); any other
 *    visit only when the nurse asks.
 *  - The audit log says a profile changed, never what it now says.
 */

const OUTCOMES = ['returned_to_class', 'rested', 'sent_home', 'referred', 'emergency'] as const
/** Outcomes the family always hears about. */
const TELL_FAMILY: ClinicOutcome[] = ['sent_home', 'referred', 'emergency']

const OUTCOME_WORDS: Record<ClinicOutcome, { en: string; ar: string }> = {
  returned_to_class: { en: 'returned to class', ar: 'عاد إلى الصف' },
  rested: { en: 'rested in the clinic', ar: 'استراح في العيادة' },
  sent_home: { en: 'sent home', ar: 'أُرسل إلى المنزل' },
  referred: { en: 'referred to a doctor', ar: 'أُحيل إلى طبيب' },
  emergency: { en: 'taken to emergency care', ar: 'نُقل إلى الطوارئ' },
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => v || null)

const item = z.object({
  id: z.string().max(60).optional(),
  name: z.string().trim().min(1).max(120),
  notes: text(500),
  alert: z.boolean().default(false),
})

const profileBody = z.object({
  bloodType: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).nullable().default(null),
  allergies: z
    .array(item.extend({ severity: z.enum(['mild', 'moderate', 'severe']), reaction: text(300) }))
    .max(30)
    .default([]),
  conditions: z.array(item).max(30).default([]),
  medications: z
    .array(
      z.object({
        id: z.string().max(60).optional(),
        name: z.string().trim().min(1).max(120),
        dose: text(120),
        schedule: text(120),
        atSchool: z.boolean().default(false),
      }),
    )
    .max(30)
    .default([]),
  doctorName: text(120),
  doctorPhone: text(40),
  notes: text(2000),
})

const visitBody = z.object({
  studentId: z.string(),
  /** Defaults to now. */
  visitedAt: z.string().datetime({ offset: true }).optional(),
  complaint: z.string().trim().min(1).max(300),
  temperature: z.number().min(30).max(45).nullable().default(null),
  treatment: text(500),
  medicationGiven: text(300),
  outcome: z.enum(OUTCOMES),
  notes: text(1000),
  /** Tell the family even when the outcome doesn't require it. */
  notifyParents: z.boolean().default(false),
})

const visitQuery = z.object({
  branchId: z.string().optional(),
  studentId: z.string().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})

const studentName = (s: Pick<StudentDoc, 'givenName' | 'familyName'>) => `${s.givenName} ${s.familyName}`.trim()

function profileResponse(p: StudentHealthDoc | null) {
  if (!p) return null
  const { _id, tenantId: _t, ...rest } = p
  return { studentId: _id, ...rest }
}

function visitResponse(v: ClinicVisitDoc, names: Map<string, StudentDoc>) {
  const s = names.get(v.studentId)
  return {
    id: v._id,
    studentId: v.studentId,
    studentName: s ? studentName(s) : '',
    studentNumber: s?.studentNumber ?? '',
    branchId: v.branchId,
    visitedAt: v.visitedAt,
    complaint: v.complaint,
    temperature: v.temperature,
    treatment: v.treatment,
    medicationGiven: v.medicationGiven,
    outcome: v.outcome,
    notes: v.notes,
    parentsNotifiedAt: v.parentsNotifiedAt,
    recordedBy: v.recordedBy,
  }
}

/** The student, if the caller may use their branch. */
async function studentAccess(request: FastifyRequest, id: string) {
  const student = await withTenant(request.auth!.tenantId!, (ctx) => ctx.students.findOne({ _id: id }))
  if (!student) return { ok: false as const, status: 404, error: 'NOT_FOUND' }
  if (!(await callerCanUseBranch(request, student.branchId))) return { ok: false as const, status: 403, error: 'BRANCH_FORBIDDEN' }
  return { ok: true as const, student }
}

/** What staff should know at a glance: the items marked as alerts. */
export function healthAlerts(p: StudentHealthDoc | null) {
  if (!p) return []
  return [
    ...p.allergies.filter((a) => a.alert).map((a) => ({ kind: 'allergy' as const, name: a.name, severity: a.severity, notes: a.notes })),
    ...p.conditions.filter((c) => c.alert).map((c) => ({ kind: 'condition' as const, name: c.name, severity: null, notes: c.notes })),
  ]
}

async function studentsById(ctx: TenantContext, ids: string[]) {
  return new Map((await ctx.students.find({ _id: { $in: [...new Set(ids)] } }).toArray()).map((s) => [s._id, s]))
}

export function registerHealthRoutes(app: FastifyInstance): void {
  /** Alerts only — for anyone who can see the student. */
  app.get('/students/:id/alerts', scoped('students.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const access = await studentAccess(request, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const profile = await withTenant(request.auth!.tenantId!, (ctx) => ctx.studentHealth.findOne({ _id: id }))
    return reply.send({ alerts: healthAlerts(profile) })
  })

  app.get('/students/:id/health', scoped('health.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const access = await studentAccess(request, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const data = await withTenant(request.auth!.tenantId!, async (ctx) => ({
      profile: await ctx.studentHealth.findOne({ _id: id }),
      visits: await ctx.clinicVisits.find({ studentId: id }).sort({ visitedAt: -1 }).limit(50).toArray(),
    }))
    const names = new Map([[id, access.student]])
    return reply.send({ profile: profileResponse(data.profile), visits: data.visits.map((v) => visitResponse(v, names)) })
  })

  app.put('/students/:id/health', scoped('health.write'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const access = await studentAccess(request, id)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const parsed = profileBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const b = parsed.data
    const withIds = <T extends { id?: string }>(rows: T[]) => rows.map((r) => ({ ...r, id: r.id || randomUUID() }))
    const tenantId = request.auth!.tenantId!
    const saved = await withTenant(tenantId, async (ctx) => {
      const before = await ctx.studentHealth.findOne({ _id: id })
      const set = {
        ...b,
        allergies: withIds(b.allergies),
        conditions: withIds(b.conditions),
        medications: withIds(b.medications),
        updatedAt: new Date(),
        updatedBy: request.auth!.sub,
      }
      const after = await ctx.studentHealth.findOneAndUpdate({ _id: id }, { $set: set }, { upsert: true, returnDocument: 'after' })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: before ? 'health.update' : 'health.create',
        entity: 'student',
        entityId: id,
        branchId: access.student.branchId,
        // Counts only: the medical detail stays out of the audit log.
        meta: { allergies: set.allergies.length, conditions: set.conditions.length, medications: set.medications.length },
      })
      return after
    })
    return reply.send({ profile: profileResponse(saved) })
  })

  // ------------------------------------------------------------ clinic --

  app.get('/clinic/visits', scoped('health.read'), async (request, reply) => {
    const parsed = visitQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const q = parsed.data
    const branches = await branchFilter(request, q.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const filter: Filter<ClinicVisitDoc> = {
      ...(branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}),
      ...(q.studentId ? { studentId: q.studentId } : {}),
    }
    if (q.from || q.to) {
      filter.visitedAt = {
        ...(q.from ? { $gte: new Date(`${q.from}T00:00:00Z`) } : {}),
        ...(q.to ? { $lte: new Date(`${q.to}T23:59:59.999Z`) } : {}),
      }
    }
    const data = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const visits = await ctx.clinicVisits.find(filter).sort({ visitedAt: -1 }).limit(q.limit).toArray()
      return { visits, names: await studentsById(ctx, visits.map((v) => v.studentId)) }
    })
    return reply.send({ visits: data.visits.map((v) => visitResponse(v, data.names)) })
  })

  app.post('/clinic/visits', scoped('health.write'), async (request, reply) => {
    const parsed = visitBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const b = parsed.data
    const access = await studentAccess(request, b.studentId)
    if (!access.ok) return reply.code(access.status).send({ error: access.error })
    const visitedAt = b.visitedAt ? new Date(b.visitedAt) : new Date()
    if (visitedAt.getTime() > Date.now() + 5 * 60_000) return reply.code(400).send({ error: 'IN_THE_FUTURE' })
    const tenantId = request.auth!.tenantId!
    const school = await schoolName(tenantId)
    const tell = TELL_FAMILY.includes(b.outcome) || b.notifyParents
    const result = await withTenant(tenantId, async (ctx) => {
      const visit: ClinicVisitDoc = {
        _id: randomUUID(),
        tenantId,
        studentId: b.studentId,
        branchId: access.student.branchId,
        visitedAt,
        complaint: b.complaint,
        temperature: b.temperature,
        treatment: b.treatment,
        medicationGiven: b.medicationGiven,
        outcome: b.outcome,
        notes: b.notes,
        parentsNotifiedAt: null,
        recordedBy: request.auth!.sub,
        createdAt: new Date(),
      }
      let delivered = null
      if (tell) {
        delivered = await notifyFamilies(ctx, tenantId, {
          kind: 'clinic_visit',
          sourceId: visit._id,
          studentIds: [b.studentId],
          recipients: 'all',
          tokens: (student, parent) => {
            const ar = parent.preferredLanguage === 'ar'
            return {
              parentName: parent.fullName,
              studentName: studentName(student),
              time: visitedAt.toISOString().slice(11, 16),
              complaint: b.complaint,
              outcome: OUTCOME_WORDS[b.outcome][ar ? 'ar' : 'en'],
              treatment: b.treatment ?? '—',
              schoolName: school,
            }
          },
          trigger: 'manual',
          actorId: request.auth!.sub,
        })
        if (delivered.families > 0 || delivered.inApp > 0 || delivered.email > 0 || delivered.sms > 0) visit.parentsNotifiedAt = new Date()
      }
      const { tenantId: _t, ...row } = visit
      await ctx.clinicVisits.insertOne(row)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'clinic.visit',
        entity: 'student',
        entityId: b.studentId,
        branchId: visit.branchId,
        meta: { visitId: visit._id, outcome: b.outcome, notified: visit.parentsNotifiedAt !== null },
      })
      return { visit, delivered }
    })
    if (result.delivered) nudgeQueue()
    return reply
      .code(201)
      .send({ ...visitResponse(result.visit, new Map([[b.studentId, access.student]])), delivered: result.delivered })
  })

  /** Students in the caller's branches with alerts or medication taken at
   * school: the nurse's list. */
  app.get('/clinic/alerts', scoped('health.read'), async (request, reply) => {
    const { branchId } = request.query as { branchId?: string }
    const branches = await branchFilter(request, branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const data = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const profiles = await ctx.studentHealth
        .find({ $or: [{ 'allergies.alert': true }, { 'conditions.alert': true }, { 'medications.atSchool': true }] })
        .toArray()
      const students = await ctx.students
        .find({
          _id: { $in: profiles.map((p) => p._id) },
          status: 'enrolled',
          ...(branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}),
        })
        .toArray()
      return { profiles: new Map(profiles.map((p) => [p._id, p])), students }
    })
    const rows = data.students
      .map((s) => {
        const p = data.profiles.get(s._id)!
        return {
          studentId: s._id,
          studentName: studentName(s),
          studentNumber: s.studentNumber,
          studentGroup: s.studentGroup,
          branchId: s.branchId,
          alerts: healthAlerts(p),
          medicationsAtSchool: p.medications.filter((m) => m.atSchool).map((m) => ({ name: m.name, dose: m.dose, schedule: m.schedule })),
        }
      })
      .sort((a, b) => a.studentGroup.localeCompare(b.studentGroup) || a.studentName.localeCompare(b.studentName))
    return reply.send({ students: rows })
  })
}
