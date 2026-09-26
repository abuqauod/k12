// SAMS 13.1: a school's plan decides which modules answer and how many
// students and campuses it may have.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant, withoutTenant } from '../db.js'
import { signAccessToken } from '../auth/tokens.js'
import { PLANS, moduleOfRoute, termPrice, yearlyPrice } from '../billing/plans.js'
import { call, createFixture, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
let vendor = ''

const setTenant = (fields: Record<string, unknown>) =>
  withoutTenant((db) => db.tenants.updateOne({ _id: fx.tenantId }, { $set: fields }))

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
  const userId = randomUUID()
  const email = `vendor-${userId.slice(0, 6)}@vendor.test`
  await withoutTenant((db) =>
    db.users.insertOne({
      _id: userId,
      email,
      passwordHash: null,
      displayName: 'Vendor',
      displayNameAr: null,
      active: true,
      emailVerified: true,
      platformAdmin: true,
      createdAt: new Date(),
      lastLoginAt: null,
    }),
  )
  vendor = await signAccessToken({ sub: userId, email, platformAdmin: true })
})
after(() => fx.close())

test('routes map to the modules sold', () => {
  assert.equal(moduleOfRoute('/grades/sheet'), 'grades')
  assert.equal(moduleOfRoute('/portal/children/:id/report-cards/:termId'), 'grades')
  assert.equal(moduleOfRoute('/ops/library/loans'), 'library')
  assert.equal(moduleOfRoute('/ops/transport/trips'), 'transport')
  assert.equal(moduleOfRoute('/ops/assets'), 'operations')
  assert.equal(moduleOfRoute('/portal/children/:id/pay'), 'onlinePayments')
  assert.equal(moduleOfRoute('/portal/children/:id/wallet/topup'), 'canteen')
  assert.equal(moduleOfRoute('/reports/schedules'), 'scheduledReports')
  // The core stays open on every plan.
  for (const core of ['/students', '/finance/invoices', '/portal/children/:id/finance', '/reports/:key', '/attendance', '/parents'])
    assert.equal(moduleOfRoute(core), null, core)
})

test('prices: per student with a yearly minimum; a month costs a twelfth plus the uplift', () => {
  assert.equal(yearlyPrice(PLANS.professional, 'JOD', 50), PLANS.professional.price!.JOD.minimumYear)
  assert.equal(yearlyPrice(PLANS.professional, 'USD', 400), 400 * 2000)
  assert.equal(termPrice(PLANS.professional, 'USD', 400, 'month'), Math.round((400 * 2000 * 1.2) / 12))
})

test('a module outside the plan answers 402 and disappears from /auth/me', async () => {
  // Plans stored before the catalog existed ('test' here) keep everything.
  const before = await call(fx.app, fx.tokens.admin, 'GET', '/grades/settings')
  assert.equal(before.status, 200, before.error)

  await setTenant({ plan: 'essentials' })
  const refused = await call(fx.app, fx.tokens.admin, 'GET', '/grades/settings')
  assert.equal(refused.status, 402)
  assert.deepEqual(refused.body, { error: 'PLAN_EXCLUDES_MODULE', module: 'grades', plan: 'essentials' })
  // The core still works.
  assert.equal((await call(fx.app, fx.tokens.admin, 'GET', '/finance/invoices')).status, 200)
  const me = await call(fx.app, fx.tokens.admin, 'GET', '/auth/me')
  assert.deepEqual((me.body as { modules: string[] }).modules, [])

  // An add-on opens one module on top of the plan.
  await setTenant({ addons: ['grades'] })
  assert.equal((await call(fx.app, fx.tokens.admin, 'GET', '/grades/settings')).status, 200)
  assert.equal((await call(fx.app, fx.tokens.admin, 'GET', '/canteen/products')).status, 402)
  await setTenant({ plan: 'test', addons: [] })
})

test('students beyond the plan’s limit are refused', async () => {
  await fin.student()
  const enrolled = await withTenant(fx.tenantId, (ctx) => ctx.students.countDocuments({ status: 'enrolled' }))
  await setTenant({ plan: 'trial', limits: { students: enrolled } })
  const res = await call(fx.app, fx.tokens.admin, 'POST', '/students', {
    studentNumber: `L-${randomUUID().slice(0, 8)}`,
    givenName: 'Over',
    familyName: 'Limit',
    classId: fin.classOf[fx.branchA],
  })
  assert.equal(res.status, 402)
  assert.deepEqual(res.body, { error: 'PLAN_LIMIT_STUDENTS', limit: enrolled, enrolled })
  await setTenant({ plan: 'test', limits: {} })
  await fin.student()
})

test('the console sets plan, add-ons and limits, and a campus over the count is refused', async () => {
  const bad = await call(fx.app, vendor, 'PATCH', `/admin/tenants/${fx.tenantId}`, { plan: 'gold' })
  assert.equal(bad.status, 400)
  const set = await call(fx.app, vendor, 'PATCH', `/admin/tenants/${fx.tenantId}`, {
    plan: 'professional',
    addons: ['canteen'],
    billing: { currency: 'JOD', term: 'year', students: 300, email: null, country: 'JO' },
  })
  assert.equal(set.status, 200, set.error)
  const view = set.body as { modules: string[]; limits: { branches: number } }
  assert.ok(view.modules.includes('canteen') && view.modules.includes('grades') && !view.modules.includes('operations'))
  assert.equal(view.limits.branches, 3)

  // Two campuses already; professional allows three.
  const add = (code: string) =>
    call(fx.app, vendor, 'POST', `/admin/tenants/${fx.tenantId}/branches`, { name: `Campus ${code}`, code: `${code}-${randomUUID().slice(0, 4)}` })
  assert.equal((await add('c')).status, 201)
  const over = await add('d')
  assert.equal(over.status, 409)
  assert.equal((over.body as { error: string }).error, 'PLAN_LIMIT_BRANCHES')

  const detail = await call(fx.app, vendor, 'GET', `/admin/tenants/${fx.tenantId}`)
  assert.equal((detail.body as { usage: { branches: number } }).usage.branches, 3)
  await setTenant({ plan: 'test', addons: [] })
})

test('past its grace days a school reads but cannot write; later it is locked out', async () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  await setTenant({ validUntil: daysAgo(10), graceDays: 5 })
  assert.equal((await call(fx.app, fx.tokens.admin, 'GET', '/finance/invoices')).status, 200)
  const write = await call(fx.app, fx.tokens.admin, 'POST', '/students', { givenName: 'X', familyName: 'Y', classId: fin.classOf[fx.branchA] })
  assert.equal(write.status, 402)
  assert.equal((write.body as { error: string }).error, 'SUBSCRIPTION_EXPIRED')
  const me = await call(fx.app, fx.tokens.admin, 'GET', '/auth/me')
  assert.equal((me.body as { subscription: { state: string } }).subscription.state, 'readOnly')

  await setTenant({ validUntil: daysAgo(100) })
  assert.equal((await call(fx.app, fx.tokens.admin, 'GET', '/finance/invoices')).status, 402)

  await setTenant({ validUntil: daysAgo(2), graceDays: 5 })
  const grace = await call(fx.app, fx.tokens.admin, 'GET', '/auth/me')
  assert.equal((grace.body as { subscription: { state: string } }).subscription.state, 'grace')
  await setTenant({ validUntil: null, graceDays: 0 })
})
