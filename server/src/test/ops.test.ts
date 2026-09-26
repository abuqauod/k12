// SAMS Phase 5: assets (5.1), inventory (5.2), facilities and maintenance
// (5.3), transport administration (5.4), library (5.5), events (5.6).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
let ops: string
let room = ''
let employee = ''

const post = (path: string, body: unknown, token = ops) => call(fx.app, token, 'POST', path, body)
const get = (path: string, token = ops) => call(fx.app, token, 'GET', path)
const put = (path: string, body: unknown, token = ops) => call(fx.app, token, 'PUT', path, body)
const patch = (path: string, body: unknown, token = ops) => call(fx.app, token, 'PATCH', path, body)
const idOf = (res: { body: unknown }) => (res.body as { id: string }).id

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
  ops = (await member(fx.tenantId, 'viewer', null, 'operations')).token
  const building = await post('/ops/buildings', { branchId: fx.branchA, name: 'Main block', floors: 2 })
  assert.equal(building.status, 201, building.error)
  const r = await post('/ops/rooms', { buildingId: idOf(building), name: 'Lab 1', typeCode: 'lab', capacity: 24 })
  assert.equal(r.status, 201, r.error)
  room = idOf(r)
  const e = await call(fx.app, fx.tokens.admin, 'POST', '/hr/employees', { branchId: fx.branchA, givenName: 'Ali', familyName: 'Tech', hireDate: '2025-01-01' })
  employee = idOf(e)
})
after(async () => {
  await fx.close()
})

describe('assets', () => {
  test('go through their lifecycle, each step kept as history', async () => {
    const res = await post('/ops/assets', { name: 'Projector', categoryCode: 'it', branchId: fx.branchA, purchaseCost: 45000, purchaseDate: '2026-01-10' })
    assert.equal(res.status, 201, res.error)
    const id = idOf(res)
    assert.match((res.body as { assetTag: string }).assetTag, /^AST-\d{6}$/)
    assert.equal((await post(`/ops/assets/${id}/return`, {})).error, 'NOT_ASSIGNED')
    assert.equal((await post(`/ops/assets/${id}/assign`, { type: 'room', id: room })).status, 200)
    assert.equal((await post(`/ops/assets/${id}/transfer`, { branchId: fx.branchB })).error, 'RETURN_FIRST')
    assert.equal((await post(`/ops/assets/${id}/maintenance`, { action: 'start', note: 'Bulb' })).status, 200)
    const back = await post(`/ops/assets/${id}/maintenance`, { action: 'end', cost: 1500 })
    assert.equal((back.body as { status: string }).status, 'assigned', 'returns to whoever had it')
    await post(`/ops/assets/${id}/return`, {})
    assert.equal((await post(`/ops/assets/${id}/transfer`, { branchId: fx.branchB })).status, 200)
    assert.equal((await post(`/ops/assets/${id}/dispose`, {})).error, 'REASON_REQUIRED')
    assert.equal((await post(`/ops/assets/${id}/dispose`, { reason: 'Beyond repair' })).status, 200)
    assert.equal((await post(`/ops/assets/${id}/assign`, { type: 'employee', id: employee })).error, 'DISPOSED')
    const detail = (await get(`/ops/assets/${id}`)).body as { history: { type: string }[] }
    assert.deepEqual(detail.history.map((h) => h.type).sort(), ['assign', 'dispose', 'maintenance_end', 'maintenance_start', 'purchase', 'return', 'transfer'])
  })

  test('need assets.manage to change; a room must be in the branch', async () => {
    assert.equal((await post('/ops/assets', { name: 'X', categoryCode: 'it', branchId: fx.branchA }, fx.tokens.scheduler)).error, 'FORBIDDEN')
    assert.equal((await post('/ops/assets', { name: 'X', categoryCode: 'it', branchId: fx.branchB, roomId: room })).error, 'UNKNOWN_ROOM')
    assert.equal((await get('/ops/assets', fx.tokens.viewer)).error, 'FORBIDDEN')
  })
})

describe('inventory', () => {
  test('quantity follows movements and never goes below zero; transfers make a line at the other branch', async () => {
    const supplier = await post('/ops/suppliers', { name: 'Paper Co' })
    assert.equal(supplier.status, 201, supplier.error)
    const item = await post('/ops/inventory/items', { branchId: fx.branchA, sku: 'A4-500', name: 'A4 paper', unit: 'ream', categoryCode: 'stationery', reorderLevel: 5 })
    assert.equal(item.status, 201, item.error)
    const id = idOf(item)
    assert.equal((await post('/ops/inventory/items', { branchId: fx.branchA, sku: 'A4-500', name: 'dup', categoryCode: 'stationery' })).error, 'SKU_TAKEN')
    await post(`/ops/inventory/items/${id}/movements`, { type: 'receive', quantity: 20, supplierId: idOf(supplier), unitCost: 350 })
    const issue = await post(`/ops/inventory/items/${id}/movements`, { type: 'issue', quantity: 25, issuedTo: 'Grade 3' })
    assert.equal(issue.error, 'INSUFFICIENT_STOCK')
    await post(`/ops/inventory/items/${id}/movements`, { type: 'issue', quantity: 12, issuedTo: 'Grade 3' })
    const t = await post(`/ops/inventory/items/${id}/movements`, { type: 'transfer', quantity: 4, toBranchId: fx.branchB })
    assert.equal(t.status, 201, t.error)
    assert.equal((t.body as { item: { quantity: number; lowStock: boolean } }).item.quantity, 4)
    assert.equal((t.body as { item: { lowStock: boolean } }).item.lowStock, true)
    const inB = (await get(`/ops/inventory/items?branchId=${fx.branchB}`)).body as { items: { sku: string; quantity: number }[] }
    assert.equal(inB.items.find((i) => i.sku === 'A4-500')?.quantity, 4)
    const low = (await get(`/ops/inventory/items?branchId=${fx.branchA}&lowStock=true`)).body as { items: { id: string }[] }
    assert.ok(low.items.some((i) => i.id === id))
    const history = (await get(`/ops/inventory/items/${id}/movements`)).body as { movements: { type: string; balance: number }[] }
    assert.deepEqual(history.movements.map((m) => [m.type, m.balance]), [
      ['transfer_out', 4],
      ['issue', 8],
      ['receive', 20],
    ])
  })
})

describe('maintenance', () => {
  test('office staff report; facilities work it; the asset follows', async () => {
    const asset = idOf(await post('/ops/assets', { name: 'Boiler', categoryCode: 'other', branchId: fx.branchA }))
    const req = await post('/ops/maintenance', { branchId: fx.branchA, roomId: room, assetId: asset, title: 'No hot water', priority: 'high' }, fx.tokens.scheduler)
    assert.equal(req.status, 201, req.error)
    const id = idOf(req)
    assert.match((req.body as { requestNumber: string }).requestNumber, /^MNT-\d{6}$/)
    assert.equal((await patch(`/ops/maintenance/${id}`, { status: 'in_progress' }, fx.tokens.scheduler)).error, 'FORBIDDEN')
    assert.equal((await patch(`/ops/maintenance/${id}`, { status: 'in_progress', assignedToEmployeeId: employee })).status, 200)
    assert.equal((await withTenant(fx.tenantId, (ctx) => ctx.assets.findOne({ _id: asset })))?.status, 'maintenance')
    assert.equal((await patch(`/ops/maintenance/${id}`, { status: 'resolved' })).error, 'RESOLUTION_REQUIRED')
    assert.equal((await patch(`/ops/maintenance/${id}`, { status: 'resolved', resolution: 'Replaced valve', cost: 8000 })).status, 200)
    assert.equal((await withTenant(fx.tenantId, (ctx) => ctx.assets.findOne({ _id: asset })))?.status, 'in_stock')
    assert.equal((await patch(`/ops/maintenance/${id}`, { status: 'cancelled' })).error, 'WRONG_STATUS')
    // A reporter may cancel their own open request.
    const mine = idOf(await post('/ops/maintenance', { branchId: fx.branchA, title: 'Broken chair' }, fx.tokens.scheduler))
    assert.equal((await patch(`/ops/maintenance/${mine}`, { status: 'cancelled' }, fx.tokens.scheduler)).status, 200)
  })
})

describe('transport administration', () => {
  test('bus paperwork and driver licences show up when expiring', async () => {
    const bus = await call(fx.app, fx.tokens.admin, 'POST', '/transport/buses', { branchId: fx.branchA, name: 'Bus 7', seats: 30 })
    assert.equal(bus.status, 201, bus.error)
    const busId = (bus.body as { id: string }).id
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
    assert.equal((await put(`/ops/transport/buses/${busId}/details`, { plateNumber: '12-3456', insuranceExpiry: soon, registrationExpiry: '2030-01-01' })).status, 200)
    const driver = await post('/ops/transport/drivers', { branchId: fx.branchA, name: 'Omar', licenseExpiry: '2020-01-01', busId })
    assert.equal(driver.status, 201, driver.error)
    const c = (await get(`/ops/transport/compliance?branchId=${fx.branchA}`)).body as { items: { kind: string; expired: boolean }[] }
    assert.deepEqual(c.items.map((i) => [i.kind, i.expired]).sort(), [
      ['insurance', false],
      ['license', true],
    ])
    assert.equal((await post('/ops/transport/drivers', { branchId: fx.branchB, name: 'X', busId })).error, 'UNKNOWN_BUS')
  })

  test('fees are billed once to each rider with an invoice', async () => {
    const rider = await fin.invoice()
    await withTenant(fx.tenantId, (ctx) => ctx.students.findOneAndUpdate({ _id: rider.studentId }, { $set: { stopId: 'stop-1', transportMode: 'MORNING' } }))
    const walker = await fin.invoice()
    await withTenant(fx.tenantId, (ctx) => ctx.students.findOneAndUpdate({ _id: walker.studentId }, { $set: { stopId: '', transportMode: 'NONE' } }))
    const body = { branchId: fx.branchA, academicYearId: fin.yearId }
    assert.equal((await post('/ops/transport/fees/bill', body, fx.tokens.admin)).error, 'NO_FEE')
    assert.equal((await put('/ops/transport/fees', { ...body, twoWay: 30000, oneWay: 18000 })).status, 200)
    // Billing touches invoices: needs finance rights too.
    assert.equal((await post('/ops/transport/fees/bill', body)).error, 'FORBIDDEN')
    const first = await post('/ops/transport/fees/bill', body, fx.tokens.admin)
    assert.equal(first.status, 200, first.error)
    assert.ok((first.body as { charged: number }).charged >= 1)
    const again = (await post('/ops/transport/fees/bill', body, fx.tokens.admin)).body as { charged: number }
    assert.equal(again.charged, 0, 'never twice')
    const inv = (await call(fx.app, fx.tokens.admin, 'GET', `/finance/invoices/${rider.id}`)).body as { total: number }
    assert.equal(inv.total, 12000 + 18000)
    const walked = (await call(fx.app, fx.tokens.admin, 'GET', `/finance/invoices/${walker.id}`)).body as { total: number }
    assert.equal(walked.total, 12000)
  })
})

describe('library', () => {
  test('lend, limits, renew, late fine, and no borrowing with a fine due', async () => {
    const student = await fin.student()
    const book = idOf(await post('/ops/library/books', { title: 'The Little Prince', author: 'Saint-Exupéry', categoryCode: 'fiction' }, fx.tokens.scheduler))
    for (const code of ['LP-1', 'LP-2']) {
      assert.equal((await post(`/ops/library/books/${book}/copies`, { branchId: fx.branchA, barcode: code }, fx.tokens.scheduler)).status, 201)
    }
    assert.equal((await post(`/ops/library/books/${book}/copies`, { branchId: fx.branchA, barcode: 'LP-1' }, fx.tokens.scheduler)).error, 'BARCODE_TAKEN')
    await put('/ops/library/settings', { loanDays: 7, maxLoans: 1, maxRenewals: 1, finePerDay: 25, lostFee: 2000 }, fx.tokens.scheduler)
    const loan = await post('/ops/library/loans', { barcode: 'LP-1', borrowerType: 'student', borrowerId: student, loanedAt: '2026-01-01' }, fx.tokens.scheduler)
    assert.equal(loan.status, 201, loan.error)
    assert.equal((loan.body as { dueDate: string }).dueDate, '2026-01-08')
    assert.equal((await post('/ops/library/loans', { barcode: 'LP-1', borrowerType: 'student', borrowerId: student }, fx.tokens.scheduler)).error, 'NOT_AVAILABLE')
    assert.equal((await post('/ops/library/loans', { barcode: 'LP-2', borrowerType: 'student', borrowerId: student }, fx.tokens.scheduler)).error, 'LOAN_LIMIT')
    assert.equal((await post(`/ops/library/loans/${idOf(loan)}/renew`, {}, fx.tokens.scheduler)).error, 'OVERDUE')
    const overdue = (await get('/ops/library/loans?view=overdue', fx.tokens.scheduler)).body as { loans: { id: string }[] }
    assert.ok(overdue.loans.some((l) => l.id === idOf(loan)))
    const ret = await post(`/ops/library/loans/${idOf(loan)}/return`, { date: '2026-01-12' }, fx.tokens.scheduler)
    assert.deepEqual([(ret.body as { fine: number }).fine, (ret.body as { fineStatus: string }).fineStatus], [100, 'due'])
    assert.equal((await post('/ops/library/loans', { barcode: 'LP-2', borrowerType: 'student', borrowerId: student }, fx.tokens.scheduler)).error, 'FINES_DUE')
    assert.equal((await post(`/ops/library/loans/${idOf(loan)}/waive`, {}, fx.tokens.scheduler)).error, 'REASON_REQUIRED')
    assert.equal((await post(`/ops/library/loans/${idOf(loan)}/waive`, { reason: 'First time' }, fx.tokens.scheduler)).status, 200)
    const next = await post('/ops/library/loans', { barcode: 'LP-2', borrowerType: 'student', borrowerId: student }, fx.tokens.scheduler)
    assert.equal(next.status, 201, next.error)
    const lost = await post(`/ops/library/loans/${idOf(next)}/lost`, {}, fx.tokens.scheduler)
    assert.equal((lost.body as { fine: number }).fine, 2000)
    const copies = (await get(`/ops/library/books?q=LP-2`, fx.tokens.scheduler)).body as { books: { copies: { barcode: string; status: string }[] }[] }
    assert.equal(copies.books[0]?.copies.find((c) => c.barcode === 'LP-2')?.status, 'lost')
  })
})

describe('events', () => {
  test('capacity, waitlist promotion, eligibility, attendance and billing', async () => {
    const created = await post(
      '/ops/events',
      { branchId: fx.branchA, title: 'Museum trip', typeCode: 'trip', startDate: '2026-01-20', endDate: '2026-01-20', capacity: 1, fee: 1500, gradeLevels: ['Grade 5'] },
      fx.tokens.scheduler,
    )
    assert.equal(created.status, 201, created.error)
    const id = idOf(created)
    const a = await fin.invoice()
    const b = await fin.invoice()
    const reg = (studentId: string) => post(`/ops/events/${id}/registrations`, { studentId }, fx.tokens.scheduler)
    assert.equal((await reg(a.studentId)).error, 'REGISTRATION_CLOSED', 'drafts take no registrations')
    await post(`/ops/events/${id}/status`, { status: 'open' }, fx.tokens.scheduler)
    const ra = await reg(a.studentId)
    assert.equal((ra.body as { status: string }).status, 'registered')
    assert.equal((await reg(a.studentId)).error, 'ALREADY_REGISTERED')
    assert.equal(((await reg(b.studentId)).body as { status: string }).status, 'waitlisted')
    const other = await fin.student(fx.branchB)
    assert.equal((await reg(other)).error, 'UNKNOWN_STUDENT')
    // A cancellation lets the waitlisted student in.
    const cancel = await post(`/ops/events/${id}/registrations/${idOf(ra)}/cancel`, {}, fx.tokens.scheduler)
    assert.deepEqual(cancel.body, { promoted: 1 })
    const detail = (await get(`/ops/events/${id}`, fx.tokens.scheduler)).body as { registrations: { id: string; studentId: string; status: string }[]; registered: number }
    assert.deepEqual(detail.registrations.map((r) => [r.studentId, r.status]), [[b.studentId, 'registered']])
    await put(`/ops/events/${id}/attendance`, { records: [{ registrationId: detail.registrations[0]!.id, attended: true }] }, fx.tokens.scheduler)
    await put(`/ops/events/${id}/costs`, { costs: [{ label: 'Coach', amount: 900 }] }, fx.tokens.scheduler)
    const summary = (await get(`/ops/events/${id}`, fx.tokens.scheduler)).body as { attended: number; budget: { income: number; costs: number; net: number } }
    assert.deepEqual([summary.attended, summary.budget.income, summary.budget.net], [1, 1500, 600])
    // Billing needs finance rights; the admin bills once.
    assert.equal((await post(`/ops/events/${id}/bill`, { academicYearId: fin.yearId }, ops)).error, 'FORBIDDEN')
    const bill = await post(`/ops/events/${id}/bill`, { academicYearId: fin.yearId }, fx.tokens.admin)
    assert.equal((bill.body as { charged: number }).charged, 1)
    const inv = (await call(fx.app, fx.tokens.admin, 'GET', `/finance/invoices/${b.id}`)).body as { total: number }
    assert.equal(inv.total, 13500)
  })
})
