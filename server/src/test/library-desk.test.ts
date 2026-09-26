// SAMS 11.3: the library desk — the ID card and the copy scanned, a fine
// onto the invoice, and overdue notices to families.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { runDailyNotices } from '../communication/notices.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
const post = (path: string, body: unknown, token = fx.tokens.scheduler) => call(fx.app, token, 'POST', path, body)
const get = (path: string, token = fx.tokens.scheduler) => call(fx.app, token, 'GET', path)
const idOf = (res: { body: unknown }) => (res.body as { id: string }).id

let student = ''
let studentNumber = ''
let invoiceId = ''

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
  const inv = await fin.invoice()
  student = inv.studentId
  invoiceId = inv.id
  studentNumber = (await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: student })))!.studentNumber
  const book = idOf(await post('/ops/library/books', { title: 'Kalila wa Dimna', author: 'Ibn al-Muqaffa' }))
  for (const code of ['KD-1', 'KD-2']) await post(`/ops/library/books/${book}/copies`, { branchId: fx.branchA, barcode: code })
  await call(fx.app, fx.tokens.scheduler, 'PUT', '/ops/library/settings', { loanDays: 7, maxLoans: 3, maxRenewals: 1, finePerDay: 25, lostFee: 2000 })
  // A parent to tell.
  const p = await post('/parents', { fullName: 'Reader Parent', primaryPhone: '0790001111', email: 'reader@family.test' }, fx.tokens.admin)
  await post(`/parents/${(p.body as { parent: { id: string } }).parent.id}/links`, { studentId: student, relationshipType: 'mother' }, fx.tokens.admin)
})
after(async () => {
  await fx.close()
})

describe('the desk', () => {
  test('a scanned card finds the borrower and what they hold', async () => {
    assert.equal((await post('/ops/library/loans', { barcode: 'KD-1', borrowerType: 'student', borrowerId: student, loanedAt: '2026-01-01' })).status, 201)
    const card = await get(`/ops/library/borrower?card=${encodeURIComponent(studentNumber)}`)
    assert.equal(card.status, 200, card.error)
    const body = card.body as { type: string; id: string; loans: { barcode: string; overdue: boolean }[] }
    assert.deepEqual([body.type, body.id], ['student', student])
    assert.deepEqual(body.loans.map((l) => [l.barcode, l.overdue]), [['KD-1', true]])
    assert.equal((await get('/ops/library/borrower?card=NOPE-0')).error, 'UNKNOWN_CARD')
    const confined = (await member(fx.tenantId, 'scheduler', [fx.branchB])).token
    assert.equal((await get(`/ops/library/borrower?card=${encodeURIComponent(studentNumber)}`, confined)).error, 'BRANCH_FORBIDDEN')
  })

  test('families of students with overdue books are told, once per period', async () => {
    const sent = await post('/ops/library/overdue/notify', {})
    assert.equal(sent.status, 200, sent.error)
    assert.equal((sent.body as { loans: number }).loans, 1)
    const again = await post('/ops/library/overdue/notify', {})
    assert.equal((again.body as { loans: number }).loans, 0, 'not twice in the same period')
    const jobs = await withTenant(fx.tenantId, (ctx) => ctx.notificationJobs.find({ kind: 'library_overdue' }).toArray())
    assert.ok(jobs.length >= 1 && jobs[0]!.body.includes('Kalila wa Dimna'))
    // The daily run does it when switched on.
    await call(fx.app, fx.tokens.admin, 'PUT', '/communication/settings', { libraryOverdue: { auto: true, repeatDays: 7 } })
    assert.equal(await runDailyNotices(fx.tenantId, '2099-01-01'), true)
  })

  test('returning by scanning the copy, then the fine onto the invoice', async () => {
    const ret = await post('/ops/library/return-by-barcode', { barcode: 'KD-1' })
    assert.equal(ret.status, 200, ret.error)
    const loan = ret.body as { id: string; fine: number; fineStatus: string }
    assert.equal(loan.fineStatus, 'due')
    assert.ok(loan.fine > 0)
    assert.equal((await post('/ops/library/return-by-barcode', { barcode: 'KD-1' })).error, 'NO_OPEN_LOAN')
    // A fine due blocks new loans until it is settled or billed.
    assert.equal((await post('/ops/library/loans', { barcode: 'KD-2', borrowerType: 'student', borrowerId: student })).error, 'FINES_DUE')
    const billed = await post(`/ops/library/loans/${loan.id}/bill`, {})
    assert.equal(billed.status, 200, billed.error)
    assert.equal((billed.body as { invoiceId: string }).invoiceId, invoiceId)
    const inv = await withTenant(fx.tenantId, (ctx) => ctx.invoices.findOne({ _id: invoiceId }))
    const line = inv!.lineItems.find((l) => l.sourceFeeItemId === `library:${loan.id}`)
    assert.equal(line?.amount, loan.fine)
    assert.match(line!.label, /Library fine — Kalila wa Dimna/)
    assert.equal((await post(`/ops/library/loans/${loan.id}/bill`, {})).error, 'NO_FINE_DUE')
    assert.equal((await post('/ops/library/loans', { barcode: 'KD-2', borrowerType: 'student', borrowerId: student })).status, 201)
    assert.equal((await post(`/ops/library/loans/${loan.id}/bill`, {}, fx.tokens.viewer)).error, 'FORBIDDEN')
  })
})
