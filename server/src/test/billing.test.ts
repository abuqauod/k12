// SAMS 13.3 / 13.4: schools are invoiced for their subscription, pay by card
// (the vendor's gateway) or transfer, and paying moves their plan and date.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withoutTenant } from '../db.js'
import { signAccessToken } from '../auth/tokens.js'
import { PLANS } from '../billing/plans.js'
import { nextPeriod, runBillingSweep } from '../billing/service.js'
import { call, createFixture, type Fixture } from './harness.js'

let fx: Fixture
let vendor = ''
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const setTenant = (fields: Record<string, unknown>) =>
  withoutTenant((db) => db.tenants.updateOne({ _id: fx.tenantId }, { $set: fields }))
const tenant = () => withoutTenant((db) => db.tenants.findOne({ _id: fx.tenantId }))

type Invoice = { id: string; number: string; total: number; subtotal: number; tax: number; status: string; periodStart: string; periodEnd: string; plan: string }

before(async () => {
  fx = await createFixture()
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

test('a trial school picks a plan and pays by card; the plan and date follow', async () => {
  await setTenant({ plan: 'trial', validUntil: iso(5), graceDays: 0, billing: { currency: 'JOD', term: 'year', students: 120, email: null, country: 'JO' } })
  const q = await call(fx.app, fx.tokens.viewer, 'POST', '/subscription/quote', { plan: 'professional', term: 'year' })
  assert.equal(q.status, 200, q.error)
  const quoted = q.body as { subtotal: number; tax: number; taxRate: number; periodStart: string }
  // 120 students is under the minimum; Jordan's 16% on top; from today.
  assert.equal(quoted.subtotal, PLANS.professional.price!.JOD.minimumYear)
  assert.deepEqual([quoted.taxRate, quoted.tax], [16, Math.round(quoted.subtotal * 0.16)])
  assert.equal(quoted.periodStart, iso(0))

  // Viewers look; only an admin buys.
  assert.equal((await call(fx.app, fx.tokens.viewer, 'POST', '/subscription/invoices', { plan: 'professional', term: 'year' })).status, 403)
  const first = await call(fx.app, fx.tokens.owner, 'POST', '/subscription/invoices', { plan: 'essentials', term: 'year' })
  assert.equal(first.status, 201, first.error)
  // Changing its mind replaces its own unpaid invoice.
  const made = await call(fx.app, fx.tokens.owner, 'POST', '/subscription/invoices', { plan: 'professional', term: 'year' })
  const invoice = made.body as Invoice
  const firstNow = await withoutTenant((db) => db.subscriptionInvoices.findOne({ _id: (first.body as Invoice).id }))
  assert.equal(firstNow!.status, 'void')

  const pay = await call(fx.app, fx.tokens.owner, 'POST', `/subscription/invoices/${invoice.id}/pay`, {})
  assert.equal(pay.status, 200, pay.error)
  const { redirectUrl, checkoutId } = pay.body as { redirectUrl: string; checkoutId: string }
  assert.match(redirectUrl, new RegExp(`/billing/test/${checkoutId}$`))
  const picked = await call(fx.app, '', 'POST', `/billing/test/${checkoutId}`, { outcome: 'paid' })
  assert.equal(picked.status, 303)
  const back = await call(fx.app, '', 'GET', `/billing/return/${checkoutId}`)
  assert.equal(back.status, 303)

  const status = await call(fx.app, fx.tokens.viewer, 'GET', `/subscription/checkouts/${checkoutId}`)
  assert.equal((status.body as { status: string }).status, 'paid')
  const t = await tenant()
  assert.deepEqual([t!.plan, t!.validUntil, t!.graceDays], ['professional', invoice.periodEnd, 14])
  const paid = await withoutTenant((db) => db.subscriptionInvoices.findOne({ _id: invoice.id }))
  assert.deepEqual([paid!.status, paid!.paidBy], ['paid', 'card'])
  // Coming back again changes nothing.
  await call(fx.app, '', 'GET', `/billing/return/${checkoutId}`)
  assert.equal((await tenant())!.validUntil, invoice.periodEnd)
})

test('a lapsed school, reading only, still sees what it owes and can pay', async () => {
  await setTenant({ plan: 'essentials', validUntil: iso(-30), graceDays: 14 })
  assert.equal((await call(fx.app, fx.tokens.owner, 'POST', '/students', { givenName: 'A', familyName: 'B', classId: 'x' })).status, 402)
  const sub = await call(fx.app, fx.tokens.owner, 'GET', '/subscription')
  assert.equal(sub.status, 200, sub.error)
  assert.equal((sub.body as { state: string }).state, 'readOnly')
  const made = await call(fx.app, fx.tokens.owner, 'POST', '/subscription/invoices', { plan: 'essentials', term: 'month' })
  assert.equal(made.status, 201, made.error)
  // A lapsed school's new period starts today, not in the past.
  assert.equal((made.body as Invoice).periodStart, iso(0))
})

test('the console invoices a school and records its bank transfer', async () => {
  await withoutTenant((db) => db.subscriptionInvoices.updateMany({ tenantId: fx.tenantId, status: 'open' }, { $set: { status: 'void' } }))
  await setTenant({ plan: 'professional', validUntil: iso(10), graceDays: 14 })
  const made = await call(fx.app, vendor, 'POST', `/admin/tenants/${fx.tenantId}/subscription-invoices`, {
    plan: 'enterprise',
    term: 'year',
    students: 800,
    currency: 'USD',
    taxRate: 0,
    extraLines: [{ label: 'Onboarding and data import', amount: 50_000 }],
  })
  assert.equal(made.status, 201, made.error)
  const inv = made.body as Invoice
  assert.equal(inv.subtotal, 800 * PLANS.enterprise.price!.USD.perStudentYear + 50_000)
  // It continues from the paid-through date.
  assert.equal(inv.periodStart, iso(11))
  // The school can't replace an invoice the vendor made.
  const own = await call(fx.app, fx.tokens.owner, 'POST', '/subscription/invoices', { plan: 'essentials', term: 'year' })
  assert.equal(own.status, 409)

  const paid = await call(fx.app, vendor, 'POST', `/admin/subscription-invoices/${inv.id}/pay`, { reference: 'TRX-7781' })
  assert.equal(paid.status, 200, paid.error)
  assert.deepEqual([(await tenant())!.plan, (await tenant())!.validUntil], ['enterprise', inv.periodEnd])
  assert.equal((await call(fx.app, vendor, 'POST', `/admin/subscription-invoices/${inv.id}/pay`, { reference: 'again' })).status, 409)
  assert.equal((await call(fx.app, vendor, 'POST', `/admin/subscription-invoices/${inv.id}/void`)).status, 409)

  const print = await call(fx.app, fx.tokens.viewer, 'GET', `/subscription/invoices/${inv.id}/print`)
  assert.equal(print.status, 200)

  const revenue = await call(fx.app, vendor, 'GET', '/admin/revenue')
  assert.equal(revenue.status, 200, revenue.error)
  const r = revenue.body as { collectedMonth: Record<string, number>; schools: { id: string; plan: string }[] }
  assert.ok(r.collectedMonth.USD! >= inv.total)
  assert.equal(r.schools.find((s) => s.id === fx.tenantId)!.plan, 'enterprise')
})

test('the daily sweep issues renewals, reminds about unpaid invoices and ending trials', async () => {
  await withoutTenant((db) => db.subscriptionInvoices.updateMany({ tenantId: fx.tenantId, status: 'open' }, { $set: { status: 'void' } }))
  await setTenant({ plan: 'essentials', validUntil: iso(20), graceDays: 14, billing: { currency: 'SAR', term: 'year', students: 50, email: null, country: 'SA' } })
  await runBillingSweep('http://api.test')
  const renewal = await withoutTenant((db) => db.subscriptionInvoices.findOne({ tenantId: fx.tenantId, status: 'open', source: 'renewal' }))
  assert.ok(renewal)
  assert.equal(renewal.periodStart, nextPeriod({ plan: 'essentials', validUntil: iso(20) }, 'year').periodStart)
  assert.equal(renewal.dueDate, iso(20))
  // A second run issues nothing more.
  await runBillingSweep('http://api.test')
  assert.equal(await withoutTenant((db) => db.subscriptionInvoices.countDocuments({ tenantId: fx.tenantId, status: 'open' })), 1)

  // Overdue by more than a week: the latest reminder only, and only once.
  await withoutTenant((db) => db.subscriptionInvoices.updateOne({ _id: renewal._id }, { $set: { dueDate: iso(-8) } }))
  const sent = await runBillingSweep('http://api.test')
  assert.equal(sent.reminders, 1)
  const reminded = await withoutTenant((db) => db.subscriptionInvoices.findOne({ _id: renewal._id }))
  assert.deepEqual(reminded!.reminders.sort(), ['due', 'due-7', 'overdue-7'])
  assert.equal((await runBillingSweep('http://api.test')).reminders, 0)

  await setTenant({ plan: 'trial', validUntil: iso(7) })
  assert.equal((await runBillingSweep('http://api.test')).reminders, 1)
  assert.deepEqual((await tenant())!.trialReminders, ['trial-7'])
})
