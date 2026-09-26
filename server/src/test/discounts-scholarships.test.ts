// SAMS 3.2: named discount types applied as invoice adjustments (directly
// or through an approval), and formal scholarships — requested with a
// reason and documents, approved by someone else, applied to the
// student's invoices for the year (including later ones), revoked.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { withTenant } from '../db.js'
import { call, createFixture, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
let sibling = ''
let early = ''

type Inv = {
  id: string
  subtotal: number
  total: number
  status: string
  adjustments: { id: string; source: string; label: string; amount: number }[]
}
type Sch = { id: string; status: string; approvalId: string }

const getInvoice = async (id: string) => (await call(fx.app, fx.tokens.viewer, 'GET', `/finance/invoices/${id}`)).body as Inv
const approve = (approvalId: string, token = fx.tokens.admin) =>
  call(fx.app, token, 'POST', `/approvals/${approvalId}/approve`, {})

async function discountType(name: string, type: string, value: number) {
  const res = await call(fx.app, fx.tokens.admin, 'POST', '/finance/discount-types', { name, type, value })
  assert.equal(res.status, 201, res.error)
  return (res.body as { id: string }).id
}

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
  sibling = await discountType('Sibling', 'percent', 10)
  early = await discountType('Early payment', 'amount', 500)
})
after(async () => {
  await fx.close()
})

describe('discount types', () => {
  test('are a price list managed by fee-structure managers; percents stay within 100', async () => {
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', '/finance/discount-types', { name: 'X', type: 'amount', value: 1 })).error, 'FORBIDDEN')
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', '/finance/discount-types', { name: 'X', type: 'percent', value: 120 })).error, 'VALUE_OUT_OF_RANGE')
    const list = (await call(fx.app, fx.tokens.viewer, 'GET', '/finance/discount-types')).body as { discountTypes: { name: string }[] }
    assert.deepEqual(list.discountTypes.map((d) => d.name), ['Early payment', 'Sibling'])
  })

  test('apply in order to the lines net sum; once each', async () => {
    const inv = await fin.invoice()
    const res = await call(fx.app, fx.tokens.admin, 'POST', `/finance/invoices/${inv.id}/adjustments`, { discountTypeId: sibling })
    assert.equal(res.status, 201, res.error)
    await call(fx.app, fx.tokens.admin, 'POST', `/finance/invoices/${inv.id}/adjustments`, { discountTypeId: early })
    const now = await getInvoice(inv.id)
    assert.equal(now.subtotal, 12000)
    assert.deepEqual(now.adjustments.map((a) => a.amount), [1200, 500])
    assert.equal(now.total, 10300)
    const again = await call(fx.app, fx.tokens.admin, 'POST', `/finance/invoices/${inv.id}/adjustments`, { discountTypeId: sibling })
    assert.equal(again.error, 'ALREADY_APPLIED')

    // A later line re-prices the percent.
    await call(fx.app, fx.tokens.scheduler, 'POST', `/finance/invoices/${inv.id}/line-items`, { label: 'Trip', amount: 3000 })
    assert.equal((await getInvoice(inv.id)).total, 15000 - 1500 - 500)
  })

  test('cannot take an invoice below what was paid; removal needs a reason', async () => {
    const inv = await fin.invoice()
    await fin.pay(inv.id, 11900)
    const res = await call(fx.app, fx.tokens.admin, 'POST', `/finance/invoices/${inv.id}/adjustments`, { discountTypeId: early })
    assert.equal(res.error, 'DISCOUNT_BELOW_PAID')

    const other = await fin.invoice()
    await call(fx.app, fx.tokens.admin, 'POST', `/finance/invoices/${other.id}/adjustments`, { discountTypeId: early })
    const adj = (await getInvoice(other.id)).adjustments[0]!
    const url = `/finance/invoices/${other.id}/adjustments/${adj.id}`
    assert.equal((await call(fx.app, fx.tokens.admin, 'DELETE', url, {})).error, 'REASON_REQUIRED')
    assert.equal((await call(fx.app, fx.tokens.admin, 'DELETE', url, { reason: 'Applied by mistake' })).status, 200)
    assert.equal((await getInvoice(other.id)).total, 12000)
  })

  test('someone who may only edit lines asks through an approval', async () => {
    const inv = await fin.invoice()
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', `/finance/invoices/${inv.id}/adjustments`, { discountTypeId: sibling })).error, 'FORBIDDEN')
    const req = await call(fx.app, fx.tokens.scheduler, 'POST', '/approvals', {
      type: 'finance.invoiceDiscount',
      entityId: inv.id,
      payload: { discountTypeId: sibling },
    })
    assert.equal(req.status, 201, req.error)
    assert.equal((await approve((req.body as { id: string }).id)).status, 200)
    assert.equal((await getInvoice(inv.id)).total, 10800)
  })
})

describe('scholarships', () => {
  const request = (studentId: string, body: Record<string, unknown> = {}, token = fx.tokens.scheduler) =>
    call(fx.app, token, 'POST', '/finance/scholarships', {
      studentId,
      name: 'Merit award',
      type: 'percent',
      value: 25,
      reason: 'Top of the class',
      ...body,
    })

  test('are raised with an approval; nothing applies until someone else approves', async () => {
    const inv = await fin.invoice()
    const res = await request(inv.studentId)
    assert.equal(res.status, 201, res.error)
    const sch = res.body as Sch
    assert.equal(sch.status, 'pending')
    assert.equal((await getInvoice(inv.id)).total, 12000)

    // Evidence attaches to the scholarship; the requester may upload it.
    const upload = await fx.app.inject({
      method: 'POST',
      url: `${config.routePrefix}/documents?ownerType=scholarship&ownerId=${sch.id}&category=financial&fileName=income.png`,
      headers: { authorization: `Bearer ${fx.tokens.scheduler}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
    })
    assert.equal(upload.statusCode, 201, upload.body)

    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', `/approvals/${sch.approvalId}/approve`, {})).error, 'FORBIDDEN')
    assert.equal((await approve(sch.approvalId)).status, 200)
    const now = await getInvoice(inv.id)
    assert.equal(now.total, 9000)
    assert.equal(now.adjustments[0]?.source, 'scholarship')

    // A later invoice for the same student and year carries it from the start.
    const later = await fin.invoice({ studentId: inv.studentId })
    assert.equal(later.total, 9000)
  })

  test('a rejection leaves the scholarship rejected', async () => {
    const student = await fin.student()
    const sch = (await request(student)).body as Sch
    const res = await call(fx.app, fx.tokens.admin, 'POST', `/approvals/${sch.approvalId}/reject`, { comment: 'Not eligible' })
    assert.equal(res.status, 200, res.error)
    const doc = await withTenant(fx.tenantId, (ctx) => ctx.scholarships.findOne({ _id: sch.id }))
    assert.equal(doc?.status, 'rejected')
  })

  test('applies over what was already paid, leaving a credit', async () => {
    const inv = await fin.invoice()
    await fin.pay(inv.id, 12000)
    const sch = (await request(inv.studentId, { type: 'amount', value: 2000 })).body as Sch
    await approve(sch.approvalId)
    const now = (await call(fx.app, fx.tokens.viewer, 'GET', `/finance/invoices/${inv.id}`)).body as Inv & { outstanding: number }
    assert.equal(now.total, 10000)
    assert.equal(now.outstanding, -2000)
    assert.equal(now.status, 'paid')
  })

  test('revoking takes it off unpaid invoices only, and off new ones', async () => {
    const unpaid = await fin.invoice()
    const partly = await fin.invoice({ studentId: unpaid.studentId })
    await fin.pay(partly.id, 1000)
    const sch = (await request(unpaid.studentId)).body as Sch
    await approve(sch.approvalId)
    const url = `/finance/scholarships/${sch.id}/revoke`
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', url, { reason: 'x' })).error, 'FORBIDDEN')
    const res = await call(fx.app, fx.tokens.admin, 'POST', url, { reason: 'Left the programme' })
    assert.equal(res.status, 200, res.error)
    assert.equal((res.body as { invoicesUpdated: number }).invoicesUpdated, 1)
    assert.equal((await getInvoice(unpaid.id)).total, 12000)
    assert.equal((await getInvoice(partly.id)).total, 9000)
    assert.equal((await fin.invoice({ studentId: unpaid.studentId })).total, 12000)
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, { reason: 'Again please' })).error, 'NOT_ACTIVE')

    // A scholarship adjustment is not removed as a plain discount.
    const adj = (await getInvoice(partly.id)).adjustments[0]!
    const del = await call(fx.app, fx.tokens.admin, 'DELETE', `/finance/invoices/${partly.id}/adjustments/${adj.id}`, { reason: 'Not needed' })
    assert.equal(del.error, 'USE_SCHOLARSHIP_REVOKE')
  })

  test('are branch-isolated', async () => {
    const inB = await fin.student(fx.branchB)
    assert.equal((await request(inB, {}, fx.scopedToken)).error, 'BRANCH_FORBIDDEN')
    await request(inB)
    const listed = (await call(fx.app, fx.scopedToken, 'GET', '/finance/scholarships')).body as { scholarships: { studentId: string }[] }
    assert.ok(!listed.scholarships.some((s) => s.studentId === inB))
  })
})
