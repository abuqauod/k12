// SAMS Phase 4: employees, contracts and history (4.1–4.2), staff
// documents (4.3), leave (4.4), staff attendance (4.5), HR reports (4.6).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { withTenant } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'

let fx: Fixture
let hr: string
let hrB: string
let staff: { token: string; userId: string }

type Emp = { id: string; employeeNumber: string; status: string; departmentCode: string | null }
type Contract = { id: string; startDate: string; endDate: string | null; status: string; salary: number | null }
type Balance = { typeCode: string; entitlement: number | null; taken: number; pending: number; available: number | null }

const post = (path: string, body: unknown, token = hr) => call(fx.app, token, 'POST', path, body)
const get = (path: string, token = hr) => call(fx.app, token, 'GET', path)

async function employee(overrides: Record<string, unknown> = {}, token = hr): Promise<Emp> {
  const res = await post(
    '/hr/employees',
    {
      branchId: fx.branchA,
      givenName: 'Nour',
      familyName: 'Staff',
      hireDate: '2025-09-01',
      departmentCode: 'teaching',
      positionCode: 'teacher',
      ...overrides,
    },
    token,
  )
  assert.equal(res.status, 201, res.error)
  return res.body as Emp
}

const contracts = async (id: string) => ((await get(`/hr/employees/${id}/contracts`)).body as { contracts: Contract[] }).contracts
const leave = async (id: string, year = 2026) =>
  (await get(`/hr/employees/${id}/leave?year=${year}`)).body as { balances: Balance[]; requests: { id: string; status: string; days: number }[] }
const annual = async (id: string) => (await leave(id)).balances.find((b) => b.typeCode === 'annual')!
const askLeave = (employeeId: string, startDate: string, endDate: string, token = hr, typeCode = 'annual') =>
  post('/hr/leave-requests', { employeeId, typeCode, startDate, endDate, reason: 'Family visit' }, token)
const approve = (approvalId: string, token = fx.tokens.admin) => post(`/approvals/${approvalId}/approve`, {}, token)

before(async () => {
  fx = await createFixture()
  hr = (await member(fx.tenantId, 'viewer', null, 'hr')).token
  hrB = (await member(fx.tenantId, 'viewer', [fx.branchB], 'branch_admin')).token
  staff = await member(fx.tenantId, 'viewer', null)
})
after(async () => {
  await fx.close()
})

describe('employees', () => {
  test('are numbered and start their history with the hire', async () => {
    const a = await employee({ contract: { typeCode: 'fixed_term', startDate: '2025-09-01', endDate: '2026-08-31', salary: 90000 } })
    const b = await employee()
    assert.match(a.employeeNumber, /^EMP-\d{6}$/)
    assert.notEqual(a.employeeNumber, b.employeeNumber)
    const history = (await get(`/hr/employees/${a.id}/history`)).body as { events: { type: string }[] }
    assert.deepEqual(history.events.map((e) => e.type).sort(), ['contract_start', 'hire'])
  })

  test('are HR data: office roles cannot read them; branches are isolated', async () => {
    const a = await employee()
    assert.equal((await get('/hr/employees', fx.tokens.scheduler)).error, 'FORBIDDEN')
    assert.equal((await get(`/hr/employees/${a.id}`, hrB)).error, 'BRANCH_FORBIDDEN')
    const listed = (await get('/hr/employees', hrB)).body as { employees: Emp[] }
    assert.ok(!listed.employees.some((e) => e.id === a.id))
  })

  test('changes of department and branch are kept as history; codes are checked', async () => {
    const a = await employee()
    assert.equal((await call(fx.app, hr, 'PATCH', `/hr/employees/${a.id}`, { departmentCode: 'nope' })).error, 'INVALID_CODE')
    const res = await call(fx.app, hr, 'PATCH', `/hr/employees/${a.id}`, { departmentCode: 'finance', branchId: fx.branchB, effectiveDate: '2026-01-10' })
    assert.equal(res.status, 200, res.error)
    const history = (await get(`/hr/employees/${a.id}/history`)).body as { events: { type: string; from: string; to: string; date: string }[] }
    const dept = history.events.find((e) => e.type === 'department_change')!
    assert.deepEqual([dept.from, dept.to, dept.date], ['teaching', 'finance', '2026-01-10'])
    assert.ok(history.events.some((e) => e.type === 'branch_change'))
  })

  test('a login can be linked to one employee only', async () => {
    const a = await employee()
    const b = await employee()
    assert.equal((await call(fx.app, hr, 'PUT', `/hr/employees/${a.id}/user`, { userId: 'nobody' })).error, 'UNKNOWN_MEMBER')
    const other = await member(fx.tenantId, 'viewer', null)
    assert.equal((await call(fx.app, hr, 'PUT', `/hr/employees/${a.id}/user`, { userId: other.userId })).status, 200)
    assert.equal((await call(fx.app, hr, 'PUT', `/hr/employees/${b.id}/user`, { userId: other.userId })).error, 'USER_ALREADY_LINKED')
  })
})

describe('contracts', () => {
  test('never overlap; a renewal starts the day after and closes the old one', async () => {
    const a = await employee({ contract: { typeCode: 'fixed_term', startDate: '2025-09-01', endDate: '2026-08-31' } })
    const [first] = await contracts(a.id)
    const clash = await post(`/hr/employees/${a.id}/contracts`, { typeCode: 'part_time', startDate: '2026-06-01' })
    assert.equal(clash.error, 'CONTRACT_OVERLAPS')
    const renewed = await post(`/hr/contracts/${first!.id}/renew`, { endDate: '2027-08-31' })
    assert.equal(renewed.status, 201, renewed.error)
    assert.equal((renewed.body as Contract).startDate, '2026-09-01')
    const all = await contracts(a.id)
    assert.deepEqual(all.map((c) => c.status).sort(), ['active', 'renewed'])
    assert.equal((await post(`/hr/contracts/${first!.id}/renew`, {})).error, 'NOT_OPEN')
    // An open-ended contract has nothing to renew from.
    const b = await employee({ contract: { typeCode: 'permanent', startDate: '2025-09-01' } })
    assert.equal((await post(`/hr/contracts/${(await contracts(b.id))[0]!.id}/renew`, {})).error, 'OPEN_ENDED')
  })

  test('ending soon shows in the expiring list', async () => {
    const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10)
    const a = await employee({ contract: { typeCode: 'fixed_term', startDate: '2025-09-01', endDate: soon } })
    const res = (await get('/hr/contracts/expiring')).body as { contracts: { employeeId: string; status: string }[] }
    assert.equal(res.contracts.find((c) => c.employeeId === a.id)?.status, 'expiring')
  })

  test('termination closes the contract and cancels leave not yet taken', async () => {
    const a = await employee({ contract: { typeCode: 'permanent', startDate: '2025-09-01' } })
    const future = await askLeave(a.id, '2026-11-01', '2026-11-02')
    assert.equal(future.status, 201, future.error)
    assert.equal((await post(`/hr/employees/${a.id}/terminate`, { date: '2026-10-15' })).error, 'REASON_REQUIRED')
    const res = await post(`/hr/employees/${a.id}/terminate`, { date: '2026-10-15', reason: 'Resigned' })
    assert.equal(res.status, 200, res.error)
    const [c] = await contracts(a.id)
    assert.deepEqual([c!.status, c!.endDate], ['terminated', '2026-10-15'])
    assert.equal((await leave(a.id)).requests[0]?.status, 'cancelled')
    assert.equal((await post(`/hr/employees/${a.id}/rehire`, { date: '2026-10-01' })).error, 'DATES_OUT_OF_ORDER')
    assert.equal((await post(`/hr/employees/${a.id}/rehire`, { date: '2027-01-10' })).status, 200)
  })
})

describe('leave', () => {
  test('counts working days on the branch calendar and draws on the balance', async () => {
    const a = await employee()
    // Sunday 1 Nov to Sunday 8 Nov 2026: Sun–Thu plus Sunday = 6 working days.
    const res = await askLeave(a.id, '2026-11-01', '2026-11-08')
    assert.equal(res.status, 201, res.error)
    assert.equal((res.body as { days: number }).days, 6)
    assert.deepEqual(await annual(a.id), { ...(await annual(a.id)), entitlement: 14, pending: 6, available: 8 })
    assert.equal((await approve((res.body as { approvalId: string }).approvalId)).status, 200)
    const after = await annual(a.id)
    assert.deepEqual([after.taken, after.pending, after.available], [6, 0, 8])
  })

  test('refuses overlaps, too many days, weekends only and a range across years', async () => {
    const a = await employee()
    await askLeave(a.id, '2026-11-01', '2026-11-05')
    assert.equal((await askLeave(a.id, '2026-11-04', '2026-11-10')).error, 'OVERLAPS')
    const over = await askLeave(a.id, '2026-11-15', '2026-12-10')
    assert.equal(over.error, 'INSUFFICIENT_BALANCE')
    assert.equal((over.body as { available: number }).available, 9)
    assert.equal((await askLeave(a.id, '2026-11-06', '2026-11-07')).error, 'NO_WORKING_DAYS')
    assert.equal((await askLeave(a.id, '2026-12-31', '2027-01-03')).error, 'SPANS_YEARS')
    // Unpaid leave is not limited.
    assert.equal((await askLeave(a.id, '2026-11-15', '2026-12-10', hr, 'unpaid')).status, 201)
  })

  test('an adjustment changes the balance', async () => {
    const a = await employee()
    const res = await post(`/hr/employees/${a.id}/leave-adjustments`, { typeCode: 'annual', year: 2026, days: 5, reason: 'Carried over' })
    assert.equal(res.status, 201, res.error)
    assert.equal((await annual(a.id)).available, 19)
  })

  test('self-service: a linked login asks for its own leave, and cannot approve it', async () => {
    const a = await employee()
    await call(fx.app, hr, 'PUT', `/hr/employees/${a.id}/user`, { userId: staff.userId })
    const me = await get('/hr/me', staff.token)
    assert.equal(me.status, 200, me.error)
    const other = await employee()
    assert.equal((await askLeave(other.id, '2026-11-01', '2026-11-02', staff.token)).error, 'FORBIDDEN')
    const own = await askLeave(a.id, '2026-11-01', '2026-11-02', staff.token)
    assert.equal(own.status, 201, own.error)
    // An admin linked to an employee still can't approve their own leave raised by HR.
    const boss = await member(fx.tenantId, 'admin', null)
    const b = await employee()
    await call(fx.app, hr, 'PUT', `/hr/employees/${b.id}/user`, { userId: boss.userId })
    const forBoss = await askLeave(b.id, '2026-11-01', '2026-11-02')
    assert.equal((await approve((forBoss.body as { approvalId: string }).approvalId, boss.token)).error, 'SELF_DECISION')
    // Withdrawing a pending request cancels its approval too.
    const cancel = await post(`/hr/leave-requests/${(own.body as { id: string }).id}/cancel`, {}, staff.token)
    assert.equal(cancel.status, 200, cancel.error)
    const approval = await withTenant(fx.tenantId, (ctx) => ctx.approvalRequests.findOne({ _id: (own.body as { approvalId: string }).approvalId }))
    assert.equal(approval?.status, 'cancelled')
  })
})

describe('staff attendance', () => {
  test('the daily sheet shows approved leave; saving needs the branch', async () => {
    const a = await employee({ branchId: fx.branchB })
    const b = await employee({ branchId: fx.branchB })
    const req = await askLeave(a.id, '2026-11-03', '2026-11-03')
    await approve((req.body as { approvalId: string }).approvalId)
    const sheet = (await get(`/hr/attendance?branchId=${fx.branchB}&date=2026-11-03`)).body as {
      sessionDay: boolean
      rows: { employeeId: string; status: string | null }[]
    }
    assert.equal(sheet.sessionDay, true)
    assert.equal(sheet.rows.find((r) => r.employeeId === a.id)?.status, 'leave')
    assert.equal(sheet.rows.find((r) => r.employeeId === b.id)?.status, null)
    const body = { branchId: fx.branchB, date: '2026-11-03', records: [{ employeeId: b.id, status: 'late', checkIn: '08:20' }] }
    assert.equal((await call(fx.app, hr, 'PUT', '/hr/attendance', body)).status, 200)
    const wrong = { ...body, branchId: fx.branchA }
    assert.equal((await call(fx.app, hr, 'PUT', '/hr/attendance', wrong)).error, 'NOT_IN_BRANCH')
    const mine = (await get(`/hr/employees/${b.id}/attendance?from=2026-11-01&to=2026-11-30`)).body as { counts: Record<string, number> }
    assert.deepEqual(mine.counts, { late: 1 })
  })
})

describe('staff documents', () => {
  test('HR attaches files to an employee; others cannot see them', async () => {
    const a = await employee()
    const upload = await fx.app.inject({
      method: 'POST',
      url: `${config.routePrefix}/documents?ownerType=employee&ownerId=${a.id}&category=contract&fileName=c.png&expiresAt=2026-10-01`,
      headers: { authorization: `Bearer ${hr}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
    })
    assert.equal(upload.statusCode, 201, upload.body)
    assert.equal((await get(`/documents?ownerType=employee&ownerId=${a.id}`, fx.tokens.scheduler)).error, 'FORBIDDEN')
    const r = (await get(`/hr/reports/summary?from=2026-01-01&to=2026-12-31`)).body as { documents: { employeeId: string }[] }
    assert.ok(r.documents.some((d) => d.employeeId === a.id))
  })
})

describe('HR summary', () => {
  test('headcount, movement and leave by type', async () => {
    const res = await get(`/hr/reports/summary?branchId=${fx.branchB}&from=2026-01-01&to=2026-12-31`)
    assert.equal(res.status, 200, res.error)
    const r = res.body as {
      headcount: { active: number; byDepartment: { key: string; count: number }[] }
      leave: { byType: { typeCode: string; days: number }[] }
      attendance: { byStatus: { key: string; count: number }[] }
    }
    assert.ok(r.headcount.active >= 2)
    assert.deepEqual(r.leave.byType, [{ typeCode: 'annual', days: 1, requests: 1 }])
    assert.deepEqual(r.attendance.byStatus, [{ key: 'late', count: 1 }])
    assert.equal((await get('/hr/reports/summary?from=2026-01-01&to=2026-12-31', fx.tokens.scheduler)).error, 'FORBIDDEN')
  })
})
