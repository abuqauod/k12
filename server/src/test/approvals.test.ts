// SAMS 1.10: the shared approval engine, exercised through its first real
// consumer (a discount on an invoice line).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'

let fx: Fixture
let financeOfficer: string
let branchBAdmin: string

before(async () => {
  fx = await createFixture()
  financeOfficer = (await member(fx.tenantId, 'viewer', null, 'finance_officer')).token
  branchBAdmin = (await member(fx.tenantId, 'viewer', [fx.branchB], 'branch_admin')).token
})
after(async () => {
  await fx.close()
})

/** A fresh open invoice with one 10,000 line, so tests never share state. */
async function invoice(branchId = fx.branchA): Promise<{ id: string; line: string }> {
  const id = randomUUID()
  const line = randomUUID()
  const now = new Date()
  await withTenant(fx.tenantId, (ctx) =>
    ctx.invoices.insertOne({
      _id: id,
      invoiceNumber: `INV-${id.slice(0, 6)}`,
      branchId,
      studentId: randomUUID(),
      status: 'open',
      lineItems: [{ id: line, label: 'Tuition', labelAr: null, sourceFeeItemId: null, amount: 10000, discount: null, netAmount: 10000 }],
      total: 10000,
      createdAt: now,
      updatedAt: now,
    } as never),
  )
  return { id, line }
}

const discountBody = (inv: { id: string; line: string }, value = 10, type = 'percent') => ({
  type: 'finance.lineDiscount',
  entityId: inv.id,
  payload: { lineItemId: inv.line, discount: { type, value }, expectedAmount: 10000 },
  comment: 'Sibling discount',
})

const request = (token: string, body: unknown) => call(fx.app, token, 'POST', '/approvals', body)
const decide = (token: string, id: string, action: string, comment?: string) =>
  call(fx.app, token, 'POST', `/approvals/${id}/${action}`, comment ? { comment } : {})
const idOf = (res: { body: unknown }) => (res.body as { id: string }).id
const invoiceNow = (id: string) => withTenant(fx.tenantId, (ctx) => ctx.invoices.findOne({ _id: id }))
const statusOf = async (id: string) =>
  (await withTenant(fx.tenantId, (ctx) => ctx.approvalRequests.findOne({ _id: id })))?.status

describe('raising a request', () => {
  test('needs the type request scope', async () => {
    const res = await request(fx.tokens.viewer, discountBody(await invoice()))
    assert.equal(res.error, 'FORBIDDEN')
  })

  test('a scheduler can request; a second pending one for the same line is refused', async () => {
    const inv = await invoice()
    const first = await request(fx.tokens.scheduler, discountBody(inv))
    assert.equal(first.status, 201)
    assert.equal((first.body as { status: string }).status, 'pending')
    const again = await request(fx.tokens.scheduler, discountBody(inv))
    assert.equal(again.error, 'ALREADY_PENDING')
  })

  test('the entity must be in the requester branches', async () => {
    const res = await request(fx.scopedToken, discountBody(await invoice(fx.branchB)))
    assert.equal(res.error, 'BRANCH_FORBIDDEN')
  })

  test('the payload is validated against current data', async () => {
    const res = await request(fx.tokens.scheduler, discountBody(await invoice(), 150))
    assert.equal(res.error, 'DISCOUNT_OUT_OF_RANGE')
    const stale = await request(fx.tokens.scheduler, {
      ...discountBody(await invoice()),
      payload: { lineItemId: 'nope', discount: { type: 'percent', value: 5 }, expectedAmount: 10000 },
    })
    assert.equal(stale.error, 'UNKNOWN_LINE_ITEM')
  })
})

describe('deciding', () => {
  test('approval applies the discount; a second decision is refused', async () => {
    const inv = await invoice()
    const id = idOf(await request(fx.tokens.scheduler, discountBody(inv)))
    const ok = await decide(financeOfficer, id, 'approve', 'OK')
    assert.equal(ok.status, 200)
    const after = await invoiceNow(inv.id)
    assert.equal(after?.lineItems[0]?.netAmount, 9000)
    assert.equal(after?.total, 9000)
    assert.equal((await decide(fx.tokens.admin, id, 'reject', 'late')).error, 'ALREADY_DECIDED')
  })

  test('nobody decides their own request, not even an admin', async () => {
    const id = idOf(await request(fx.tokens.admin, discountBody(await invoice())))
    assert.equal((await decide(fx.tokens.admin, id, 'approve')).error, 'SELF_DECISION')
  })

  test('deciding needs the type decide scope', async () => {
    const id = idOf(await request(fx.tokens.scheduler, discountBody(await invoice())))
    assert.equal((await decide(fx.tokens.viewer, id, 'approve')).error, 'NOT_FOUND')
    const scheduler2 = (await member(fx.tenantId, 'scheduler', null)).token
    assert.equal((await decide(scheduler2, id, 'approve')).error, 'NOT_FOUND')
  })

  test('another branch admin cannot see or decide it', async () => {
    const id = idOf(await request(fx.tokens.scheduler, discountBody(await invoice())))
    assert.equal((await decide(branchBAdmin, id, 'approve')).error, 'NOT_FOUND')
    const queue = await call(fx.app, branchBAdmin, 'GET', '/approvals?view=toDecide')
    assert.ok(!(queue.body as { approvals: { id: string }[] }).approvals.some((a) => a.id === id))
  })

  test('rejecting needs a comment', async () => {
    const id = idOf(await request(fx.tokens.scheduler, discountBody(await invoice())))
    assert.equal((await decide(financeOfficer, id, 'reject')).error, 'COMMENT_REQUIRED')
    assert.equal((await decide(financeOfficer, id, 'reject', 'Not eligible')).status, 200)
    assert.equal(await statusOf(id), 'rejected')
  })

  test('a stale request rolls back: still pending, invoice untouched', async () => {
    const inv = await invoice()
    const id = idOf(await request(fx.tokens.scheduler, discountBody(inv)))
    const patch = await call(fx.app, fx.tokens.admin, 'PATCH', `/finance/invoices/${inv.id}/line-items/${inv.line}`, {
      amount: 12000,
    })
    assert.equal(patch.status, 200)
    assert.equal((await decide(financeOfficer, id, 'approve')).error, 'STALE_REQUEST')
    assert.equal(await statusOf(id), 'pending')
    assert.equal((await invoiceNow(inv.id))?.total, 12000)
  })

  test('a discount below what is already paid is refused', async () => {
    const inv = await invoice()
    await withTenant(fx.tenantId, (ctx) =>
      ctx.payments.insertOne({ _id: randomUUID(), invoiceId: inv.id, amount: 9800, voidedAt: null } as never),
    )
    const id = idOf(await request(fx.tokens.scheduler, discountBody(inv, 5)))
    assert.equal((await decide(financeOfficer, id, 'approve')).error, 'DISCOUNT_BELOW_PAID')
    assert.equal(await statusOf(id), 'pending')
  })

  test('a discount down to exactly what was paid marks the invoice paid', async () => {
    const inv = await invoice()
    await withTenant(fx.tenantId, async (ctx) => {
      await ctx.payments.insertOne({ _id: randomUUID(), invoiceId: inv.id, amount: 9000, voidedAt: null } as never)
      await ctx.invoices.findOneAndUpdate({ _id: inv.id }, { $set: { status: 'partially_paid' } })
    })
    const id = idOf(await request(fx.tokens.scheduler, discountBody(inv, 10)))
    assert.equal((await decide(financeOfficer, id, 'approve')).status, 200)
    const after = await invoiceNow(inv.id)
    assert.deepEqual([after?.total, after?.status], [9000, 'paid'])
  })

  test('a line discounted after the request makes it stale; paid invoices refuse requests', async () => {
    const inv = await invoice()
    const id = idOf(await request(fx.tokens.scheduler, discountBody(inv)))
    const patch = await call(fx.app, fx.tokens.admin, 'PATCH', `/finance/invoices/${inv.id}/line-items/${inv.line}`, {
      discount: { type: 'amount', value: 500 },
    })
    assert.equal(patch.status, 200)
    assert.equal((await decide(financeOfficer, id, 'approve')).error, 'STALE_REQUEST')

    const paid = await invoice()
    await withTenant(fx.tenantId, (ctx) =>
      ctx.invoices.findOneAndUpdate({ _id: paid.id }, { $set: { status: 'paid' } }),
    )
    assert.equal((await request(fx.tokens.scheduler, discountBody(paid))).error, 'INVOICE_PAID')
  })

  test('two simultaneous approvals: exactly one wins', async () => {
    const inv = await invoice()
    const id = idOf(await request(fx.tokens.scheduler, discountBody(inv)))
    const results = await Promise.all([decide(financeOfficer, id, 'approve'), decide(fx.tokens.admin, id, 'approve')])
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
    assert.equal((await invoiceNow(inv.id))?.total, 9000, 'discount applied once')
    const audits = await withTenant(fx.tenantId, (ctx) =>
      ctx.auditLog.countDocuments({ action: 'approval.approve', entityId: id }),
    )
    assert.equal(audits, 1)
  })
})

describe('cancelling and listing', () => {
  test('the requester cancels; a decider without approvals.decide cannot', async () => {
    const id = idOf(await request(fx.tokens.scheduler, discountBody(await invoice())))
    assert.equal((await decide(financeOfficer, id, 'cancel')).error, 'FORBIDDEN')
    assert.equal((await decide(fx.tokens.scheduler, id, 'cancel')).status, 200)
    assert.equal((await decide(financeOfficer, id, 'approve')).error, 'ALREADY_DECIDED')
  })

  test('an approvals.decide holder may cancel someone else request', async () => {
    const id = idOf(await request(fx.tokens.scheduler, discountBody(await invoice())))
    assert.equal((await decide(fx.tokens.admin, id, 'cancel', 'Duplicate')).status, 200)
  })

  test('mine vs to-decide, and every step audited with its branch', async () => {
    const id = idOf(await request(fx.tokens.scheduler, discountBody(await invoice())))
    const mine = await call(fx.app, fx.tokens.scheduler, 'GET', '/approvals?view=mine&status=pending')
    assert.ok((mine.body as { approvals: { id: string }[] }).approvals.some((a) => a.id === id))
    const queue = await call(fx.app, financeOfficer, 'GET', '/approvals?view=toDecide&status=pending')
    assert.ok((queue.body as { approvals: { id: string }[] }).approvals.some((a) => a.id === id))
    assert.equal((await call(fx.app, fx.tokens.viewer, 'GET', `/approvals/${id}`)).error, 'NOT_FOUND')
    const audit = await withTenant(fx.tenantId, (ctx) =>
      ctx.auditLog.findOne({ action: 'approval.request', entityId: id }),
    )
    assert.equal(audit?.branchId, fx.branchA)
  })

  test('a type filter cannot widen the to-decide view', async () => {
    await request(fx.tokens.scheduler, discountBody(await invoice()))
    const reception = (await member(fx.tenantId, 'viewer', null, 'reception')).token
    const res = await call(fx.app, reception, 'GET', '/approvals?view=toDecide&type=finance.lineDiscount')
    assert.equal((res.body as { approvals: unknown[] }).approvals.length, 0)
    const entityRes = await call(fx.app, reception, 'GET', '/approvals?view=all&entity=invoice')
    assert.equal((entityRes.body as { approvals: unknown[] }).approvals.length, 0)
  })

  test('types report what the caller may do', async () => {
    const res = await call(fx.app, fx.tokens.scheduler, 'GET', '/approvals/types')
    const t = (res.body as { types: { type: string; canRequest: boolean; canDecide: boolean }[] }).types.find(
      (x) => x.type === 'finance.lineDiscount',
    )
    assert.deepEqual([t?.canRequest, t?.canDecide], [true, false])
  })
})
