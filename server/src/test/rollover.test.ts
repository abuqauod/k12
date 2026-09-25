// SAMS 2.6: year-end re-enrollment — the proposal and its suggestions,
// preview without writes, an all-or-nothing commit (planned places,
// graduations, withdrawals), and starting the new year.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import { call, createFixture, type Fixture } from './harness.js'

let fx: Fixture
const Y = { now: '', next: '' }
const C: Record<string, string> = {}
const S: Record<string, string> = {}

type Proposal = {
  rows: { studentId: string; suggested: { action: string; toClassId: string | null }; existing: unknown }[]
}

async function klass(key: string, yearId: string, gradeLevel: string, name: string, branchId = fx.branchA) {
  C[key] = randomUUID()
  await withTenant(fx.tenantId, (ctx) =>
    ctx.classes.insertOne({
      _id: C[key]!,
      branchId,
      gradeLevel,
      name,
      capacity: 30,
      homeroomTeacherId: null,
      academicYearId: yearId,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  )
}

async function student(key: string, classKey: string) {
  const res = await call(fx.app, fx.tokens.admin, 'POST', '/students', {
    studentNumber: `R-${key}-${randomUUID().slice(0, 6)}`,
    givenName: key,
    familyName: 'Roll',
    classId: C[classKey],
  })
  assert.equal(res.status, 201, res.error)
  S[key] = (res.body as { id: string }).id
}

const years = () => ({ branchId: fx.branchA, fromYearId: Y.now, toYearId: Y.next })
const post = (path: string, body: unknown, token = fx.tokens.admin) => call(fx.app, token, 'POST', path, body)

const enrollmentsOf = (key: string) =>
  withTenant(fx.tenantId, (ctx) => ctx.enrollments.find({ studentId: S[key] }).sort({ createdAt: 1 }).toArray())

before(async () => {
  fx = await createFixture()
  Y.now = randomUUID()
  Y.next = randomUUID()
  await withTenant(fx.tenantId, async (ctx) => {
    await ctx.academicYears.insertOne({ _id: Y.now, name: '2026–2027', startDate: '2026-08-01', endDate: '2027-06-30', terms: [], current: true, createdAt: new Date() })
    await ctx.academicYears.insertOne({ _id: Y.next, name: '2027–2028', startDate: '2027-08-15', endDate: '2028-06-30', terms: [], current: false, createdAt: new Date() })
  })
  await klass('g3a', Y.now, 'Grade 3', 'A')
  await klass('g3b', Y.now, 'Grade 3', 'B')
  await klass('g6a', Y.now, 'Grade 6', 'A')
  // Same names as this year's classes: allowed, the year differs.
  await klass('n4a', Y.next, 'Grade 4', 'A')
  await klass('n4b', Y.next, 'Grade 4', 'B')
  await klass('n3a', Y.next, 'Grade 3', 'A')
  await klass('bOther', Y.now, 'Grade 3', 'A', fx.branchB)
  for (const [key, cls] of [
    ['promoteA', 'g3a'],
    ['promoteB', 'g3b'],
    ['hold', 'g3a'],
    ['grad', 'g6a'],
    ['leave', 'g3a'],
    ['planned', 'g3a'],
    ['otherBranch', 'bOther'],
  ] as const) {
    await student(key, cls)
  }
  // Already given a place individually (2.4) before the year-end run.
  await post(`/students/${S.planned}/enrollments`, { classId: C.n4a, pending: true })
})
after(async () => {
  await fx.close()
})

describe('proposal', () => {
  test('suggests the next grade, same section when there is one; skips the already placed', async () => {
    const res = await call(fx.app, fx.tokens.admin, 'GET', `/enrollments/rollover?${new URLSearchParams(years())}`)
    assert.equal(res.status, 200, res.error)
    const rows = new Map((res.body as Proposal).rows.map((r) => [r.studentId, r]))
    assert.equal(rows.get(S.promoteB!)?.suggested.toClassId, C.n4b, 'section B → Grade 4 B')
    assert.equal(rows.get(S.promoteA!)?.suggested.toClassId, C.n4a, 'section A → Grade 4 A')
    assert.equal(rows.get(S.grad!)?.suggested.toClassId, null, 'no Grade 7 class')
    assert.ok(rows.get(S.planned!)?.existing, 'already has a place next year')
    assert.ok(!rows.has(S.otherBranch!), 'another branch is not in this run')
  })
})

describe('class names', () => {
  test('repeat across years, never within one', async () => {
    const body = { branchId: fx.branchA, gradeLevel: 'Grade 5', name: 'C', capacity: 20 }
    assert.equal((await post('/classes', { ...body, academicYearId: Y.now })).status, 201)
    assert.equal((await post('/classes', { ...body, academicYearId: Y.next })).status, 201)
    assert.equal((await post('/classes', { ...body, academicYearId: Y.next })).error, 'CLASS_EXISTS')
  })
})

describe('preview and commit', () => {
  const good = () => [
    { studentId: S.promoteA!, action: 'promote', toClassId: C.n4a },
    { studentId: S.promoteB!, action: 'promote', toClassId: C.n4b },
    { studentId: S.hold!, action: 'hold', toClassId: C.n3a },
    { studentId: S.grad!, action: 'graduate' },
    { studentId: S.leave!, action: 'withdraw', reasonCode: 'relocation' },
  ]

  test('preview flags every bad row and writes nothing', async () => {
    const res = await post('/enrollments/rollover/preview', {
      ...years(),
      rows: [
        { studentId: S.promoteA, action: 'promote' },
        { studentId: S.hold, action: 'hold', toClassId: C.n4a },
        { studentId: S.leave, action: 'withdraw' },
        { studentId: S.planned, action: 'promote', toClassId: C.n4b },
        { studentId: S.otherBranch, action: 'promote', toClassId: C.n4a },
      ],
    })
    const body = res.body as { ok: boolean; rows: { error?: string }[] }
    assert.equal(body.ok, false)
    assert.deepEqual(
      body.rows.map((r) => r.error),
      ['CLASS_REQUIRED', 'HOLD_SAME_GRADE', 'REASON_REQUIRED', 'YEAR_TAKEN', 'NOT_IN_YEAR'],
    )
    assert.equal((await enrollmentsOf('promoteA')).length, 1)
    const ok = await post('/enrollments/rollover/preview', { ...years(), rows: good() })
    assert.equal((ok.body as { ok: boolean }).ok, true)
  })

  test('one bad row stops the whole commit', async () => {
    const res = await post('/enrollments/rollover/commit', {
      ...years(),
      rows: [...good(), { studentId: S.planned, action: 'promote', toClassId: C.n4b }],
    })
    assert.equal(res.error, 'ROWS_INVALID')
    assert.equal((await enrollmentsOf('promoteA')).length, 1)
    assert.equal((await enrollmentsOf('grad'))[0]?.status, 'active')
  })

  test('a clean commit plans places, graduates and withdraws', async () => {
    const res = await post('/enrollments/rollover/commit', { ...years(), rows: good() })
    assert.equal(res.status, 200, res.error)
    assert.deepEqual((res.body as { summary: unknown }).summary, { promote: 2, hold: 1, graduate: 1, withdraw: 1 })
    const a = await enrollmentsOf('promoteA')
    assert.deepEqual(a.map((e) => e.status), ['active', 'pending'])
    assert.equal(a[1]?.startDate, '2027-08-15', 'defaults to the new year start')
    const grad = await enrollmentsOf('grad')
    assert.equal(grad[0]?.status, 'graduated')
    assert.equal(grad[0]?.endDate, '2027-06-30', 'closes at the old year end')
    assert.equal((await enrollmentsOf('leave'))[0]?.reasonCode, 'relocation')
  })
})

describe('starting the new year', () => {
  test('every planned place starts; old enrollments complete the day before', async () => {
    const res = await post('/enrollments/rollover/start', { branchId: fx.branchA, toYearId: Y.next })
    assert.equal(res.status, 200, res.error)
    assert.equal((res.body as { started: number }).started, 4, 'three from the run plus the one planned before')
    const a = await enrollmentsOf('promoteA')
    assert.deepEqual(a.map((e) => [e.status, e.endDate]), [
      ['completed', '2027-08-14'],
      ['active', null],
    ])
    const cached = await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: S.hold }))
    assert.equal(cached?.classId, C.n3a)
    assert.equal(cached?.academicYearId, Y.next)
    const grad = await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: S.grad }))
    assert.equal(grad?.status, 'graduated', 'graduates are left alone')
    // Nothing left to start.
    assert.equal(((await post('/enrollments/rollover/start', { branchId: fx.branchA, toYearId: Y.next })).body as { started: number }).started, 0)
  })

  test('needs enrollments.assign and the branch', async () => {
    const q = `/enrollments/rollover?${new URLSearchParams({ ...years(), branchId: fx.branchB })}`
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'GET', q)).error, 'FORBIDDEN')
    assert.equal((await post('/enrollments/rollover/start', { branchId: fx.branchA, toYearId: Y.next }, fx.tokens.scheduler)).error, 'FORBIDDEN')
  })
})
