// SAMS 11.2: gradebook and report cards — plans, marks, weighted results,
// ranks, release to families, the portal, and who may do what.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { signAccessToken } from '../auth/tokens.js'
import { bandOf, DEFAULT_BANDS, termPercent, yearPercent } from '../grades/service.js'
import type { AssessmentPlanDoc } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
let teacher = ''
let teacherB = ''
let classA = ''
const students: string[] = []
const put = (path: string, body: unknown, token = fx.tokens.admin) => call(fx.app, token, 'PUT', path, body)
const post = (path: string, body: unknown, token = fx.tokens.admin) => call(fx.app, token, 'POST', path, body)
const get = (path: string, token = fx.tokens.admin) => call(fx.app, token, 'GET', path)

const PLAN = () => ({
  academicYearId: fin.yearId,
  gradeLevel: 'Grade 5',
  subjects: ['math', 'arabic'],
  terms: [
    {
      termId: 't1',
      weight: 1,
      assessments: [
        { id: 'q1', name: 'Quiz', weight: 20, maxScore: 20 },
        { id: 'mid', name: 'Midterm', weight: 30, maxScore: 50 },
        { id: 'fin', name: 'Final', weight: 50, maxScore: 100 },
      ],
    },
    { termId: 't2', weight: 1, assessments: [{ id: 'fin2', name: 'Final', weight: 100, maxScore: 100 }] },
  ],
})

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
  await withTenant(fx.tenantId, (ctx) =>
    ctx.academicYears.updateMany(
      { _id: fin.yearId },
      {
        $set: {
          terms: [
            { id: 't1', name: 'Term 1', startDate: '2026-08-01', endDate: '2026-12-31' },
            { id: 't2', name: 'Term 2', startDate: '2027-01-01', endDate: '2027-06-30' },
          ],
        },
      },
    ),
  )
  classA = fin.classOf[fx.branchA]!
  for (let i = 0; i < 3; i++) students.push(await fin.student(fx.branchA))
  teacher = (await member(fx.tenantId, 'viewer', [fx.branchA], 'teacher')).token
  teacherB = (await member(fx.tenantId, 'viewer', [fx.branchB], 'teacher')).token
})
after(async () => {
  await fx.close()
})

describe('the maths', () => {
  const plan = () => PLAN() as unknown as AssessmentPlanDoc
  test('a term result weighs what was taken; a blank one leaves the rest to carry it', () => {
    // 18/20·20 + 40/50·30 + 70/100·50 = 18 + 24 + 35 = 77
    assert.equal(termPercent(plan(), 't1', [{ assessmentId: 'q1', score: 18 }, { assessmentId: 'mid', score: 40 }, { assessmentId: 'fin', score: 70 }]), 77)
    // Absent from the quiz: (24 + 35) / 80 = 73.75
    assert.equal(termPercent(plan(), 't1', [{ assessmentId: 'q1', score: null }, { assessmentId: 'mid', score: 40 }, { assessmentId: 'fin', score: 70 }]), 73.8)
    assert.equal(termPercent(plan(), 't1', []), null)
    assert.equal(yearPercent(plan(), new Map([['t1', 77], ['t2', 90]])), 83.5)
    assert.equal(yearPercent(plan(), new Map([['t1', 77], ['t2', null]])), 77)
  })
  test('bands', () => {
    assert.equal(bandOf(DEFAULT_BANDS, 90)!.code, 'A')
    assert.equal(bandOf(DEFAULT_BANDS, 89.9)!.code, 'B')
    assert.equal(bandOf(DEFAULT_BANDS, 3)!.code, 'F')
  })
})

describe('terms', () => {
  test('are set inside the year, in order, without overlap; a used one stays', async () => {
    const other = await call(fx.app, fx.tokens.admin, 'POST', '/academic-years', { name: 'Spare', startDate: '2030-08-01', endDate: '2031-06-30' })
    const id = (other.body as { id: string }).id
    const setTerms = (terms: unknown[]) => put(`/academic-years/${id}/terms`, { terms })
    assert.equal((await setTerms([{ name: 'T1', startDate: '2029-01-01', endDate: '2030-12-31' }])).error, 'TERM_OUTSIDE_YEAR')
    assert.equal(
      (await setTerms([{ name: 'T1', startDate: '2030-08-01', endDate: '2031-01-15' }, { name: 'T2', startDate: '2031-01-10', endDate: '2031-06-30' }])).error,
      'TERMS_OVERLAP',
    )
    const ok = await setTerms([{ name: 'T2', startDate: '2031-01-16', endDate: '2031-06-30' }, { name: 'T1', startDate: '2030-08-01', endDate: '2031-01-15' }])
    assert.equal(ok.status, 200, ok.error)
    assert.deepEqual((ok.body as { terms: { name: string }[] }).terms.map((t) => t.name), ['T1', 'T2'])
    // The fixture year's terms are in the plan below; removing one is refused then.
  })
})

describe('plans and the scale', () => {
  test('a plan names the year’s terms and known subjects', async () => {
    assert.equal((await put('/grades/plans', { ...PLAN(), subjects: ['alchemy'] })).error, 'UNKNOWN_SUBJECT')
    assert.equal((await put('/grades/plans', { ...PLAN(), terms: [{ termId: 'nope', weight: 1, assessments: [] }] })).error, 'UNKNOWN_TERM')
    assert.equal((await put('/grades/plans', PLAN(), teacher)).error, 'FORBIDDEN')
    const res = await put('/grades/plans', PLAN())
    assert.equal(res.status, 200, res.error)
    const plans = (await get(`/grades/plans?academicYearId=${fin.yearId}`, teacher)).body as { plans: unknown[] }
    assert.equal(plans.plans.length, 1)
  })

  test('the scale must reach down to zero', async () => {
    assert.equal((await put('/grades/settings', { bands: [{ min: 50, code: 'P', label: 'Pass' }], passMark: 50 })).error, 'LOWEST_BAND_MUST_START_AT_ZERO')
    const ok = await put('/grades/settings', {
      bands: [
        { min: 85, code: 'A', label: 'Excellent', labelAr: 'ممتاز' },
        { min: 60, code: 'B', label: 'Good', labelAr: 'جيد' },
        { min: 0, code: 'C', label: 'Weak', labelAr: 'ضعيف' },
      ],
      passMark: 60,
    })
    assert.equal(ok.status, 200, ok.error)
  })
})

describe('marks', () => {
  test('a teacher enters marks for a class in their branch, within each assessment’s maximum', async () => {
    const sheet = await get(`/grades/sheet?classId=${classA}&subjectCode=math&termId=t1`, teacher)
    assert.equal(sheet.status, 200, sheet.error)
    assert.equal((sheet.body as { students: unknown[] }).students.length, 3)
    const entries = (scores: [number | null, number | null, number | null][]) =>
      scores.flatMap((s, i) => [
        { studentId: students[i]!, assessmentId: 'q1', score: s[0] },
        { studentId: students[i]!, assessmentId: 'mid', score: s[1] },
        { studentId: students[i]!, assessmentId: 'fin', score: s[2] },
      ])
    const body = { classId: classA, subjectCode: 'math', termId: 't1', entries: entries([[18, 40, 70], [20, 50, 100], [5, 10, 20]]) }
    const saved = await put('/grades/sheet', body, teacher)
    assert.equal(saved.status, 200, saved.error)
    assert.equal((saved.body as { saved: number }).saved, 9)
    // Saving the same again changes nothing.
    assert.equal(((await put('/grades/sheet', body, teacher)).body as { saved: number }).saved, 0)
    assert.equal((await put('/grades/sheet', { ...body, entries: [{ studentId: students[0]!, assessmentId: 'q1', score: 21 }] }, teacher)).error, 'SCORE_ABOVE_MAX')
    assert.equal((await put('/grades/sheet', body, teacherB)).error, 'BRANCH_FORBIDDEN')
    assert.equal((await put('/grades/sheet', body, fx.tokens.viewer)).error, 'FORBIDDEN')
    const other = await fin.student(fx.branchB)
    assert.equal((await put('/grades/sheet', { ...body, entries: [{ studentId: other, assessmentId: 'q1', score: 1 }] }, teacher)).error, 'STUDENT_NOT_IN_CLASS')
    await put('/grades/sheet', { classId: classA, subjectCode: 'arabic', termId: 't1', entries: [{ studentId: students[0]!, assessmentId: 'fin', score: 95 }, { studentId: students[1]!, assessmentId: 'fin', score: 55 }] }, teacher)
  })

  test('results: per subject, average, band, rank and failed subjects', async () => {
    const res = await get(`/grades/results?classId=${classA}&termId=t1`, teacher)
    assert.equal(res.status, 200, res.error)
    type Row = { id: string; average: number; rank: number; failed: number; band: { code: string }; subjects: Record<string, { percent: number }> }
    const rows = new Map((res.body as { students: Row[] }).students.map((r) => [r.id, r]))
    const a = rows.get(students[0]!)!
    assert.equal(a.subjects.math!.percent, 77)
    assert.equal(a.subjects.arabic!.percent, 95)
    assert.equal(a.average, 86)
    assert.equal(a.band.code, 'A')
    const b = rows.get(students[1]!)!
    assert.equal(b.subjects.math!.percent, 100)
    assert.equal(b.failed, 1, 'arabic 55 is under the pass mark of 60')
    assert.deepEqual([a.rank, b.rank, rows.get(students[2]!)!.rank], [1, 2, 3])
  })

  test('a plan cannot drop an assessment or subject that has marks', async () => {
    const p = PLAN()
    p.terms[0]!.assessments = p.terms[0]!.assessments.filter((x) => x.id !== 'q1')
    assert.equal((await put('/grades/plans', p)).error, 'ASSESSMENT_HAS_MARKS')
    assert.equal((await put('/grades/plans', { ...PLAN(), subjects: ['math'] })).error, 'SUBJECT_HAS_MARKS')
    const lower = PLAN()
    lower.terms[0]!.assessments[2]!.maxScore = 60
    assert.equal((await put('/grades/plans', lower)).error, 'MAX_BELOW_ENTERED_SCORE')
  })
})

describe('report cards and release', () => {
  test('print as a page, in either language, and the print is audited', async () => {
    await put('/grades/comments', { studentId: students[0]!, termId: 't1', comment: 'A careful, curious student.' }, teacher)
    const page = await fx.app.inject({ method: 'GET', url: `/grades/report-cards?classId=${classA}&termId=t1`, headers: { authorization: `Bearer ${teacher}` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.headers['content-type'] as string, /text\/html/)
    assert.equal((page.body.match(/class="card"/g) ?? []).length, 3)
    assert.match(page.body, /A careful, curious student\./)
    assert.match(page.body, /77\.0%/)
    const ar = await fx.app.inject({ method: 'GET', url: `/grades/report-cards?classId=${classA}&termId=t1&lang=ar&studentId=${students[0]}`, headers: { authorization: `Bearer ${teacher}` } })
    assert.match(ar.body, /dir="rtl"/)
    assert.match(ar.body, /الرياضيات/)
    assert.equal((ar.body.match(/class="card"/g) ?? []).length, 1)
    const audit = await withTenant(fx.tenantId, (ctx) => ctx.auditLog.countDocuments({ action: 'grades.cards.print' }))
    assert.equal(audit, 2)
  })

  test('releasing tells the families, locks the marks, and shows in the portal', async () => {
    // A family for the first student, with the portal on.
    const p = await post('/parents', { fullName: 'Parent One', primaryPhone: '0791112233', email: 'one@family.test' })
    const parentId = (p.body as { parent: { id: string } }).parent.id
    await post(`/parents/${parentId}/links`, { studentId: students[0]!, relationshipType: 'father', portalAccess: true })
    await post(`/parents/${parentId}/portal/enable`, {})
    const parent = await withTenant(fx.tenantId, (ctx) => ctx.parents.findOne({ _id: parentId }))
    const portal = await signAccessToken({ sub: parent!.portalAccess.userId!, email: parent!.email!, tenantId: fx.tenantId, role: 'viewer' })

    assert.equal(((await get(`/portal/children/${students[0]}/report-cards`, portal)).body as { cards: unknown[] }).cards.length, 0)
    assert.equal((await post('/grades/release', { classId: classA, termId: 't1' }, teacher)).error, 'FORBIDDEN')
    const rel = await post('/grades/release', { classId: classA, termId: 't1' })
    assert.equal(rel.status, 200, rel.error)
    assert.equal((await post('/grades/release', { classId: classA, termId: 't1' })).error, 'ALREADY_RELEASED')
    const jobs = await withTenant(fx.tenantId, (ctx) => ctx.notificationJobs.find({ kind: 'report_card' }).toArray())
    assert.ok(jobs.length >= 1 && jobs.every((j) => j.body.includes('Term 1')))

    const locked = await put('/grades/sheet', { classId: classA, subjectCode: 'math', termId: 't1', entries: [{ studentId: students[0]!, assessmentId: 'q1', score: 1 }] }, teacher)
    assert.equal(locked.error, 'TERM_RELEASED')

    const list = (await get(`/portal/children/${students[0]}/report-cards`, portal)).body as { cards: { termId: string; term: string }[] }
    assert.deepEqual(list.cards.map((c) => [c.termId, c.term]), [['t1', 'Term 1']])
    const card = await fx.app.inject({ method: 'GET', url: `/portal/children/${students[0]}/report-cards/t1`, headers: { authorization: `Bearer ${portal}` } })
    assert.equal(card.statusCode, 200)
    assert.equal((card.body.match(/class="card"/g) ?? []).length, 1, 'only their own child')
    assert.equal((await get(`/portal/children/${students[1]}/report-cards`, portal)).error, 'NOT_FOUND')
    assert.equal((await get(`/portal/children/${students[0]}/report-cards/t2`, portal)).error, 'NOT_RELEASED')

    assert.equal((await post('/grades/unrelease', { classId: classA, termId: 't1' })).status, 200)
    assert.equal(((await put('/grades/sheet', { classId: classA, subjectCode: 'math', termId: 't1', entries: [{ studentId: students[0]!, assessmentId: 'q1', score: 19 }] }, teacher)).body as { saved: number }).saved, 1)
  })

  test('a term in a plan cannot be removed from the year', async () => {
    const res = await put(`/academic-years/${fin.yearId}/terms`, { terms: [{ id: 't1', name: 'Term 1', startDate: '2026-08-01', endDate: '2026-12-31' }] })
    assert.equal(res.error, 'TERM_IN_USE')
  })

  test('the year result draws on both terms', async () => {
    await put('/grades/sheet', { classId: classA, subjectCode: 'math', termId: 't2', entries: [{ studentId: students[0]!, assessmentId: 'fin2', score: 90 }] }, teacher)
    const res = (await get(`/grades/results?classId=${classA}&termId=year`, teacher)).body as { students: { id: string; subjects: Record<string, { percent: number }> }[] }
    const a = res.students.find((s) => s.id === students[0])!
    // Term 1 math is now (19 + 24 + 35) = 78; year = (78 + 90) / 2 = 84.
    assert.equal(a.subjects.math!.percent, 84)
  })
})
