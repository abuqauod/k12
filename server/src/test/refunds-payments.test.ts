// SAMS 3.3 refunds (request → approve → pay out, capped at the refundable
// amount) and 3.4 payments (one amount over several invoices, and payments
// that wait for confirmation).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { call, createFixture, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture

type Inv = { id: string; total: number; status: string; paidTotal: number; outstanding: number }
type Refund = { id: string; status: string; approvalId: string; refundNumber: string }

const getInvoice = async (id: string) => (await call(fx.app, fx.tokens.viewer, 'GET', `/finance/invoices/${id}`)).body as Inv
const askRefund = (invoiceId: string, amount: number, token = fx.tokens.scheduler) =>
  call(fx.app, token, 'POST', `/finance/invoices/${invoiceId}/refunds`, { amount, reason: 'Left mid-term' })
const approve = (id: string) => call(fx.app, fx.tokens.admin, 'POST', `/approvals/${id}/approve`, {})
const payOut = (id: string, token = fx.tokens.admin) =>
  call(fx.app, token, 'POST', `/finance/refunds/${id}/pay`, { paidAt: '2026-09-20', method: 'bank_transfer', reference: 'TRX-1' })

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
})
after(async () => {
  await fx.close()
})

describe('refunds', () => {
  test('go request → approve → pay; only a paid refund changes what was paid', async () => {
    const inv = await fin.invoice()
    await fin.pay(inv.id, 12000)
    const res = await askRefund(inv.id, 3000)
    assert.equal(res.status, 201, res.error)
    const refund = res.body as Refund
    assert.match(refund.refundNumber, /^RFD-\d{6}$/)
    assert.equal((await payOut(refund.id)).error, 'NOT_APPROVED')
    assert.equal((await getInvoice(inv.id)).status, 'paid')

    assert.equal((await approve(refund.approvalId)).status, 200)
    assert.equal((await getInvoice(inv.id)).paidTotal, 12000, 'approved is not paid out')
    assert.equal((await payOut(refund.id, fx.tokens.scheduler)).error, 'FORBIDDEN')
    const paid = await payOut(refund.id)
    assert.equal(paid.status, 200, paid.error)
    const now = await getInvoice(inv.id)
    assert.equal(now.paidTotal, 9000)
    assert.equal(now.status, 'partially_paid')
  })

  test('are capped at what was received less refunds already in progress', async () => {
    const inv = await fin.invoice()
    assert.equal((await askRefund(inv.id, 1)).error, 'REFUND_EXCEEDS_REFUNDABLE')
    await fin.pay(inv.id, 5000)
    await askRefund(inv.id, 3000)
    const second = await askRefund(inv.id, 2500)
    assert.equal(second.error, 'REFUND_EXCEEDS_REFUNDABLE')
    assert.equal((second.body as { refundable: number }).refundable, 2000)
    const listed = (await call(fx.app, fx.tokens.viewer, 'GET', `/finance/refunds?invoiceId=${inv.id}`)).body as { refundable: number }
    assert.equal(listed.refundable, 2000)
  })

  test('a payment voided after approval stops the payout', async () => {
    const inv = await fin.invoice()
    const { payment } = (await fin.pay(inv.id, 4000)) as { payment: { id: string } }
    const refund = (await askRefund(inv.id, 4000)).body as Refund
    await approve(refund.approvalId)
    await call(fx.app, fx.tokens.admin, 'POST', `/finance/payments/${payment.id}/void`, { reason: 'Entered twice' })
    const res = await payOut(refund.id)
    assert.equal(res.error, 'REFUND_EXCEEDS_REFUNDABLE')
  })

  test('the requester cannot approve; rejection and withdrawal close the refund', async () => {
    const inv = await fin.invoice()
    await fin.pay(inv.id, 6000)
    const a = (await askRefund(inv.id, 1000)).body as Refund
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', `/approvals/${a.approvalId}/approve`, {})).error, 'FORBIDDEN')
    await call(fx.app, fx.tokens.admin, 'POST', `/approvals/${a.approvalId}/reject`, { comment: 'No grounds' })
    const b = (await askRefund(inv.id, 1000)).body as Refund
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', `/finance/refunds/${b.id}/cancel`, {})).status, 200)
    const docs = await withTenant(fx.tenantId, (ctx) => ctx.refunds.find({ invoiceId: inv.id }).sort({ createdAt: 1 }).toArray())
    assert.deepEqual(docs.map((d) => d.status), ['rejected', 'cancelled'])
    const approval = await withTenant(fx.tenantId, (ctx) => ctx.approvalRequests.findOne({ _id: b.approvalId }))
    assert.equal(approval?.status, 'cancelled')
  })

  test('a void invoice can still be refunded', async () => {
    const inv = await fin.invoice()
    await fin.pay(inv.id, 12000)
    await call(fx.app, fx.tokens.admin, 'POST', `/finance/invoices/${inv.id}/void`, { reason: 'Student withdrew' })
    assert.equal((await askRefund(inv.id, 12000)).status, 201)
  })
})

describe('allocation across invoices', () => {
  async function twoInvoices() {
    const first = await fin.invoice({ dueDate: '2026-09-01' })
    const second = await fin.invoice({ studentId: first.studentId, dueDate: '2026-10-01' })
    return { studentId: first.studentId, first, second }
  }
  const payStudent = (studentId: string, body: Record<string, unknown>, token = fx.tokens.scheduler) =>
    call(fx.app, token, 'POST', `/finance/students/${studentId}/payments`, {
      method: 'cash',
      paidAt: '2026-09-10',
      payerName: 'Parent',
      ...body,
    })

  test('fills the oldest due first, one receipt for the whole amount', async () => {
    const { studentId, first, second } = await twoInvoices()
    const res = await payStudent(studentId, { amount: 15000 })
    assert.equal(res.status, 201, res.error)
    const body = res.body as { payments: { invoiceId: string; amount: number; batchId: string }[]; receipt: { amount: number; allocations: { invoiceId: string; amount: number }[] } }
    assert.deepEqual(body.payments.map((p) => [p.invoiceId, p.amount]), [
      [first.id, 12000],
      [second.id, 3000],
    ])
    assert.equal(new Set(body.payments.map((p) => p.batchId)).size, 1)
    assert.equal(body.receipt.amount, 15000)
    assert.equal(body.receipt.allocations.length, 2)
    assert.equal((await getInvoice(first.id)).status, 'paid')
    assert.equal((await getInvoice(second.id)).outstanding, 9000)
  })

  test('never more than is outstanding; an explicit split must add up', async () => {
    const { studentId, first, second } = await twoInvoices()
    const over = await payStudent(studentId, { amount: 25000 })
    assert.equal(over.error, 'AMOUNT_EXCEEDS_OUTSTANDING')
    assert.equal((over.body as { outstanding: number }).outstanding, 24000)
    const mismatch = await payStudent(studentId, { amount: 5000, allocations: [{ invoiceId: first.id, amount: 4000 }] })
    assert.equal(mismatch.error, 'ALLOCATION_MISMATCH')
    const res = await payStudent(studentId, {
      amount: 5000,
      allocations: [
        { invoiceId: second.id, amount: 4000 },
        { invoiceId: first.id, amount: 1000 },
      ],
    })
    assert.equal(res.status, 201, res.error)
    assert.equal((await getInvoice(second.id)).paidTotal, 4000)
    const open = (await call(fx.app, fx.tokens.viewer, 'GET', `/finance/students/${studentId}/open-invoices`)).body as { invoices: { id: string; outstanding: number }[] }
    assert.deepEqual(open.invoices.map((i) => [i.id, i.outstanding]), [
      [first.id, 11000],
      [second.id, 8000],
    ])
  })

  test('another student invoice cannot be allocated', async () => {
    const { studentId } = await twoInvoices()
    const stranger = await fin.invoice()
    const res = await payStudent(studentId, { amount: 100, allocations: [{ invoiceId: stranger.id, amount: 100 }] })
    assert.equal(res.error, 'ALLOCATION_EXCEEDS_OUTSTANDING')
  })
})

describe('confirmations', () => {
  test('a payment awaiting confirmation counts for nothing and has no receipt until confirmed', async () => {
    const inv = await fin.invoice()
    const res = (await fin.pay(inv.id, 5000, { method: 'cheque', awaitingConfirmation: true })) as {
      payment: { id: string; confirmation: string }
      receipt: unknown
    }
    assert.equal(res.payment.confirmation, 'pending')
    assert.equal(res.receipt, null)
    assert.equal((await getInvoice(inv.id)).paidTotal, 0)
    const queue = (await call(fx.app, fx.tokens.viewer, 'GET', '/finance/payments?confirmation=pending')).body as { payments: { id: string }[] }
    assert.ok(queue.payments.some((p) => p.id === res.payment.id))

    const url = `/finance/payments/${res.payment.id}/confirm`
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', url, {})).error, 'FORBIDDEN')
    const done = await call(fx.app, fx.tokens.admin, 'POST', url, {})
    assert.equal(done.status, 200, done.error)
    assert.ok((done.body as { receipt: { receiptNumber: string } }).receipt.receiptNumber)
    assert.equal((await getInvoice(inv.id)).paidTotal, 5000)
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, {})).error, 'NOT_PENDING')
  })

  test('a bounced cheque is rejected with a reason and never counts', async () => {
    const inv = await fin.invoice()
    const res = (await fin.pay(inv.id, 5000, { method: 'cheque', awaitingConfirmation: true })) as { payment: { id: string } }
    const url = `/finance/payments/${res.payment.id}/reject`
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, {})).error, 'REASON_REQUIRED')
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, { reason: 'Cheque bounced' })).status, 200)
    const now = await getInvoice(inv.id)
    assert.equal(now.paidTotal, 0)
    assert.equal(now.status, 'open')
    // Nor can it be refunded.
    assert.equal((await askRefund(inv.id, 100)).error, 'REFUND_EXCEEDS_REFUNDABLE')
  })

  test('a pending payment is not offered again for allocation', async () => {
    const inv = await fin.invoice()
    await fin.pay(inv.id, 10000, { awaitingConfirmation: true })
    const open = (await call(fx.app, fx.tokens.viewer, 'GET', `/finance/students/${inv.studentId}/open-invoices`)).body as { invoices: { outstanding: number }[] }
    assert.equal(open.invoices[0]?.outstanding, 2000)
  })
})
