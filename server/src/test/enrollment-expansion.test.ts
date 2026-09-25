// SAMS 2.4: pending (planned) enrollments, activation and cancellation,
// re-enrollment as a new row, withdrawal reason codes, one open enrollment
// per student per academic year, and branch isolation on history.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import { call, createFixture, type Fixture } from './harness.js'

let fx: Fixture
const years = { now: '', next: '' }
const classes = { nowA: '', nowA2: '', nextA: '', nowB: '' }

type Row = { id: string; status: string; academicYearId: string; classId: string; reasonCode: string | null }

async function klass(branchId: string, academicYearId: string, name: string, gradeLevel = 'Grade 3'): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await withTenant(fx.tenantId, (ctx) =>
    ctx.classes.insertOne({
      _id: id,
      branchId,
      gradeLevel,
      name,
      capacity: 30,
      homeroomTeacherId: null,
      academicYearId,
      active: true,
      createdAt: now,
      updatedAt: now,
    }),
  )
  return id
}

/** A student created through the API, so they get a real first enrollment. */
async function student(classId = classes.nowA): Promise<string> {
  const res = await call(fx.app, fx.tokens.admin, 'POST', '/students', {
    studentNumber: `E-${randomUUID().slice(0, 8)}`,
    givenName: 'Enrol',
    familyName: 'Ment',
    classId,
  })
  assert.equal(res.status, 201, res.error)
  return (res.body as { id: string }).id
}

const history = async (id: string, token = fx.tokens.viewer) =>
  (await call(fx.app, token, 'GET', `/students/${id}/enrollments`)).body as { enrollments: Row[] }

const open = (id: string, classId: string, pending: boolean, token = fx.tokens.admin) =>
  call(fx.app, token, 'POST', `/students/${id}/enrollments`, { classId, pending })

const withdraw = (id: string, body: Record<string, unknown>) =>
  call(fx.app, fx.tokens.admin, 'POST', `/students/${id}/withdraw`, { status: 'withdrawn', ...body })

before(async () => {
  fx = await createFixture()
  years.now = randomUUID()
  years.next = randomUUID()
  await withTenant(fx.tenantId, async (ctx) => {
    for (const [id, name, start, current] of [
      [years.now, '2026–2027', '2026-08-01', true],
      [years.next, '2027–2028', '2027-08-01', false],
    ] as const) {
      await ctx.academicYears.insertOne({
        _id: id,
        name,
        startDate: start,
        endDate: `${Number(start.slice(0, 4)) + 1}-07-31`,
        terms: [],
        current,
        createdAt: new Date(),
      })
    }
  })
  classes.nowA = await klass(fx.branchA, years.now, 'A')
  classes.nowA2 = await klass(fx.branchA, years.now, 'B')
  classes.nextA = await klass(fx.branchA, years.next, 'A', 'Grade 4')
  classes.nowB = await klass(fx.branchB, years.now, 'A')
})
after(async () => {
  await fx.close()
})

describe('planned (pending) enrollments', () => {
  test('next year can be planned while this year is active; the student stays put', async () => {
    const s = await student()
    const planned = await open(s, classes.nextA, true)
    assert.equal(planned.status, 201, planned.error)
    const rows = (await history(s)).enrollments
    assert.deepEqual(rows.map((r) => r.status).sort(), ['active', 'pending'])
    const cached = await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: s }))
    assert.equal(cached?.classId, classes.nowA, 'the pending place does not move the student')
  })

  test('one open enrollment per student per academic year', async () => {
    const s = await student()
    assert.equal((await open(s, classes.nowA2, true)).error, 'YEAR_TAKEN', 'this year already has the active row')
    assert.equal((await open(s, classes.nextA, true)).status, 201)
    assert.equal((await open(s, classes.nextA, true)).error, 'YEAR_TAKEN')
  })

  test('the database refuses a second open row in a year even if the check is bypassed', async () => {
    const s = await student()
    await assert.rejects(
      withTenant(fx.tenantId, (ctx) =>
        ctx.enrollments.insertOne({
          _id: randomUUID(),
          studentId: s,
          branchId: fx.branchA,
          classId: classes.nowA2,
          academicYearId: years.now,
          startDate: '2026-09-01',
          endDate: null,
          status: 'pending',
          supersededBy: null,
          reason: null,
          createdAt: new Date(),
          createdBy: null,
          updatedAt: new Date(),
        }),
      ),
      /E11000/,
    )
  })

  test('activating needs the current year closed first; then the student moves', async () => {
    const s = await student()
    const pending = ((await open(s, classes.nextA, true)).body as { enrollment: Row }).enrollment
    const url = `/enrollments/${pending.id}/activate`
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, {})).error, 'ALREADY_ENROLLED')
    await call(fx.app, fx.tokens.admin, 'POST', `/students/${s}/withdraw`, { status: 'graduated' })
    const activated = await call(fx.app, fx.tokens.admin, 'POST', url, { startDate: '2027-08-20' })
    assert.equal(activated.status, 200, activated.error)
    const cached = await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: s }))
    assert.equal(cached?.classId, classes.nextA)
    assert.equal(cached?.academicYearId, years.next)
    assert.equal(cached?.status, 'enrolled')
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, {})).error, 'NOT_PENDING')
  })

  test('cancelling needs a reason and keeps the row', async () => {
    const s = await student()
    const pending = ((await open(s, classes.nextA, true)).body as { enrollment: Row }).enrollment
    const url = `/enrollments/${pending.id}/cancel`
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, {})).error, 'REASON_REQUIRED')
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, { reason: 'Family moving abroad' })).status, 200)
    const rows = (await history(s)).enrollments
    assert.equal(rows.find((r) => r.id === pending.id)?.status, 'cancelled')
    // The year is free again.
    assert.equal((await open(s, classes.nextA, true)).status, 201)
  })
})

describe('re-enrollment', () => {
  test('a withdrawn student comes back as a new row; the old one is untouched', async () => {
    const s = await student()
    assert.equal((await open(s, classes.nowA2, false)).error, 'ALREADY_ENROLLED', 'an active student is transferred, not re-enrolled')
    await withdraw(s, { reasonCode: 'relocation' })
    // A withdrawn row no longer holds the year, so they can come back this year.
    assert.equal((await open(s, classes.nowA2, false)).status, 201)
    const rows = (await history(s)).enrollments
    assert.equal(rows.length, 2)
    const old = rows.find((r) => r.status === 'withdrawn')!
    assert.equal(old.reasonCode, 'relocation')
    assert.equal(rows.find((r) => r.status === 'active')?.classId, classes.nowA2)
    const cached = await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: s }))
    assert.equal(cached?.status, 'enrolled')
  })
})

describe('withdrawal reasons', () => {
  test('a code from the list, or a note alone (recorded as "other"); nothing at all is refused', async () => {
    assert.equal((await withdraw(await student(), {})).error, 'REASON_REQUIRED')
    assert.equal((await withdraw(await student(), { reasonCode: 'dragons' })).error, 'INVALID_REASON_CODE')
    const noteOnly = await withdraw(await student(), { reason: 'Parents asked by phone' })
    assert.equal((noteOnly.body as { enrollment: Row }).enrollment.reasonCode, 'other')
    const list = await call(fx.app, fx.tokens.viewer, 'GET', '/settings/lookups/withdrawalReason')
    assert.ok((list.body as { items: { code: string }[] }).items.some((i) => i.code === 'financial'))
  })
})

describe('permissions and branches', () => {
  test('history is branch-isolated; planning needs enrollments.assign and both branches', async () => {
    const inB = await student(classes.nowB)
    assert.equal((await call(fx.app, fx.scopedToken, 'GET', `/students/${inB}/enrollments`)).error, 'BRANCH_FORBIDDEN')
    const inA = await student()
    assert.equal((await open(inA, classes.nextA, true, fx.tokens.scheduler)).error, 'FORBIDDEN')
    assert.equal((await open(inA, classes.nextA, true, fx.scopedToken)).error, 'FORBIDDEN')
  })
})
