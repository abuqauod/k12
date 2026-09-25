// SAMS 3.5 expenses (categories, vendors, approval, payment) and 3.6 the
// finance summary built from every other Phase 3 record.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { call, createFixture, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
let vendor = ''

type Expense = { id: string; status: string; approvalId: string; expenseNumber: string }

const expense = (body: Record<string, unknown> = {}, token = fx.tokens.scheduler) =>
  call(fx.app, token, 'POST', '/finance/expenses', {
    branchId: fx.branchA,
    categoryCode: 'maintenance',
    vendorId: vendor,
    description: 'Fix the gym roof',
    amount: 4000,
    expenseDate: '2026-09-05',
    ...body,
  })
const approve = (id: string) => call(fx.app, fx.tokens.admin, 'POST', `/approvals/${id}/approve`, {})
const pay = (id: string) => call(fx.app, fx.tokens.admin, 'POST', `/finance/expenses/${id}/pay`, { paidAt: '2026-09-15', method: 'bank_transfer' })

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
  const v = await call(fx.app, fx.tokens.scheduler, 'POST', '/finance/vendors', { name: 'Roof & Co', phone: '0790000000' })
  assert.equal(v.status, 201, v.error)
  vendor = (v.body as { id: string }).id
})
after(async () => {
  await fx.close()
})

describe('expenses', () => {
  test('are submitted with an approval, approved by someone else, then paid', async () => {
    const res = await expense()
    assert.equal(res.status, 201, res.error)
    const e = res.body as Expense
    assert.match(e.expenseNumber, /^EXP-\d{6}$/)
    assert.equal((await pay(e.id)).error, 'NOT_APPROVED')
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', `/approvals/${e.approvalId}/approve`, {})).error, 'FORBIDDEN')
    assert.equal((await approve(e.approvalId)).status, 200)
    const paid = await pay(e.id)
    assert.equal(paid.status, 200, paid.error)
    assert.equal((paid.body as { status: string }).status, 'paid')
  })

  test('need a known category, an active vendor and the branch', async () => {
    assert.equal((await expense({ categoryCode: 'yachts' })).error, 'INVALID_CATEGORY')
    assert.equal((await expense({ vendorId: 'nope' })).error, 'UNKNOWN_VENDOR')
    assert.equal((await expense({ branchId: fx.branchB }, fx.scopedToken)).error, 'BRANCH_FORBIDDEN')
    assert.equal((await expense({}, fx.tokens.viewer)).error, 'FORBIDDEN')
  })

  test('rejected or withdrawn expenses close', async () => {
    const a = (await expense()).body as Expense
    await call(fx.app, fx.tokens.admin, 'POST', `/approvals/${a.approvalId}/reject`, { comment: 'Get another quote' })
    const b = (await expense()).body as Expense
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', `/finance/expenses/${b.id}/cancel`, {})).status, 200)
    const list = (await call(fx.app, fx.tokens.viewer, 'GET', `/finance/expenses?vendorId=${vendor}`)).body as { expenses: { id: string; status: string; vendorName: string }[] }
    const byId = new Map(list.expenses.map((x) => [x.id, x]))
    assert.equal(byId.get(a.id)?.status, 'rejected')
    assert.equal(byId.get(b.id)?.status, 'cancelled')
    assert.equal(byId.get(a.id)?.vendorName, 'Roof & Co')
  })
})

describe('finance summary', () => {
  test('revenue, collections, refunds, expenses, net and aging agree with the records', async () => {
    // A branch of its own data: branch B, so the expense tests above don't count.
    const inv = await fin.invoice({ branchId: fx.branchB, dueDate: '2026-01-01' })
    const dt = await call(fx.app, fx.tokens.admin, 'POST', '/finance/discount-types', { name: 'Staff', type: 'amount', value: 1000 })
    await call(fx.app, fx.tokens.admin, 'POST', `/finance/invoices/${inv.id}/adjustments`, { discountTypeId: (dt.body as { id: string }).id })
    await fin.pay(inv.id, 6000, { paidAt: '2026-09-02' })
    await fin.pay(inv.id, 1000, { paidAt: '2026-09-03', method: 'cheque', awaitingConfirmation: true })
    const refund = (await call(fx.app, fx.tokens.scheduler, 'POST', `/finance/invoices/${inv.id}/refunds`, { amount: 500, reason: 'Overcharged trip' })).body as { id: string; approvalId: string }
    await approve(refund.approvalId)
    await call(fx.app, fx.tokens.admin, 'POST', `/finance/refunds/${refund.id}/pay`, { paidAt: '2026-09-04', method: 'cash' })
    const e = (await expense({ branchId: fx.branchB, amount: 1500 })).body as Expense
    await approve(e.approvalId)
    await pay(e.id)

    const res = await call(fx.app, fx.tokens.admin, 'GET', `/finance/reports/summary?branchId=${fx.branchB}&from=2026-09-01&to=2026-09-30`)
    assert.equal(res.status, 200, res.error)
    const r = res.body as {
      revenue: { gross: number; discounts: number; billed: number }
      collections: { total: number; awaitingConfirmation: number; byMethod: { method: string; amount: number }[] }
      refunds: { paid: number }
      expenses: { paid: number; byCategory: { categoryCode: string; amount: number }[] }
      net: { net: number }
      aging: { total: number; d90_plus: number }
      overdue: { invoices: { invoiceId: string; overdue: number }[] }
    }
    assert.deepEqual(
      [r.revenue.gross, r.revenue.discounts, r.revenue.billed],
      [12000, 1000, 11000],
    )
    assert.equal(r.collections.total, 6000)
    assert.equal(r.collections.awaitingConfirmation, 1000)
    assert.deepEqual(r.collections.byMethod.map((m) => [m.method, m.amount]), [['cash', 6000]])
    assert.equal(r.refunds.paid, 500)
    assert.equal(r.expenses.paid, 1500)
    assert.deepEqual(r.expenses.byCategory, [{ categoryCode: 'maintenance', amount: 1500, count: 1 }])
    assert.equal(r.net.net, 6000 - 500 - 1500)
    // 11,000 billed − (6,000 − 500) paid = 5,500, due since January.
    assert.equal(r.aging.total, 5500)
    assert.equal(r.aging.d90_plus, 5500)
    assert.deepEqual(r.overdue.invoices.map((o) => [o.invoiceId, o.overdue]), [[inv.id, 5500]])
  })

  test('needs reports.finance and the branch', async () => {
    const q = `from=2026-09-01&to=2026-09-30`
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'GET', `/finance/reports/summary?${q}`)).error, 'FORBIDDEN')
    assert.equal((await call(fx.app, fx.tokens.admin, 'GET', `/finance/reports/summary?from=2026-10-01&to=2026-09-01`)).error, 'INVALID_QUERY')
  })
})
