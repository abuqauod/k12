// SAMS 2.5: admissions — applications, the document checklist, decisions
// through the approval engine, withdrawal, and conversion into a student,
// parents and a planned enrollment.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { withTenant } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'

let fx: Fixture
let decider: string
let registrar: string
let year = ''
let classA = ''
let classB = ''

type App = {
  id: string
  applicationNumber: string
  status: string
  checklist: { category: string; status: string }[]
  convertedStudentId: string | null
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

const newApp = (overrides: Record<string, unknown> = {}) => ({
  branchId: fx.branchA,
  academicYearId: year,
  gradeLevel: 'Grade 1',
  applicant: { givenName: 'Lina', familyName: 'Haddad', dob: '2020-04-02', gender: 'female' },
  guardians: [{ fullName: 'Rami Haddad', relationship: 'father', phone: '0791231234', email: 'rami@example.test', primaryContact: true }],
  requiredDocuments: ['birth_certificate', 'photo'],
  ...overrides,
})

async function create(overrides: Record<string, unknown> = {}, token = registrar): Promise<App> {
  const res = await call(fx.app, token, 'POST', '/admissions/applications', newApp(overrides))
  assert.equal(res.status, 201, res.error)
  return res.body as App
}

const get = async (id: string, token = registrar) =>
  (await call(fx.app, token, 'GET', `/admissions/applications/${id}`)).body as App

const act = (id: string, action: string, body: unknown = {}, token = registrar) =>
  call(fx.app, token, 'POST', `/admissions/applications/${id}/${action}`, body)

async function upload(appId: string, category: string) {
  const res = await fx.app.inject({
    method: 'POST',
    url: `${config.routePrefix}/documents?ownerType=application&ownerId=${appId}&category=${category}&fileName=f.png`,
    // A scheduler: admissions.manage covers an applicant's documents
    // (documents.upload is needed for students' and parents').
    headers: { authorization: `Bearer ${fx.tokens.scheduler}`, 'content-type': 'application/octet-stream' },
    payload: PNG,
  })
  assert.equal(res.statusCode, 201, res.body)
}

/** Proposes a decision (registrar) and has someone else approve it. */
async function decide(id: string, outcome: string) {
  const req = await call(fx.app, registrar, 'POST', '/approvals', {
    type: 'admissions.decision',
    entityId: id,
    payload: { outcome, note: 'Interview went well' },
  })
  if (req.status !== 201) return req
  return call(fx.app, decider, 'POST', `/approvals/${(req.body as { id: string }).id}/approve`, {})
}

/** An application taken as far as "accepted". */
async function accepted(overrides: Record<string, unknown> = {}): Promise<App> {
  const app = await create(overrides)
  await upload(app.id, 'birth_certificate')
  await upload(app.id, 'photo')
  assert.equal((await act(app.id, 'submit')).status, 200)
  assert.equal((await act(app.id, 'review')).status, 200)
  const decided = await decide(app.id, 'accepted')
  assert.equal(decided.status, 200, decided.error)
  return app
}

before(async () => {
  fx = await createFixture()
  decider = (await member(fx.tenantId, 'viewer', null, 'school_admin')).token
  registrar = (await member(fx.tenantId, 'viewer', null, 'registrar')).token
  year = randomUUID()
  await withTenant(fx.tenantId, async (ctx) => {
    await ctx.academicYears.insertOne({
      _id: year,
      name: '2027–2028',
      startDate: '2027-08-01',
      endDate: '2028-07-31',
      terms: [],
      current: false,
      createdAt: new Date(),
    })
    for (const [branchId, name] of [
      [fx.branchA, 'A'],
      [fx.branchB, 'B'],
    ] as const) {
      const id = randomUUID()
      if (branchId === fx.branchA) classA = id
      else classB = id
      await ctx.classes.insertOne({
        _id: id,
        branchId,
        gradeLevel: 'Grade 1',
        name,
        capacity: 25,
        homeroomTeacherId: null,
        academicYearId: year,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }
  })
})
after(async () => {
  await fx.close()
})

describe('applications', () => {
  test('are numbered, start as drafts, and show the document checklist', async () => {
    const a = await create()
    const b = await create()
    assert.match(a.applicationNumber, /^APP-\d{6}$/)
    assert.notEqual(a.applicationNumber, b.applicationNumber)
    assert.equal(a.status, 'draft')
    const detail = await get(a.id)
    assert.deepEqual(
      detail.checklist.map((c) => [c.category, c.status]),
      [
        ['birth_certificate', 'missing'],
        ['photo', 'missing'],
      ],
    )
  })

  test('are personal data: viewers cannot read them, and branches are isolated', async () => {
    const inB = await create({ branchId: fx.branchB })
    assert.equal((await call(fx.app, fx.tokens.viewer, 'GET', '/admissions/applications')).error, 'FORBIDDEN')
    assert.equal((await get(inB.id, fx.scopedToken) as unknown as { error: string }).error, 'BRANCH_FORBIDDEN')
    const listed = (await call(fx.app, fx.scopedToken, 'GET', '/admissions/applications')).body as { applications: App[] }
    assert.ok(!listed.applications.some((x) => x.id === inB.id))
  })

  test('refuse unknown checklist categories and admission sources', async () => {
    const bad = await call(fx.app, registrar, 'POST', '/admissions/applications', newApp({ requiredDocuments: ['nope'] }))
    assert.equal(bad.error, 'INVALID_DOCUMENT_CATEGORY')
    const src = await call(fx.app, registrar, 'POST', '/admissions/applications', newApp({ source: 'carrier_pigeon' }))
    assert.equal(src.error, 'INVALID_SOURCE')
  })
})

describe('decisions', () => {
  test('need the review step and, to accept, a complete checklist', async () => {
    const app = await create()
    assert.equal((await decide(app.id, 'accepted')).error, 'NOT_UNDER_REVIEW')
    await act(app.id, 'submit')
    await act(app.id, 'review')
    assert.equal((await decide(app.id, 'accepted')).error, 'CHECKLIST_INCOMPLETE')
    await upload(app.id, 'birth_certificate')
    await upload(app.id, 'photo')
    assert.equal((await decide(app.id, 'accepted')).status, 200)
    assert.equal((await get(app.id)).status, 'accepted')
  })

  test('the proposer never decides their own proposal', async () => {
    const app = await create()
    await act(app.id, 'submit')
    await act(app.id, 'review')
    const req = await call(fx.app, decider, 'POST', '/approvals', {
      type: 'admissions.decision',
      entityId: app.id,
      payload: { outcome: 'rejected' },
    })
    const id = (req.body as { id: string }).id
    assert.equal((await call(fx.app, decider, 'POST', `/approvals/${id}/approve`, {})).error, 'SELF_DECISION')
  })

  test('waitlisted applications go back to review, then can be decided again', async () => {
    const app = await create()
    await act(app.id, 'submit')
    await act(app.id, 'review')
    assert.equal((await decide(app.id, 'waitlisted')).status, 200)
    assert.equal((await act(app.id, 'review')).status, 200)
    assert.equal((await decide(app.id, 'rejected')).status, 200)
    assert.equal((await get(app.id)).status, 'rejected')
    assert.equal((await act(app.id, 'withdraw', { reason: 'Too late' })).error, 'WRONG_STATUS')
  })

  test('a withdrawn application cancels its open decision request', async () => {
    const app = await create()
    await act(app.id, 'submit')
    await act(app.id, 'review')
    const req = await call(fx.app, registrar, 'POST', '/approvals', {
      type: 'admissions.decision',
      entityId: app.id,
      payload: { outcome: 'rejected' },
    })
    assert.equal((await act(app.id, 'withdraw', {})).error, 'REASON_REQUIRED')
    assert.equal((await act(app.id, 'withdraw', { reason: 'Family chose another school' })).status, 200)
    const status = await withTenant(fx.tenantId, (ctx) =>
      ctx.approvalRequests.findOne({ _id: (req.body as { id: string }).id }),
    )
    assert.equal(status?.status, 'cancelled')
  })

  test('submitting needs at least one guardian', async () => {
    const app = await create({ guardians: [] })
    assert.equal((await act(app.id, 'submit')).error, 'GUARDIAN_REQUIRED')
  })
})

describe('conversion', () => {
  test('creates the student, parents and a planned enrollment, and moves the documents', async () => {
    // A sibling's parent is already on file with the same phone in another format.
    const existing = await call(fx.app, fx.tokens.admin, 'POST', '/parents', { fullName: 'Rami H.', primaryPhone: '+962 79 123 1234' })
    const existingId = (existing.body as { parent: { id: string } }).parent.id
    const app = await accepted({
      guardians: [
        { fullName: 'Rami Haddad', relationship: 'father', phone: '0791231234', primaryContact: true },
        { fullName: 'Maya Haddad', relationship: 'mother', phone: '0795556677', email: 'maya@example.test', preferredLanguage: 'ar' },
      ],
    })
    assert.equal((await act(app.id, 'convert', { classId: classB, studentNumber: 'S-9001', startDate: '2027-08-20' })).error, 'CLASS_WRONG_BRANCH')

    const res = await act(app.id, 'convert', { classId: classA, studentNumber: 'S-9001', startDate: '2027-08-20' })
    assert.equal(res.status, 201, res.error)
    const { studentId, parentIds } = res.body as { studentId: string; parentIds: string[] }

    const state = await withTenant(fx.tenantId, async (ctx) => ({
      student: await ctx.students.findOne({ _id: studentId }),
      enrollments: await ctx.enrollments.find({ studentId }).toArray(),
      links: await ctx.parentStudentLinks.find({ studentId }).toArray(),
      docs: await ctx.documents.find({ ownerId: studentId }).toArray(),
      appDocs: await ctx.documents.countDocuments({ ownerType: 'application', ownerId: app.id }),
      maya: await ctx.parents.findOne({ _id: parentIds[1] }),
    }))
    assert.equal(state.student?.givenName, 'Lina')
    assert.equal(state.student?.status, 'inquiry')
    assert.equal(state.student?.classId, classA)
    assert.deepEqual(state.enrollments.map((e) => e.status), ['pending'])
    assert.equal(parentIds[0], existingId, 'the parent on file was reused by phone')
    assert.equal(state.maya?.preferredLanguage, 'ar')
    assert.equal(state.links.length, 2)
    assert.equal(state.docs.length, 2)
    assert.equal(state.appDocs, 0)

    const after = await get(app.id)
    assert.equal(after.status, 'converted')
    assert.equal(after.convertedStudentId, studentId)
    assert.equal((await act(app.id, 'convert', { classId: classA, studentNumber: 'S-9002', startDate: '2027-08-20' })).error, 'NOT_ACCEPTED')

    // Starting the planned place enrolls the student.
    const started = await call(fx.app, fx.tokens.admin, 'POST', `/enrollments/${state.enrollments[0]!._id}/activate`, {})
    assert.equal(started.status, 200, started.error)
    const enrolled = await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: studentId }))
    assert.equal(enrolled?.status, 'enrolled')
  })

  test('a taken student number rolls the whole conversion back', async () => {
    const app = await accepted()
    const first = await act(app.id, 'convert', { classId: classA, studentNumber: 'S-9001', startDate: '2027-08-20' })
    assert.equal(first.error, 'STUDENT_NUMBER_TAKEN')
    assert.equal((await get(app.id)).status, 'accepted')
    const docs = await withTenant(fx.tenantId, (ctx) => ctx.documents.countDocuments({ ownerType: 'application', ownerId: app.id }))
    assert.equal(docs, 2)
  })
})
