// Backlog: health/clinic and behaviour incidents — who sees what, the
// family notices, and the catalog reports on top of them.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
let nurse: string
let nurseB: string
let registrar: string
let studentA = ''
let studentA2 = ''
let studentB = ''

const post = (path: string, body: unknown, token = fx.tokens.admin) => call(fx.app, token, 'POST', path, body)
const get = (path: string, token = fx.tokens.admin) => call(fx.app, token, 'GET', path)

async function family(studentId: string) {
  const parent = await post('/parents', { fullName: 'Huda Parent', primaryPhone: '0791234567', email: `p-${studentId.slice(0, 8)}@family.test` })
  assert.equal(parent.status, 201, parent.error)
  const parentId = (parent.body as { parent: { id: string } }).parent.id
  const link = await post(`/parents/${parentId}/links`, {
    studentId,
    relationshipType: 'Mother',
    primaryContact: true,
    communicationPermissions: { email: true, sms: false },
  })
  assert.equal(link.status, 201, link.error)
}

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
  nurse = (await member(fx.tenantId, 'viewer', null, 'nurse')).token
  nurseB = (await member(fx.tenantId, 'viewer', [fx.branchB], 'nurse')).token
  registrar = (await member(fx.tenantId, 'viewer', null, 'registrar')).token
  studentA = await fin.student(fx.branchA)
  studentA2 = await fin.student(fx.branchA)
  studentB = await fin.student(fx.branchB)
  await family(studentA)
})
after(async () => {
  await fx.close()
})

const profile = {
  bloodType: 'O+',
  allergies: [{ name: 'Peanuts', severity: 'severe', reaction: 'Anaphylaxis', notes: 'EpiPen in office', alert: true }],
  conditions: [{ name: 'Asthma', notes: null, alert: false }],
  medications: [{ name: 'Inhaler', dose: '2 puffs', schedule: 'as needed', atSchool: true }],
  doctorName: 'Dr. Saleh',
  doctorPhone: '065000000',
  notes: null,
}

describe('health profile', () => {
  test('nurses keep it; staff who see the student get only the alerts', async () => {
    const saved = await call(fx.app, nurse, 'PUT', `/students/${studentA}/health`, profile)
    assert.equal(saved.status, 200, saved.error)
    const full = (await get(`/students/${studentA}/health`, nurse)).body as { profile: { allergies: { name: string }[]; medications: unknown[] } }
    assert.equal(full.profile.allergies[0]!.name, 'Peanuts')
    // A teacher (scheduler) and the registrar: no medical record…
    assert.equal((await get(`/students/${studentA}/health`, fx.tokens.scheduler)).error, 'FORBIDDEN')
    assert.equal((await get(`/students/${studentA}/health`, registrar)).error, 'FORBIDDEN')
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'PUT', `/students/${studentA}/health`, profile)).error, 'FORBIDDEN')
    // …but the alert, and only the alert (asthma is not marked).
    const alerts = (await get(`/students/${studentA}/alerts`, fx.tokens.viewer)).body as { alerts: { name: string; severity: string }[] }
    assert.deepEqual(alerts.alerts.map((a) => [a.name, a.severity]), [['Peanuts', 'severe']])
  })

  test('stays inside the nurse’s branches, and out of the audit log', async () => {
    assert.equal((await get(`/students/${studentA}/health`, nurseB)).error, 'BRANCH_FORBIDDEN')
    const audit = await withTenant(fx.tenantId, (ctx) => ctx.auditLog.findOne({ entityId: studentA, action: { $in: ['health.create', 'health.update'] } }))
    assert.ok(audit)
    assert.equal(JSON.stringify(audit).includes('Peanuts'), false)
  })

  test('the nurse’s list: alerts and medication taken at school', async () => {
    const list = (await get(`/clinic/alerts?branchId=${fx.branchA}`, nurse)).body as { students: { studentId: string; medicationsAtSchool: unknown[] }[] }
    const row = list.students.find((s) => s.studentId === studentA)!
    assert.equal(row.medicationsAtSchool.length, 1)
    assert.equal(((await get(`/clinic/alerts`, nurseB)).body as { students: unknown[] }).students.length, 0)
  })
})

describe('clinic visits', () => {
  test('sending a child home tells the family; a quick visit does not', async () => {
    const home = await post('/clinic/visits', { studentId: studentA, complaint: 'Fever', temperature: 38.6, treatment: 'Paracetamol', outcome: 'sent_home' }, nurse)
    assert.equal(home.status, 201, home.error)
    assert.ok((home.body as { parentsNotifiedAt: string | null }).parentsNotifiedAt)
    const jobs = await withTenant(fx.tenantId, (ctx) => ctx.notificationJobs.find({ kind: 'clinic_visit', sourceId: (home.body as { id: string }).id }).toArray())
    assert.equal(jobs.length, 1)
    assert.match(jobs[0]!.body, /sent home/)

    const quick = await post('/clinic/visits', { studentId: studentA, complaint: 'Scraped knee', outcome: 'returned_to_class' }, nurse)
    assert.equal((quick.body as { parentsNotifiedAt: string | null }).parentsNotifiedAt, null)
    const asked = await post('/clinic/visits', { studentId: studentA, complaint: 'Headache', outcome: 'rested', notifyParents: true }, nurse)
    assert.ok((asked.body as { parentsNotifiedAt: string | null }).parentsNotifiedAt)
  })

  test('are refused outside the nurse’s branches and for other roles', async () => {
    assert.equal((await post('/clinic/visits', { studentId: studentA, complaint: 'x', outcome: 'rested' }, nurseB)).error, 'BRANCH_FORBIDDEN')
    assert.equal((await post('/clinic/visits', { studentId: studentA, complaint: 'x', outcome: 'rested' }, fx.tokens.scheduler)).error, 'FORBIDDEN')
    const log = (await get(`/clinic/visits?studentId=${studentA}`, nurse)).body as { visits: unknown[] }
    assert.equal(log.visits.length, 3)
  })

  test('the clinic visits report', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const t = (await get(`/reports/health.visits?from=${today}&to=${today}&status=sent_home`, nurse)).body as { rows: { outcome: string; notified: string }[] }
    assert.deepEqual(t.rows.map((r) => [r.outcome, r.notified]), [['Sent home', 'Yes']])
    assert.equal((await get(`/reports/health.visits?from=${today}&to=${today}`, registrar)).error, 'FORBIDDEN')
  })
})

describe('behaviour incidents', () => {
  let incidentId = ''

  test('a teacher logs one and sees only their own', async () => {
    const res = await post(
      '/discipline/incidents',
      { studentIds: [studentA, studentA2], typeCode: 'fighting', severity: 'moderate', description: 'Pushing in the playground', location: 'Playground' },
      fx.scopedToken,
    )
    assert.equal(res.status, 201, res.error)
    const inc = res.body as { id: string; incidentNumber: string; students: unknown[] }
    incidentId = inc.id
    assert.match(inc.incidentNumber, /^INC-\d{6}$/)
    assert.equal(inc.students.length, 2)
    const other = (await member(fx.tenantId, 'scheduler', null)).token
    assert.equal((await get(`/discipline/incidents/${incidentId}`, other)).error, 'NOT_FOUND')
    assert.equal(((await get('/discipline/incidents', other)).body as { incidents: unknown[] }).incidents.length, 0)
    assert.equal(((await get('/discipline/incidents', fx.scopedToken)).body as { incidents: unknown[] }).incidents.length, 1)
  })

  test('refuses students of other branches, mixed branches and unknown types', async () => {
    const base = { typeCode: 'fighting', severity: 'minor', description: 'Something happened' }
    assert.equal((await post('/discipline/incidents', { ...base, studentIds: [studentB] }, fx.scopedToken)).error, 'BRANCH_FORBIDDEN')
    assert.equal((await post('/discipline/incidents', { ...base, studentIds: [studentA, studentB] })).error, 'STUDENTS_IN_DIFFERENT_BRANCHES')
    assert.equal((await post('/discipline/incidents', { ...base, studentIds: [studentA], typeCode: 'nope' })).error, 'INVALID_CATEGORY')
    assert.equal((await post('/discipline/incidents', { ...base, studentIds: [studentA] }, fx.tokens.viewer)).error, 'FORBIDDEN')
  })

  test('a manager records the action, tells the family, and closes it', async () => {
    assert.equal((await post(`/discipline/incidents/${incidentId}/actions`, { studentId: studentA, code: 'detention' }, fx.scopedToken)).error, 'FORBIDDEN')
    const act = await post(`/discipline/incidents/${incidentId}/actions`, { studentId: studentA, code: 'detention', startDate: '2026-10-01', endDate: '2026-10-01' }, registrar)
    assert.equal(act.status, 200, act.error)
    const told = await post(`/discipline/incidents/${incidentId}/notify`, { studentIds: [studentA] }, registrar)
    assert.equal(told.status, 200, told.error)
    assert.equal((told.body as { email: number }).email, 1)
    const job = await withTenant(fx.tenantId, (ctx) => ctx.notificationJobs.findOne({ kind: 'incident' }))
    assert.match(job!.body, /Detention \(2026-10-01 – 2026-10-01\)/)
    // Nothing new to say: telling them again sends nothing.
    assert.equal(((await post(`/discipline/incidents/${incidentId}/notify`, { studentIds: [studentA] }, registrar)).body as { email: number }).email, 0)
    assert.equal((await post(`/discipline/incidents/${incidentId}/status`, { status: 'resolved' }, registrar)).error, 'REASON_REQUIRED')
    const closed = await post(`/discipline/incidents/${incidentId}/status`, { status: 'resolved', resolution: 'Apologised' }, registrar)
    assert.equal((closed.body as { status: string }).status, 'resolved')
    assert.equal((await post(`/discipline/incidents/${incidentId}/actions`, { studentId: studentA, code: 'verbal_warning' }, registrar)).error, 'NOT_OPEN')
  })

  test('the incidents report lists one row per student', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const t = (await get(`/reports/discipline.incidents?from=${today}&to=${today}`, registrar)).body as { rows: { actions: string }[] }
    assert.equal(t.rows.length, 2)
    assert.ok(t.rows.some((r) => r.actions === 'Detention'))
    assert.equal((await get(`/reports/discipline.incidents?from=${today}&to=${today}`, nurse)).error, 'FORBIDDEN')
  })
})
