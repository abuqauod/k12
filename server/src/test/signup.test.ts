// SAMS 13.2: a school signs itself up for a trial.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant, withoutTenant } from '../db.js'
import { call, createFixture, type Fixture } from './harness.js'

let fx: Fixture
before(async () => {
  fx = await createFixture()
})
after(() => fx.close())

test('the price list is public', async () => {
  const res = await call(fx.app, '', 'GET', '/public/plans')
  assert.equal(res.status, 200, res.error)
  const body = res.body as { plans: { key: string; price: Record<string, unknown> }[]; currencies: string[] }
  assert.deepEqual(
    body.plans.map((p) => p.key),
    ['essentials', 'professional', 'enterprise'],
  )
  assert.deepEqual(Object.keys(body.plans[0]!.price).sort(), ['AED', 'JOD', 'SAR', 'USD'])
})

test('sign-up opens a trial school with a campus and invites its owner', async () => {
  const email = `owner-${randomUUID().slice(0, 6)}@school.test`
  const res = await call(fx.app, '', 'POST', '/public/signup', {
    schoolName: 'Riyadh Future School',
    ownerName: 'Huda Salem',
    email,
    country: 'sa',
    students: 420,
  })
  assert.equal(res.status, 201, res.error)
  const out = res.body as { slug: string; trialEndsOn: string }
  assert.match(out.slug, /^riyadh-future-school-[0-9a-f]{6}$/)
  const tenant = await withoutTenant((db) => db.tenants.findOne({ slug: out.slug }))
  assert.equal(tenant!.plan, 'trial')
  assert.equal(tenant!.source, 'signup')
  assert.equal(tenant!.validUntil, out.trialEndsOn)
  assert.deepEqual([tenant!.billing!.currency, tenant!.billing!.students], ['SAR', 420])
  const branches = await withTenant(tenant!._id, (ctx) => ctx.branches.find({}).toArray())
  assert.deepEqual(branches.map((b) => [b.name, b.timezone]), [['Main campus', 'Asia/Riyadh']])
  const user = await withoutTenant((db) => db.users.findOne({ email }))
  // Ownership is granted when the emailed invite is accepted.
  const invite = await withoutTenant((db) => db.actionTokens.findOne({ userId: user!._id, purpose: 'invite' }))
  assert.deepEqual([invite?.grant?.tenantId, invite?.grant?.role], [tenant!._id, 'owner'])

  // The same address can't start the clock again.
  const again = await call(fx.app, '', 'POST', '/public/signup', { schoolName: 'Again', ownerName: 'Huda Salem', email, country: 'SA' })
  assert.equal(again.status, 409)
})

test('a filled-in hidden field creates nothing', async () => {
  const before = await withoutTenant((db) => db.tenants.countDocuments({}))
  const res = await call(fx.app, '', 'POST', '/public/signup', {
    schoolName: 'Spam School',
    ownerName: 'Bot',
    email: 'bot@spam.test',
    country: 'JO',
    website: 'http://spam.test',
  })
  assert.equal(res.status, 201)
  assert.equal(await withoutTenant((db) => db.tenants.countDocuments({})), before)
})
