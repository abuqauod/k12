// SAMS 1.11: centralized settings — lookup lists (lazy defaults, manage
// permission, deactivate-not-delete), payment methods read from them, and
// the school-editable organization profile.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'

let fx: Fixture
let other: Fixture
let schoolAdmin: string
let branchAdmin: string

before(async () => {
  fx = await createFixture()
  other = await createFixture()
  schoolAdmin = (await member(fx.tenantId, 'viewer', null, 'school_admin')).token
  branchAdmin = (await member(fx.tenantId, 'viewer', [fx.branchA], 'branch_admin')).token
})
after(async () => {
  await other.close()
  await fx.close()
})

type Item = { code: string; active: boolean; builtIn: boolean }
const list = async (token: string, kind = 'paymentMethod', inactive = false) =>
  (await call(fx.app, token, 'GET', `/settings/lookups/${kind}${inactive ? '?includeInactive=1' : ''}`)).body as {
    items: Item[]
  }

async function invoice(): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await withTenant(fx.tenantId, (ctx) =>
    ctx.invoices.insertOne({
      _id: id,
      invoiceNumber: `INV-${id.slice(0, 6)}`,
      branchId: fx.branchA,
      studentId: randomUUID(),
      status: 'open',
      lineItems: [{ id: randomUUID(), label: 'Fee', labelAr: null, sourceFeeItemId: null, amount: 5000, discount: null, netAmount: 5000 }],
      total: 5000,
      createdAt: now,
      updatedAt: now,
    } as never),
  )
  return id
}

const pay = (method: string, invoiceId: string) =>
  call(fx.app, fx.tokens.scheduler, 'POST', `/finance/invoices/${invoiceId}/payments`, {
    amount: 100,
    method,
    paidAt: '2026-09-01',
    payerName: 'Parent',
  })

describe('lookup lists', () => {
  test('defaults seed lazily, once, even under parallel first reads', async () => {
    const [a, b] = await Promise.all([list(fx.tokens.viewer), list(fx.tokens.viewer)])
    assert.equal(a.items.length, 5)
    assert.equal(b.items.length, 5)
    const stored = await withTenant(fx.tenantId, (ctx) => ctx.lookups.countDocuments({ kind: 'paymentMethod' }))
    assert.equal(stored, 5)
    assert.ok((await list(fx.tokens.viewer, 'documentCategory')).items.some((i) => i.code === 'birth_certificate'))
  })

  test('only settings.manage may change a list; a branch admin may not', async () => {
    const body = { code: 'wallet', label: 'Mobile wallet' }
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', '/settings/lookups/paymentMethod', body)).error, 'FORBIDDEN')
    assert.equal((await call(fx.app, branchAdmin, 'POST', '/settings/lookups/paymentMethod', body)).error, 'FORBIDDEN')
    const created = await call(fx.app, schoolAdmin, 'POST', '/settings/lookups/paymentMethod', body)
    assert.equal(created.status, 201)
    const dup = await call(fx.app, schoolAdmin, 'POST', '/settings/lookups/paymentMethod', body)
    assert.equal(dup.error, 'LOOKUP_CODE_TAKEN')
  })

  test('codes are immutable, unknown kinds 404, and the last active entry stays', async () => {
    const rename = await call(fx.app, schoolAdmin, 'PATCH', '/settings/lookups/documentCategory/photo', { code: 'pic' })
    assert.equal(rename.error, 'INVALID_BODY')
    assert.equal((await call(fx.app, fx.tokens.viewer, 'GET', '/settings/lookups/nope')).error, 'UNKNOWN_LOOKUP_KIND')

    const codes = (await list(schoolAdmin, 'documentCategory')).items.map((i) => i.code)
    for (const code of codes.slice(1)) {
      assert.equal(
        (await call(fx.app, schoolAdmin, 'PATCH', `/settings/lookups/documentCategory/${code}`, { active: false })).status,
        200,
      )
    }
    const last = await call(fx.app, schoolAdmin, 'PATCH', `/settings/lookups/documentCategory/${codes[0]}`, { active: false })
    assert.equal(last.error, 'LAST_ACTIVE_LOOKUP')
    assert.equal((await list(schoolAdmin, 'documentCategory', true)).items.length, codes.length, 'nothing deleted')
  })

  test('lists are per school', async () => {
    const theirs = (await call(other.app, other.tokens.viewer, 'GET', '/settings/lookups/paymentMethod')).body as {
      items: Item[]
    }
    assert.ok(!theirs.items.some((i) => i.code === 'wallet'))
  })

  test('changes are audited', async () => {
    const audit = await withTenant(fx.tenantId, (ctx) => ctx.auditLog.findOne({ action: 'lookup.create' }))
    assert.equal(audit?.entityId, 'paymentMethod:wallet')
  })
})

describe('payment methods come from the list', () => {
  test('a custom active method is accepted; a deactivated one is refused for new payments only', async () => {
    const inv = await invoice()
    assert.equal((await pay('wallet', inv)).status, 201)
    assert.equal((await pay('not_a_method', inv)).error, 'INVALID_PAYMENT_METHOD')

    const off = await call(fx.app, schoolAdmin, 'PATCH', '/settings/lookups/paymentMethod/wallet', { active: false })
    assert.equal(off.status, 200)
    assert.equal((await pay('wallet', inv)).error, 'INVALID_PAYMENT_METHOD')

    const history = await call(fx.app, fx.tokens.scheduler, 'GET', `/finance/payments?invoiceId=${inv}`)
    const payments = (history.body as { payments: { id: string; method: string }[] }).payments
    const old = payments.find((p) => p.method === 'wallet')
    assert.ok(old, 'the earlier wallet payment still lists')
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', `/finance/payments/${old.id}/void`, { reason: 'test' })).status, 200)
  })
})

describe('organization profile', () => {
  test('a school edits its contact details, never its subscription', async () => {
    const ok = await call(fx.app, schoolAdmin, 'PATCH', '/tenant', { profile: { phone: '+962 6 000 0000', nameAr: 'مدرسة' } })
    assert.equal(ok.status, 200)
    for (const field of ['plan', 'validUntil', 'status', 'name', 'seats']) {
      const res = await call(fx.app, schoolAdmin, 'PATCH', '/tenant', { [field]: 'x', profile: {} })
      assert.equal(res.error, 'INVALID_BODY', `${field} must be vendor-only`)
    }
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'PATCH', '/tenant', { profile: { phone: '1' } })).error, 'FORBIDDEN')
    const read = (await call(fx.app, fx.tokens.viewer, 'GET', '/tenant')).body as { profile: { phone: string } }
    assert.equal(read.profile.phone, '+962 6 000 0000')
    const audit = await withTenant(fx.tenantId, (ctx) => ctx.auditLog.findOne({ action: 'tenant.profile.update' }))
    assert.ok(audit)
  })
})
