// SAMS 3.1: installment plans — an even split or explicit dates, checked
// against the invoice total; each installment's status worked out from
// payments oldest first; a line change flags the plan as stale.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { call, createFixture, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'
import { splitEvenly } from '../finance/installments.js'

let fx: Fixture
let fin: FinanceFixture

type View = {
  total: number
  paidTotal: number
  outstanding: number
  overdue: number
  installmentsMatchTotal: boolean
  installments: { dueDate: string; amount: number; paid: number; status: string }[]
}

const put = (id: string, body: unknown, token = fx.tokens.scheduler) =>
  call(fx.app, token, 'PUT', `/finance/invoices/${id}/installments`, body)
const get = async (id: string) => (await call(fx.app, fx.tokens.viewer, 'GET', `/finance/invoices/${id}`)).body as View

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
})
after(async () => {
  await fx.close()
})

describe('splitting', () => {
  test('even parts, the last absorbs the rounding, month ends clamp', () => {
    const plan = splitEvenly(10000, 3, '2027-01-31', 1)
    assert.deepEqual(plan.map((p) => [p.dueDate, p.amount]), [
      ['2027-01-31', 3333],
      ['2027-02-28', 3333],
      ['2027-03-31', 3334],
    ])
  })

  test('an even split is saved and adds up to the total', async () => {
    const inv = await fin.invoice()
    const res = await put(inv.id, { split: { count: 4, firstDueDate: '2026-09-01', intervalMonths: 3 } })
    assert.equal(res.status, 200, res.error)
    const body = res.body as View
    assert.deepEqual(body.installments.map((p) => p.dueDate), ['2026-09-01', '2026-12-01', '2027-03-01', '2027-06-01'])
    assert.equal(body.installments.reduce((s, p) => s + p.amount, 0), 12000)
  })
})

describe('explicit plans', () => {
  test('must add up, be in date order and use positive amounts', async () => {
    const inv = await fin.invoice()
    const plan = (amounts: number[], dates = ['2026-09-01', '2026-10-01']) => ({
      installments: amounts.map((amount, i) => ({ dueDate: dates[i], amount })),
    })
    assert.equal((await put(inv.id, plan([6000, 5000]))).error, 'INSTALLMENTS_TOTAL_MISMATCH')
    assert.equal((await put(inv.id, plan([6000, 6000], ['2026-10-01', '2026-09-01']))).error, 'INSTALLMENTS_OUT_OF_ORDER')
    assert.equal((await put(inv.id, plan([12000, 0]))).error, 'INVALID_INSTALLMENT_AMOUNT')
    assert.equal((await put(inv.id, plan([7000, 5000]))).status, 200)
    // An empty list clears the plan.
    assert.equal((await put(inv.id, { installments: [] })).status, 200)
    assert.deepEqual((await get(inv.id)).installments, [])
  })

  test('need invoice rights and the branch; not on a void invoice', async () => {
    const inB = await fin.invoice({ branchId: fx.branchB })
    const body = { split: { count: 2, firstDueDate: '2026-09-01' } }
    assert.equal((await put(inB.id, body, fx.tokens.viewer)).error, 'FORBIDDEN')
    assert.equal((await put(inB.id, body, fx.scopedToken)).error, 'BRANCH_FORBIDDEN')
    await call(fx.app, fx.tokens.admin, 'POST', `/finance/invoices/${inB.id}/void`, { reason: 'Test' })
    assert.equal((await put(inB.id, body)).error, 'INVOICE_VOID')
  })
})

describe('status from payments', () => {
  test('payments cover the oldest installment first; past-due unpaid parts are overdue', async () => {
    const inv = await fin.invoice()
    await put(inv.id, {
      installments: [
        { dueDate: '2020-01-01', amount: 4000 },
        { dueDate: '2020-02-01', amount: 4000 },
        { dueDate: '2999-01-01', amount: 4000 },
      ],
    })
    await fin.pay(inv.id, 5000)
    const view = await get(inv.id)
    assert.deepEqual(view.installments.map((p) => [p.paid, p.status]), [
      [4000, 'paid'],
      [1000, 'overdue'],
      [0, 'due'],
    ])
    assert.equal(view.paidTotal, 5000)
    assert.equal(view.outstanding, 7000)
    assert.equal(view.overdue, 3000)
  })

  test('without a plan the whole balance is overdue once the due date passes', async () => {
    const inv = await fin.invoice({ dueDate: '2020-01-01' })
    await fin.pay(inv.id, 2000)
    assert.equal((await get(inv.id)).overdue, 10000)
  })

  test('a line change that moves the total flags the plan', async () => {
    const inv = await fin.invoice()
    await put(inv.id, { split: { count: 2, firstDueDate: '2026-09-01' } })
    assert.equal((await get(inv.id)).installmentsMatchTotal, true)
    await call(fx.app, fx.tokens.scheduler, 'POST', `/finance/invoices/${inv.id}/line-items`, { label: 'Trip', amount: 500 })
    assert.equal((await get(inv.id)).installmentsMatchTotal, false)
  })
})
