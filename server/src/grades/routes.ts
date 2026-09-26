import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { withoutTenant, withTenant } from '../db.js'
import type { AssessmentPlanDoc, MarkDoc, SchoolClassDoc, StudentDoc, TenantContext } from '../db.js'
import { callerCanUseBranch } from '../auth/guard.js'
import { recordAudit } from '../audit.js'
import { config } from '../config.js'
import { scoped } from '../records.js'
import { activeCodes, ensureDefaults } from '../settings/lookups.js'
import { notifyFamilies, nudgeQueue, schoolName } from '../notifications/messages.js'
import { portalContext } from '../portal/routes.js'
import { loadGrading, reportCardsPage, results, type CardData } from './service.js'

/**
 * SAMS 11.2 — gradebook and report cards:
 *  - the grading scale and each grade's assessment plan (`grades.manage`);
 *  - marks entered per class, subject and term (`grades.enter`, inside the
 *    caller's branches); a released term is locked until un-released;
 *  - results and printable report cards (`grades.read`);
 *  - releasing a class's term: families are told and see it in the portal.
 */

const bandBody = z.object({
  min: z.number().min(0).max(100),
  code: z.string().trim().min(1).max(6),
  label: z.string().trim().min(1).max(60),
  labelAr: z.string().trim().max(60).default(''),
})
const settingsBody = z.object({ bands: z.array(bandBody).min(1).max(12), passMark: z.number().min(0).max(100) }).strict()

const assessmentBody = z.object({
  id: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(60),
  nameAr: z.string().trim().max(60).nullable().default(null),
  weight: z.number().positive().max(1000),
  maxScore: z.number().positive().max(1000),
})
const planBody = z
  .object({
    academicYearId: z.string().min(1),
    gradeLevel: z.string().trim().min(1).max(60),
    subjects: z.array(z.string().min(1).max(40)).min(1).max(40),
    terms: z
      .array(z.object({ termId: z.string().min(1), weight: z.number().min(0).max(1000), assessments: z.array(assessmentBody).max(30) }))
      .min(1)
      .max(6),
  })
  .strict()

const sheetQuery = z.object({ classId: z.string().min(1), subjectCode: z.string().min(1), termId: z.string().min(1) })
const sheetBody = sheetQuery
  .extend({
    entries: z
      .array(z.object({ studentId: z.string().min(1), assessmentId: z.string().min(1), score: z.number().min(0).nullable() }))
      .max(5000),
  })
  .strict()
const resultsQuery = z.object({ classId: z.string().min(1), termId: z.string().min(1) })
const cardsQuery = resultsQuery.extend({
  studentId: z.string().optional(),
  lang: z.enum(['en', 'ar']).default('en'),
  autoprint: z.enum(['0', '1']).optional(),
})
const commentBody = z.object({ studentId: z.string().min(1), termId: z.string().min(1), comment: z.string().trim().max(1000) }).strict()
const releaseBody = z.object({ classId: z.string().min(1), termId: z.string().min(1) }).strict()

const studentName = (s: StudentDoc) => `${s.givenName} ${s.familyName}`.trim()
const studentNameAr = (s: StudentDoc) => [s.givenNameAr, s.familyNameAr].filter(Boolean).join(' ') || null
const className = (c: SchoolClassDoc) => `${c.gradeLevel} ${c.name}`.trim()

interface ClassScope {
  cls: SchoolClassDoc
  plan: AssessmentPlanDoc | null
  yearName: string
  terms: { id: string; name: string; startDate: string; endDate: string }[]
  students: StudentDoc[]
}

/** A class the caller may work with, its year's plan and its students. */
async function classScope(ctx: TenantContext, request: FastifyRequest, classId: string): Promise<ClassScope | { error: string; status: number }> {
  const cls = await ctx.classes.findOne({ _id: classId })
  if (!cls) return { error: 'NOT_FOUND', status: 404 }
  if (!(await callerCanUseBranch(request, cls.branchId))) return { error: 'BRANCH_FORBIDDEN', status: 403 }
  if (!cls.academicYearId) return { error: 'CLASS_HAS_NO_YEAR', status: 409 }
  const year = await ctx.academicYears.findOne({ _id: cls.academicYearId })
  const plan = await ctx.assessmentPlans.findOne({ academicYearId: cls.academicYearId, gradeLevel: cls.gradeLevel })
  const students = await ctx.students
    .find({ classId, status: 'enrolled' })
    .sort({ familyName: 1, givenName: 1 })
    .toArray()
  return { cls, plan, yearName: year?.name ?? '', terms: year?.terms ?? [], students }
}

const isError = (x: unknown): x is { error: string; status: number } => typeof x === 'object' && x !== null && 'error' in x

async function subjectLabels(ctx: TenantContext, tenantId: string, lang: 'en' | 'ar') {
  await ensureDefaults(tenantId, 'subject')
  const rows = await ctx.lookups.find({ kind: 'subject' }).toArray()
  return new Map(rows.map((r) => [r.code, (lang === 'ar' && r.labelAr) || r.label]))
}

function termLabel(terms: ClassScope['terms'], termId: string, lang: 'en' | 'ar') {
  if (termId === 'year') return lang === 'ar' ? 'العام الدراسي كاملًا' : 'Full year'
  return terms.find((t) => t.id === termId)?.name ?? termId
}

/** Report cards for some of a class's students, as a print page. */
async function buildCards(
  ctx: TenantContext,
  tenantId: string,
  scope: ClassScope,
  termId: string,
  lang: 'en' | 'ar',
  onlyStudent?: string,
): Promise<{ html: string; count: number }> {
  const plan = scope.plan!
  const grading = await loadGrading(ctx, tenantId)
  const students = onlyStudent ? scope.students.filter((s) => s._id === onlyStudent) : scope.students
  const marks = await ctx.marks.find({ classId: scope.cls._id, academicYearId: plan.academicYearId }).toArray()
  // Ranks are within the whole class, whoever is printed.
  const all = results(plan, grading, scope.students.map((s) => s._id), marks, termId)
  const byStudent = new Map(all.map((r) => [r.studentId, r]))
  const labels = await subjectLabels(ctx, tenantId, lang)
  const term = scope.terms.find((t) => t.id === termId)
  const from = term?.startDate ?? scope.terms[0]?.startDate ?? '0000-01-01'
  const to = term?.endDate ?? scope.terms[scope.terms.length - 1]?.endDate ?? '9999-12-31'
  const attendance = await ctx.attendance.find({ studentId: { $in: students.map((s) => s._id) }, date: { $gte: from, $lte: to } }).toArray()
  const comments = await ctx.reportComments.find({ studentId: { $in: students.map((s) => s._id) }, termId }).toArray()
  const commentOf = new Map(comments.map((c) => [c.studentId, c.comment]))
  const cards: CardData[] = students.map((s) => {
    const own = attendance.filter((a) => a.studentId === s._id)
    const count = (st: string) => own.filter((a) => a.status === st).length
    return {
      studentName: studentName(s),
      studentNameAr: studentNameAr(s),
      studentNumber: s.studentNumber,
      className: className(scope.cls),
      result: byStudent.get(s._id)!,
      subjects: plan.subjects.map((code) => ({ code, label: labels.get(code) ?? code })),
      attendance: own.length ? { present: count('present') + count('early_departure'), absent: count('absent'), late: count('late'), excused: count('excused') } : null,
      comment: commentOf.get(s._id) ?? null,
    }
  })
  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: tenantId }))
  return {
    html: reportCardsPage(cards, {
      school: tenant?.name ?? '',
      schoolAr: tenant?.profile?.nameAr ?? null,
      period: termLabel(scope.terms, termId, lang),
      year: scope.yearName,
      lang,
      passMark: grading.passMark,
      autoPrint: false,
    }),
    count: cards.length,
  }
}

const sendHtml = (reply: FastifyReply, body: string) =>
  reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(body)

export function registerGradeRoutes(app: FastifyInstance): void {
  // ------------------------------------------------ scale and plans --

  app.get('/grades/settings', scoped('grades.read'), async (request, reply) => {
    const tenantId = request.auth!.tenantId!
    const out = await withTenant(tenantId, async (ctx) => {
      const g = await loadGrading(ctx, tenantId)
      return { bands: g.bands, passMark: g.passMark }
    })
    return reply.send(out)
  })

  app.put('/grades/settings', scoped('grades.manage'), async (request, reply) => {
    const parsed = settingsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const bands = [...parsed.data.bands].sort((a, b) => b.min - a.min)
    if (bands[bands.length - 1]!.min !== 0) return reply.code(400).send({ error: 'LOWEST_BAND_MUST_START_AT_ZERO' })
    if (new Set(bands.map((b) => b.min)).size !== bands.length) return reply.code(400).send({ error: 'DUPLICATE_BAND' })
    const tenantId = request.auth!.tenantId!
    await withTenant(tenantId, async (ctx) => {
      const before = await loadGrading(ctx, tenantId)
      await ctx.gradingSettings.findOneAndUpdate(
        { _id: tenantId },
        { $set: { bands, passMark: parsed.data.passMark, updatedAt: new Date(), updatedBy: request.auth!.sub }, $setOnInsert: { tenantId } },
        { upsert: true },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'grades.settings.update',
        entity: 'tenant',
        entityId: tenantId,
        before: { bands: before.bands, passMark: before.passMark },
        after: { bands, passMark: parsed.data.passMark },
      })
    })
    return reply.send({ bands, passMark: parsed.data.passMark })
  })

  app.get('/grades/plans', scoped('grades.read'), async (request, reply) => {
    const { academicYearId } = request.query as { academicYearId?: string }
    if (!academicYearId) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const plans = await withTenant(request.auth!.tenantId!, (ctx) => ctx.assessmentPlans.find({ academicYearId }).sort({ gradeLevel: 1 }).toArray())
    return reply.send({ plans: plans.map(({ _id, academicYearId: y, gradeLevel, subjects, terms, updatedAt }) => ({ id: _id, academicYearId: y, gradeLevel, subjects, terms, updatedAt })) })
  })

  app.put('/grades/plans', scoped('grades.manage'), async (request, reply) => {
    const parsed = planBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const body = parsed.data
    const tenantId = request.auth!.tenantId!
    await ensureDefaults(tenantId, 'subject')
    const out = await withTenant(tenantId, async (ctx) => {
      const year = await ctx.academicYears.findOne({ _id: body.academicYearId })
      if (!year) return { error: 'UNKNOWN_YEAR' }
      const termIds = new Set(year.terms.map((t) => t.id))
      if (year.terms.length === 0) return { error: 'YEAR_HAS_NO_TERMS' }
      if (body.terms.some((t) => !termIds.has(t.termId)) || new Set(body.terms.map((t) => t.termId)).size !== body.terms.length) {
        return { error: 'UNKNOWN_TERM' }
      }
      const subjects = await activeCodes(ctx, 'subject')
      if (body.subjects.some((s) => !subjects.has(s)) || new Set(body.subjects).size !== body.subjects.length) return { error: 'UNKNOWN_SUBJECT' }

      const terms = body.terms.map((t) => ({ ...t, assessments: t.assessments.map((a) => ({ ...a, id: a.id ?? randomUUID().slice(0, 8) })) }))
      const ids = terms.flatMap((t) => t.assessments.map((a) => a.id))
      if (new Set(ids).size !== ids.length) return { error: 'DUPLICATE_ASSESSMENT' }

      const existing = await ctx.assessmentPlans.findOne({ academicYearId: body.academicYearId, gradeLevel: body.gradeLevel })
      if (existing) {
        // Marks already entered hold their assessment in place.
        const marked = await ctx.marks.find({ academicYearId: body.academicYearId, assessmentId: { $in: existing.terms.flatMap((t) => t.assessments.map((a) => a.id)) } }).toArray()
        const classIds = new Set((await ctx.classes.find({ academicYearId: body.academicYearId, gradeLevel: body.gradeLevel }).toArray()).map((c) => c._id))
        const ours = marked.filter((m) => classIds.has(m.classId))
        const kept = new Map(terms.flatMap((t) => t.assessments.map((a) => [a.id, a] as const)))
        for (const m of ours) {
          const a = kept.get(m.assessmentId)
          if (!a) return { error: 'ASSESSMENT_HAS_MARKS' }
          if (m.score !== null && m.score > a.maxScore) return { error: 'MAX_BELOW_ENTERED_SCORE' }
          if (!body.subjects.includes(m.subjectCode)) return { error: 'SUBJECT_HAS_MARKS' }
        }
      }
      const now = new Date()
      const doc = await ctx.assessmentPlans.findOneAndUpdate(
        { academicYearId: body.academicYearId, gradeLevel: body.gradeLevel },
        {
          $set: { subjects: body.subjects, terms, updatedAt: now, updatedBy: request.auth!.sub },
          $setOnInsert: { _id: randomUUID(), createdAt: now, tenantId } as never,
        },
        { upsert: true, returnDocument: 'after' },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'grades.plan.set',
        entity: 'assessmentPlan',
        entityId: doc!._id,
        before: existing ? { subjects: existing.subjects, terms: existing.terms } : null,
        after: { gradeLevel: body.gradeLevel, subjects: body.subjects, terms },
      })
      return { plan: doc! }
    })
    if ('error' in out && out.error) {
      const status = out.error === 'UNKNOWN_YEAR' ? 404 : out.error.endsWith('_MARKS') || out.error === 'MAX_BELOW_ENTERED_SCORE' ? 409 : 400
      return reply.code(status).send({ error: out.error })
    }
    const p = (out as { plan: AssessmentPlanDoc }).plan
    return reply.send({ id: p._id, academicYearId: p.academicYearId, gradeLevel: p.gradeLevel, subjects: p.subjects, terms: p.terms })
  })

  // ------------------------------------------------------- marks --

  app.get('/grades/sheet', scoped('grades.read'), async (request, reply) => {
    const parsed = sheetQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const q = parsed.data
    const out = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const scope = await classScope(ctx, request, q.classId)
      if (isError(scope)) return scope
      if (!scope.plan) return { error: 'NO_PLAN', status: 409 }
      const term = scope.plan.terms.find((t) => t.termId === q.termId)
      if (!term || !scope.plan.subjects.includes(q.subjectCode)) return { error: 'NOT_IN_PLAN', status: 400 }
      const marks = await ctx.marks.find({ classId: q.classId, subjectCode: q.subjectCode, termId: q.termId }).toArray()
      const released = await ctx.reportReleases.findOne({ _id: `${q.classId}:${q.termId}` })
      return {
        assessments: term.assessments,
        released: Boolean(released),
        students: scope.students.map((s) => ({ id: s._id, name: studentName(s), studentNumber: s.studentNumber })),
        marks: marks.map((m) => ({ studentId: m.studentId, assessmentId: m.assessmentId, score: m.score })),
      }
    })
    if (isError(out)) return reply.code(out.status).send({ error: out.error })
    return reply.send(out)
  })

  app.put('/grades/sheet', scoped('grades.enter'), async (request, reply) => {
    const parsed = sheetBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const b = parsed.data
    const out = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const scope = await classScope(ctx, request, b.classId)
      if (isError(scope)) return scope
      if (!scope.plan) return { error: 'NO_PLAN', status: 409 }
      const term = scope.plan.terms.find((t) => t.termId === b.termId)
      if (!term || !scope.plan.subjects.includes(b.subjectCode)) return { error: 'NOT_IN_PLAN', status: 400 }
      if (await ctx.reportReleases.findOne({ _id: `${b.classId}:${b.termId}` })) return { error: 'TERM_RELEASED', status: 409 }
      const inClass = new Set(scope.students.map((s) => s._id))
      const assessments = new Map(term.assessments.map((a) => [a.id, a]))
      for (const e of b.entries) {
        if (!inClass.has(e.studentId)) return { error: 'STUDENT_NOT_IN_CLASS', status: 400 }
        const a = assessments.get(e.assessmentId)
        if (!a) return { error: 'NOT_IN_PLAN', status: 400 }
        if (e.score !== null && e.score > a.maxScore) return { error: 'SCORE_ABOVE_MAX', status: 400, max: a.maxScore }
      }
      const now = new Date()
      let changed = 0
      for (const e of b.entries) {
        const key = { studentId: e.studentId, academicYearId: scope.plan.academicYearId, assessmentId: e.assessmentId, subjectCode: b.subjectCode }
        const before = await ctx.marks.findOne(key)
        if (before && before.score === e.score) continue
        await ctx.marks.findOneAndUpdate(
          key,
          {
            $set: { score: e.score, termId: b.termId, classId: b.classId, branchId: scope.cls.branchId, enteredBy: request.auth!.sub, updatedAt: now },
            $setOnInsert: { _id: randomUUID() } as Partial<MarkDoc>,
          },
          { upsert: true },
        )
        changed++
      }
      if (changed > 0) {
        await recordAudit(ctx.auditLog, {
          actorId: request.auth!.sub,
          action: 'grades.marks.enter',
          entity: 'class',
          entityId: b.classId,
          branchId: scope.cls.branchId,
          before: null,
          after: { subject: b.subjectCode, termId: b.termId, changed },
        })
      }
      return { saved: changed }
    })
    if (isError(out)) {
      const { status, ...rest } = out as { status: number; error: string }
      return reply.code(status).send(rest)
    }
    return reply.send(out)
  })

  app.put('/grades/comments', scoped('grades.enter'), async (request, reply) => {
    const parsed = commentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const b = parsed.data
    const out = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const student = await ctx.students.findOne({ _id: b.studentId })
      if (!student) return { error: 'NOT_FOUND', status: 404 }
      if (!(await callerCanUseBranch(request, student.branchId))) return { error: 'BRANCH_FORBIDDEN', status: 403 }
      if (student.classId && (await ctx.reportReleases.findOne({ _id: `${student.classId}:${b.termId}` }))) return { error: 'TERM_RELEASED', status: 409 }
      await ctx.reportComments.findOneAndUpdate(
        { _id: `${b.studentId}:${b.termId}` },
        { $set: { studentId: b.studentId, termId: b.termId, comment: b.comment, updatedBy: request.auth!.sub, updatedAt: new Date() }, $setOnInsert: { tenantId: request.auth!.tenantId! } as never },
        { upsert: true },
      )
      return { ok: true }
    })
    if (isError(out)) return reply.code(out.status).send({ error: out.error })
    return reply.send(out)
  })

  // ---------------------------------------------- results and cards --

  app.get('/grades/results', scoped('grades.read'), async (request, reply) => {
    const parsed = resultsQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const q = parsed.data
    const tenantId = request.auth!.tenantId!
    const out = await withTenant(tenantId, async (ctx) => {
      const scope = await classScope(ctx, request, q.classId)
      if (isError(scope)) return scope
      if (!scope.plan) return { error: 'NO_PLAN', status: 409 }
      if (q.termId !== 'year' && !scope.plan.terms.some((t) => t.termId === q.termId)) return { error: 'NOT_IN_PLAN', status: 400 }
      const grading = await loadGrading(ctx, tenantId)
      const marks = await ctx.marks.find({ classId: q.classId, academicYearId: scope.plan.academicYearId }).toArray()
      const rows = results(scope.plan, grading, scope.students.map((s) => s._id), marks, q.termId)
      const byId = new Map(scope.students.map((s) => [s._id, s]))
      const comments = await ctx.reportComments.find({ studentId: { $in: scope.students.map((s) => s._id) }, termId: q.termId }).toArray()
      const commentOf = new Map(comments.map((c) => [c.studentId, c.comment]))
      const releases = await ctx.reportReleases.find({ classId: q.classId }).toArray()
      return {
        subjects: scope.plan.subjects,
        passMark: grading.passMark,
        released: releases.some((r) => r.termId === q.termId),
        releasedTerms: releases.map((r) => r.termId),
        students: rows.map((r) => ({
          id: r.studentId,
          name: studentName(byId.get(r.studentId)!),
          studentNumber: byId.get(r.studentId)!.studentNumber,
          comment: commentOf.get(r.studentId) ?? null,
          ...r,
        })),
      }
    })
    if (isError(out)) return reply.code(out.status).send({ error: out.error })
    return reply.send(out)
  })

  app.get('/grades/report-cards', scoped('grades.read'), async (request, reply) => {
    const parsed = cardsQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const q = parsed.data
    const tenantId = request.auth!.tenantId!
    const out = await withTenant(tenantId, async (ctx) => {
      const scope = await classScope(ctx, request, q.classId)
      if (isError(scope)) return scope
      if (!scope.plan) return { error: 'NO_PLAN', status: 409 }
      const built = await buildCards(ctx, tenantId, scope, q.termId, q.lang, q.studentId)
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'grades.cards.print',
        entity: 'class',
        entityId: q.classId,
        branchId: scope.cls.branchId,
        before: null,
        after: { termId: q.termId, count: built.count },
      })
      return built
    })
    if (isError(out)) return reply.code(out.status).send({ error: out.error })
    return sendHtml(reply, q.autoprint === '1' ? out.html.replace('</body>', '<script>addEventListener("load",()=>setTimeout(()=>print(),300))</script></body>') : out.html)
  })

  // ------------------------------------------------------ release --

  app.post('/grades/release', scoped('grades.manage'), async (request, reply) => {
    const parsed = releaseBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const b = parsed.data
    const tenantId = request.auth!.tenantId!
    const school = await schoolName(tenantId)
    const out = await withTenant(tenantId, async (ctx) => {
      const scope = await classScope(ctx, request, b.classId)
      if (isError(scope)) return scope
      if (!scope.plan) return { error: 'NO_PLAN', status: 409 }
      if (b.termId !== 'year' && !scope.plan.terms.some((t) => t.termId === b.termId)) return { error: 'NOT_IN_PLAN', status: 400 }
      const _id = `${b.classId}:${b.termId}`
      if (await ctx.reportReleases.findOne({ _id })) return { error: 'ALREADY_RELEASED', status: 409 }
      await ctx.reportReleases.insertOne({
        _id,
        classId: b.classId,
        branchId: scope.cls.branchId,
        academicYearId: scope.plan.academicYearId,
        termId: b.termId,
        releasedAt: new Date(),
        releasedBy: request.auth!.sub,
      })
      const delivered = await notifyFamilies(ctx, tenantId, {
        kind: 'report_card',
        sourceId: _id,
        studentIds: scope.students.map((s) => s._id),
        recipients: 'all',
        tokens: (student, parent) => ({
          parentName: parent.fullName,
          studentName: studentName(student),
          term: termLabel(scope.terms, b.termId, parent.preferredLanguage === 'ar' ? 'ar' : 'en'),
          link: `${config.appUrl}/portal/children/${student._id}?tab=reports`,
          schoolName: school,
        }),
        link: (studentId) => `/portal/children/${studentId}?tab=reports`,
        trigger: 'manual',
        actorId: request.auth!.sub,
      })
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'grades.release',
        entity: 'class',
        entityId: b.classId,
        branchId: scope.cls.branchId,
        before: null,
        after: { termId: b.termId, students: scope.students.length },
      })
      return { released: true, students: scope.students.length, delivered }
    })
    if (isError(out)) return reply.code(out.status).send({ error: out.error })
    nudgeQueue()
    return reply.send(out)
  })

  app.post('/grades/unrelease', scoped('grades.manage'), async (request, reply) => {
    const parsed = releaseBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const b = parsed.data
    const out = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const scope = await classScope(ctx, request, b.classId)
      if (isError(scope)) return scope
      const res = await ctx.reportReleases.deleteOne({ _id: `${b.classId}:${b.termId}` })
      if (res.deletedCount === 0) return { error: 'NOT_RELEASED', status: 409 }
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'grades.unrelease',
        entity: 'class',
        entityId: b.classId,
        branchId: scope.cls.branchId,
        before: { termId: b.termId },
        after: null,
      })
      return { released: false }
    })
    if (isError(out)) return reply.code(out.status).send({ error: out.error })
    return reply.send(out)
  })

  // ------------------------------------------------------- portal --

  const portalChild = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    return withTenant(tenantId, async (ctx) => {
      const pc = await portalContext(ctx, request.auth!.sub)
      if (!pc || !pc.links.some((l) => l.studentId === id)) return null
      const student = await ctx.students.findOne({ _id: id })
      if (!student?.classId) return { student, releases: [] }
      const releases = await ctx.reportReleases.find({ classId: student.classId }).sort({ releasedAt: -1 }).toArray()
      return { student, releases }
    })
  }

  app.get('/portal/children/:id/report-cards', scoped('portal.parent'), async (request, reply) => {
    const found = await portalChild(request)
    if (!found?.student) return reply.code(404).send({ error: 'NOT_FOUND' })
    const lang = (request.query as { lang?: string }).lang === 'ar' ? 'ar' : 'en'
    const year = found.student.academicYearId
      ? await withTenant(request.auth!.tenantId!, (ctx) => ctx.academicYears.findOne({ _id: found.student!.academicYearId! }))
      : null
    return reply.send({
      cards: found.releases.map((r) => ({ termId: r.termId, term: termLabel(year?.terms ?? [], r.termId, lang), releasedAt: r.releasedAt.toISOString() })),
    })
  })

  app.get('/portal/children/:id/report-cards/:termId', scoped('portal.parent'), async (request, reply) => {
    const { termId } = request.params as { termId: string }
    const found = await portalChild(request)
    if (!found?.student) return reply.code(404).send({ error: 'NOT_FOUND' })
    if (!found.releases.some((r) => r.termId === termId)) return reply.code(404).send({ error: 'NOT_RELEASED' })
    const lang = (request.query as { lang?: string }).lang === 'ar' ? 'ar' : 'en'
    const tenantId = request.auth!.tenantId!
    const html = await withTenant(tenantId, async (ctx) => {
      const cls = await ctx.classes.findOne({ _id: found.student!.classId })
      if (!cls?.academicYearId) return null
      const year = await ctx.academicYears.findOne({ _id: cls.academicYearId })
      const plan = await ctx.assessmentPlans.findOne({ academicYearId: cls.academicYearId, gradeLevel: cls.gradeLevel })
      if (!plan) return null
      const students = await ctx.students.find({ classId: cls._id, status: 'enrolled' }).toArray()
      const scope: ClassScope = { cls, plan, yearName: year?.name ?? '', terms: year?.terms ?? [], students }
      return (await buildCards(ctx, tenantId, scope, termId, lang, found.student!._id)).html
    })
    if (!html) return reply.code(404).send({ error: 'NOT_FOUND' })
    return sendHtml(reply, html)
  })
}
