// SAMS 1.12: audit IP / user agent / reason, required reasons on sensitive
// actions, record search, and the dashboard summary.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import { config } from '../config.js'
import { call, createFixture, member, type Fixture } from './harness.js'

let fx: Fixture
let invoiceA: string
let invoiceB: string

async function invoice(branchId: string, number: string): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await withTenant(fx.tenantId, (ctx) =>
    ctx.invoices.insertOne({
      _id: id,
      invoiceNumber: number,
      branchId,
      studentId: randomUUID(),
      status: 'open',
      lineItems: [],
      total: 0,
      createdAt: now,
      updatedAt: now,
    } as never),
  )
  return id
}

before(async () => {
  fx = await createFixture()
  invoiceA = await invoice(fx.branchA, 'INV-ZQ-A1')
  invoiceB = await invoice(fx.branchB, 'INV-ZQ-B1')
})
after(async () => {
  await fx.close()
})

describe('audit context', () => {
  test('rows record the client IP, user agent and stated reason', async () => {
    const res = await fx.app.inject({
      method: 'POST',
      url: `${config.routePrefix}/finance/invoices/${invoiceA}/void`,
      headers: {
        authorization: `Bearer ${fx.tokens.admin}`,
        'user-agent': 'AuditTest/1.0',
        'x-forwarded-for': '203.0.113.7',
      },
      payload: { reason: 'Issued twice by mistake' },
    })
    assert.equal(res.statusCode, 200)
    const row = await withTenant(fx.tenantId, (ctx) => ctx.auditLog.findOne({ action: 'invoice.void', entityId: invoiceA }))
    assert.equal(row?.ip, '203.0.113.7')
    assert.equal(row?.userAgent, 'AuditTest/1.0')
    assert.equal(row?.reason, 'Issued twice by mistake')
  })
})

describe('required reasons', () => {
  const routes: [string, string, () => string][] = [
    ['POST', 'invoice void', () => `/finance/invoices/${invoiceB}/void`],
    ['POST', 'payment void', () => `/finance/payments/${randomUUID()}/void`],
    ['POST', 'parent archive', () => `/parents/${randomUUID()}/archive`],
    ['POST', 'link deactivate', () => `/parents/${randomUUID()}/links/${randomUUID()}/deactivate`],
  ]
  for (const [method, name, url] of routes) {
    test(`${name} needs a reason`, async () => {
      const missing = await call(fx.app, fx.tokens.admin, method as 'POST', url(), {})
      assert.equal(missing.error, 'REASON_REQUIRED')
      const tooShort = await call(fx.app, fx.tokens.admin, method as 'POST', url(), { reason: ' x ' })
      assert.equal(tooShort.error, 'REASON_REQUIRED')
    })
  }

  test('a withdrawal needs a reason; a graduation does not', async () => {
    const url = `/students/${randomUUID()}/withdraw`
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, { status: 'withdrawn' })).error, 'REASON_REQUIRED')
    assert.notEqual((await call(fx.app, fx.tokens.admin, 'POST', url, { status: 'graduated' })).error, 'REASON_REQUIRED')
  })
})

describe('record search', () => {
  const found = async (token: string, q: string) =>
    ((await call(fx.app, token, 'GET', `/search?q=${encodeURIComponent(q)}`)).body as {
      results: { type: string; id: string }[]
    }).results

  test('invoices need finance.read and stay in the caller branches', async () => {
    const wide = await found(fx.tokens.admin, 'INV-ZQ')
    assert.ok(wide.some((r) => r.type === 'invoice' && r.id === invoiceA))
    assert.ok(wide.some((r) => r.type === 'invoice' && r.id === invoiceB))

    const scoped = await found(fx.scopedToken, 'INV-ZQ')
    assert.ok(scoped.some((r) => r.id === invoiceA))
    assert.ok(!scoped.some((r) => r.id === invoiceB), 'another branch invoice stays hidden')

    const reception = (await member(fx.tenantId, 'viewer', null, 'reception')).token
    assert.ok(!(await found(reception, 'INV-ZQ')).some((r) => r.type === 'invoice'), 'no finance.read, no invoices')
  })
})

describe('dashboard summary', () => {
  test('sections follow permissions', async () => {
    const admin = (await call(fx.app, fx.tokens.admin, 'GET', '/dashboard/summary')).body as Record<string, unknown>
    assert.ok(admin.parents && admin.enrollments && admin.approvals, 'admin sees every section')

    const hr = (await member(fx.tenantId, 'viewer', null, 'hr')).token
    const hrSummary = (await call(fx.app, hr, 'GET', '/dashboard/summary')).body as Record<string, unknown>
    assert.equal(hrSummary.approvals, undefined, 'hr decides no approval type')
  })

  test('a branch outside the caller scope is refused', async () => {
    const res = await call(fx.app, fx.scopedToken, 'GET', `/dashboard/summary?branchId=${fx.branchB}`)
    assert.equal(res.error, 'BRANCH_FORBIDDEN')
  })

  test('parent counts: a family with no link is incomplete', async () => {
    const created = await call(fx.app, fx.tokens.admin, 'POST', '/parents', { fullName: 'Zed Parent', primaryPhone: '0790001111' })
    assert.equal(created.status, 201)
    const summary = (await call(fx.app, fx.tokens.admin, 'GET', '/dashboard/summary')).body as {
      parents: { total: number; incomplete: number }
    }
    assert.ok(summary.parents.total >= 1)
    assert.ok(summary.parents.incomplete >= 1)
  })
})
