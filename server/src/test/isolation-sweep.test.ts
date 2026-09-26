// SAMS 9.2: a sweep over every read route in the permission matrix. Records
// are made in branch B of one school, each carrying a marker in its name;
// then every GET route is called by (1) an admin confined to branch A, and
// (2) the owner of a second school — with the branch-B ids substituted into
// the route's parameters and passed as filters. Neither may ever get a
// response that contains a marker or a branch-B record id.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { signAccessToken } from '../auth/tokens.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture } from './finance-fixture.js'
import { PORTAL_ROUTES, ROUTES, X } from './routeMatrix.js'

const MARK = 'Qzleakb'
let fx: Fixture
let other: Fixture
/** A portal login of a different family (a branch-A child). */
let otherParent = ''
/** Ids of branch-B records, which may appear in no response below. */
const secretIds: string[] = []
/** More ids to put into routes' parameters (the sensitive-data records). */
const probeIds: string[] = []

const idOf = (res: { status: number; error?: string; body: unknown }, what: string): string => {
  assert.ok(res.status === 200 || res.status === 201, `${what}: ${res.status} ${res.error}`)
  const body = res.body as Record<string, unknown>
  const id = (body.id ?? (body.parent as { id?: string } | undefined)?.id ?? (body.student as { id?: string } | undefined)?.id) as string
  assert.ok(id, `${what}: no id`)
  return id
}

before(async () => {
  fx = await createFixture()
  other = await createFixture()
  const fin = await financeFixture(fx)
  const owner = fx.tokens.owner
  const B = fx.branchB
  const post = async (path: string, body: unknown) => idOf(await call(fx.app, owner, 'POST', path, body), path)

  // A student of branch B with a family, an invoice and a payment.
  const student = await fin.student(B)
  await call(fx.app, owner, 'PATCH', `/students/${student}`, { givenName: MARK, familyName: MARK })
  const parent = await post('/parents', { fullName: `${MARK} Parent`, primaryPhone: '0795550009', email: `${MARK.toLowerCase()}@example.test` })
  idOf(await call(fx.app, owner, 'POST', `/parents/${parent}/links`, { studentId: student, relationshipType: 'father' }), 'link')
  const invoice = await fin.invoice({ branchId: B, studentId: student })
  await fin.pay(invoice.id, 500, { payerName: `${MARK} Payer` })
  // Staff, wellbeing, operations and admissions records in branch B.
  const employee = await post('/hr/employees', { branchId: B, givenName: MARK, familyName: MARK, hireDate: '2025-01-01' })
  const visit = await post('/clinic/visits', { studentId: student, complaint: `${MARK} complaint`, outcome: 'rested' })
  const incident = await post('/discipline/incidents', {
    studentIds: [student],
    typeCode: 'fighting',
    severity: 'minor',
    description: `${MARK} incident`,
  })
  const asset = await post('/ops/assets', { name: `${MARK} Projector`, categoryCode: 'it', branchId: B })
  const maintenance = await post('/ops/maintenance', { branchId: B, assetId: asset, title: `${MARK} leak`, priority: 'high' })
  const application = await post('/admissions/applications', {
    branchId: B,
    academicYearId: fin.yearId,
    gradeLevel: 'Grade 1',
    applicant: { givenName: MARK, familyName: MARK, dob: '2020-04-02', gender: 'female' },
    guardians: [{ fullName: `${MARK} Guardian`, relationship: 'father', phone: '0791231299', primaryContact: true }],
    requiredDocuments: [],
  })
  await call(fx.app, owner, 'PUT', `/students/${student}/health`, {
    bloodType: 'O+',
    allergies: [{ name: `${MARK} peanuts`, severity: 'severe', alert: true }],
  })
  secretIds.push(student, parent, invoice.id, employee, visit, incident, asset, maintenance, application)

  // The same school's class, fee structure and year are shared by design
  // (tenant-wide or branch A too); only branch-B records count as secret.
  const receipts = await withTenant(fx.tenantId, (ctx) => ctx.receipts.find({ studentId: student }).toArray())
  secretIds.push(...receipts.map((r) => r._id))

  // Another family, in branch A, with the parent portal switched on.
  const childA = await fin.student(fx.branchA)
  const parentA = await post('/parents', { fullName: 'Other Family', primaryPhone: '0795550010', email: 'other-family@example.test' })
  idOf(
    await call(fx.app, owner, 'POST', `/parents/${parentA}/links`, { studentId: childA, relationshipType: 'mother', portalAccess: true }),
    'link A',
  )
  const enabled = await call(fx.app, owner, 'POST', `/parents/${parentA}/portal/enable`, {})
  assert.equal(enabled.status, 200, enabled.error)
  const doc = await withTenant(fx.tenantId, (ctx) => ctx.parents.findOne({ _id: parentA }))
  otherParent = await signAccessToken({ sub: doc!.portalAccess.userId!, email: doc!.email!, tenantId: fx.tenantId, role: 'viewer' })
})
after(async () => {
  await other.app.close()
  await fx.close()
})

/** GET paths to try: the matrix rows with X replaced by each secret id, plus
 * the list routes with branch/student filters pointing at branch B. */
function probes(): string[] {
  const out = new Set<string>()
  for (const [method, path] of [...ROUTES, ...PORTAL_ROUTES]) {
    if (method !== 'GET') continue
    if (path.includes(X)) {
      for (const id of [...secretIds, ...probeIds]) out.add(path.split(X).join(id))
    } else {
      const sep = path.includes('?') ? '&' : '?'
      out.add(path)
      out.add(`${path}${sep}branchId=${fx.branchB}`)
      out.add(`${path}${sep}studentId=${secretIds[0]}&q=${MARK}`)
    }
  }
  // Every catalog report and the search, filtered to branch B.
  for (const key of [
    'students.roster', 'students.enrollment', 'students.movements', 'attendance.students', 'attendance.classes',
    'admissions.byGrade', 'finance.outstanding', 'finance.payments', 'finance.billing', 'finance.expenses',
    'hr.staff', 'hr.leave', 'ops.maintenance', 'ops.library', 'health.visits', 'discipline.incidents',
  ]) {
    out.add(`/reports/${key}?branchId=${fx.branchB}&from=2020-01-01&to=2030-12-31`)
    out.add(`/reports/${key}/export?format=csv&branchId=${fx.branchB}&from=2020-01-01&to=2030-12-31`)
  }
  out.add(`/search?q=${MARK}`)
  return [...out]
}

async function sweep(app: Fixture['app'], token: string, who: string, markers = [MARK], ids = secretIds) {
  const leaks: string[] = []
  for (const path of probes()) {
    const res = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } })
    const text = res.body
    const found = markers.find((m) => text.includes(m)) ?? ids.find((id) => text.includes(id))
    if (found && res.statusCode < 400) leaks.push(`${who}: GET ${path} → ${res.statusCode} contains ${found}`)
  }
  return leaks
}

test('the records exist and the unconfined owner sees them (the sweep can detect a leak)', async () => {
  const res = await call(fx.app, fx.tokens.owner, 'GET', `/search?q=${MARK}`)
  assert.ok(JSON.stringify(res.body).includes(MARK), 'the owner should find the marker')
})

test('an admin confined to branch A sees nothing of branch B on any read route', async () => {
  const { token } = await member(fx.tenantId, 'admin', [fx.branchA])
  const leaks = await sweep(fx.app, token, 'branch-A admin')
  assert.deepEqual(leaks, [])
})

test('the owner of another school sees nothing of this one on any read route', async () => {
  const leaks = await sweep(other.app, other.tokens.owner, 'other school owner')
  assert.deepEqual(leaks, [])
})


test('a parent portal login of another family sees nothing of this one', async () => {
  // The login works: it sees its own family.
  const me = await call(fx.app, otherParent, 'GET', '/portal/me')
  assert.equal(me.status, 200, me.error)
  assert.ok(JSON.stringify(me.body).includes('Other Family'))
  const leaks = await sweep(fx.app, otherParent, 'other family')
  assert.deepEqual(leaks, [])
})

// SAMS 9.4: sensitive data stays with the roles meant to see it, whatever
// route asks — lists, profiles, reports, exports, search, the audit log.
describe('sensitive data', () => {
  const MED = 'Qzmedsecret'
  const INC = 'Qzincsecret'
  // 98,765.43 a month: no other number in the fixture looks like it.
  const SALARY = ['9876543', '98765.43', '98,765.43']
  let incidentId = ''

  before(async () => {
    const owner = fx.tokens.owner
    const student = (await call(fx.app, owner, 'GET', '/students?branchId=' + fx.branchA)).body as { students: { id: string }[] }
    const child = student.students[0]!.id
    const health = await call(fx.app, owner, 'PUT', `/students/${child}/health`, {
      bloodType: 'A+',
      allergies: [{ name: 'Pollen', severity: 'mild', alert: true }],
      conditions: [{ name: `${MED} condition`, notes: `${MED} notes`, alert: false }],
      medications: [{ name: `${MED} tablets`, dose: '5mg', schedule: 'daily', atSchool: false }],
    })
    assert.equal(health.status, 200, health.error)
    const inc = await call(fx.app, owner, 'POST', '/discipline/incidents', {
      studentIds: [child],
      typeCode: 'fighting',
      severity: 'minor',
      description: `${INC} description`,
    })
    incidentId = idOf(inc, 'incident')
    const emp = await call(fx.app, owner, 'POST', '/hr/employees', {
      branchId: fx.branchA,
      givenName: 'Paid',
      familyName: 'Well',
      hireDate: '2025-01-01',
      contract: { typeCode: 'permanent', startDate: '2025-01-01', endDate: null, salary: 9876543 },
    })
    probeIds.push(child, incidentId, idOf(emp, 'employee'))
  })

  const cases: [string, 'viewer' | 'scheduler' | null, Parameters<typeof member>[3], string[]][] = [
    ['viewer', 'viewer', null, [MED, INC, ...SALARY]],
    ['scheduler (logs incidents, sees only their own)', 'scheduler', null, [MED, INC, ...SALARY]],
    ['registrar', null, 'registrar', [MED, ...SALARY]],
    ['finance officer', null, 'finance_officer', [MED, INC, ...SALARY]],
    ['operations', null, 'operations', [MED, INC, ...SALARY]],
    ['nurse', null, 'nurse', [INC, ...SALARY]],
  ]
  for (const [who, role, preset, markers] of cases) {
    test(`${who} never receives what is not theirs to see`, async () => {
      const { token } = await member(fx.tenantId, role ?? 'viewer', null, preset)
      const leaks = await sweep(fx.app, token, who, markers, [incidentId].filter(() => markers.includes(INC)))
      assert.deepEqual(leaks, [])
    })
  }

  test('the roles meant to see them do (the sweep can detect each)', async () => {
    const nurse = (await member(fx.tenantId, 'viewer', null, 'nurse')).token
    const hr = (await member(fx.tenantId, 'viewer', null, 'hr')).token
    const registrar = (await member(fx.tenantId, 'viewer', null, 'registrar')).token
    assert.ok((await sweep(fx.app, nurse, 'nurse', [MED], [])).length > 0)
    assert.ok((await sweep(fx.app, hr, 'hr', SALARY, [])).length > 0)
    assert.ok((await sweep(fx.app, registrar, 'registrar', [INC], [])).length > 0)
  })
})
