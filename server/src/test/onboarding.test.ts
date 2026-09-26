// SAMS 12 (pilot): a school opened in the console can start at once — it has
// a first campus — and its getting-started checklist follows its data.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withoutTenant } from '../db.js'
import { signAccessToken } from '../auth/tokens.js'
import { call, createFixture, type Fixture } from './harness.js'
import { financeFixture } from './finance-fixture.js'

let fx: Fixture
let vendor = ''

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
after(async () => {
  await fx.close()
})

test('a new school gets its first campus', async () => {
  const slug = `pilot-${randomUUID().slice(0, 6)}`
  const res = await call(fx.app, vendor, 'POST', '/admin/tenants', { slug, name: 'Pilot School', ownerEmail: `owner@${slug}.test` })
  assert.equal(res.status, 201, res.error)
  const id = (res.body as { id: string }).id
  const branches = await withoutTenant((db) => db.branches.find({ tenantId: id }).toArray())
  assert.deepEqual(branches.map((b) => [b.name, b.code]), [['Main campus', 'main']])
  const named = await call(fx.app, vendor, 'POST', '/admin/tenants', {
    slug: `${slug}-b`,
    name: 'Pilot Two',
    ownerEmail: `owner@${slug}-b.test`,
    firstBranch: { name: 'Abdoun', code: 'abdoun' },
  })
  const b2 = await withoutTenant((db) => db.branches.find({ tenantId: (named.body as { id: string }).id }).toArray())
  assert.deepEqual(b2.map((b) => b.code), ['abdoun'])
})

test('the checklist follows the school’s data', async () => {
  const before = (await call(fx.app, fx.tokens.admin, 'GET', '/onboarding')).body as { steps: { key: string; done: boolean }[]; done: number }
  const done = (k: string, body = before) => body.steps.find((s) => s.key === k)!.done
  assert.equal(done('students'), false)
  assert.equal(done('fees'), false)
  const fin = await financeFixture(fx)
  await fin.invoice()
  const after = (await call(fx.app, fx.tokens.viewer, 'GET', '/onboarding')).body as { steps: { key: string; done: boolean }[]; done: number }
  assert.equal(done('students', after), true)
  assert.equal(done('fees', after), true)
  assert.equal(done('invoices', after), true)
  assert.equal(done('team', after), true, 'the fixture has several members')
  assert.ok(after.done > before.done)
})

test('every family of a branch is invited to the portal at once', async () => {
  const { financeFixture: ff } = await import('./finance-fixture.js')
  const { withTenant } = await import('../db.js')
  const fin = await ff(fx)
  const kids = [await fin.student(fx.branchA), await fin.student(fx.branchA), await fin.student(fx.branchB)]
  const mk = async (name: string, email: string | null, studentId: string) => {
    const p = await call(fx.app, fx.tokens.admin, 'POST', '/parents', { fullName: name, primaryPhone: `079${Math.floor(Math.random() * 1e7)}`, email })
    const id = (p.body as { parent: { id: string } }).parent.id
    await call(fx.app, fx.tokens.admin, 'POST', `/parents/${id}/links`, { studentId, relationshipType: 'mother' })
    return id
  }
  const a = await mk('Family A', 'fam-a@example.test', kids[0]!)
  await mk('Family NoEmail', null, kids[1]!)
  await mk('Family B', 'fam-b@example.test', kids[2]!)
  const confined = (await (await import('./harness.js')).member(fx.tenantId, 'admin', [fx.branchA])).token
  const preview = await call(fx.app, confined, 'POST', '/parents/portal/invite-all', { preview: true })
  assert.equal(preview.status, 200, preview.error)
  assert.deepEqual([(preview.body as { toInvite: number }).toInvite, (preview.body as { noEmail: number }).noEmail], [1, 1])
  const run = await call(fx.app, confined, 'POST', '/parents/portal/invite-all', {})
  // No mail server in the test run: the portal is on, but the invite is
  // reported as not emailed rather than counted as sent.
  assert.deepEqual([(run.body as { invited: number }).invited, (run.body as { notEmailed: number }).notEmailed], [0, 1])
  const parentA = await withTenant(fx.tenantId, (ctx) => ctx.parents.findOne({ _id: a }))
  assert.equal(parentA!.portalAccess.enabled, true)
  const link = await withTenant(fx.tenantId, (ctx) => ctx.parentStudentLinks.findOne({ parentId: a }))
  assert.equal(link!.portalAccess, true)
  // Branch B's family was not touched by a branch-A admin.
  const b = await withTenant(fx.tenantId, (ctx) => ctx.parents.findOne({ fullName: 'Family B' }))
  assert.equal(b!.portalAccess?.enabled ?? false, false)
  assert.equal(((await call(fx.app, confined, 'POST', '/parents/portal/invite-all', {})).body as { toInvite: number }).toInvite, 0)
})

test('accepting an invite hands back what the page needs to sign straight in', async () => {
  const { createActionToken } = await import('../auth/actionTokens.js')
  const userId = randomUUID()
  const email = `invitee-${userId.slice(0, 6)}@example.test`
  await withoutTenant((db) =>
    db.users.insertOne({
      _id: userId,
      email,
      passwordHash: null,
      displayName: 'Invitee',
      displayNameAr: null,
      active: false,
      emailVerified: false,
      platformAdmin: false,
      createdAt: new Date(),
      lastLoginAt: null,
    }),
  )
  const token = await createActionToken({
    userId,
    purpose: 'invite',
    grant: { tenantId: fx.tenantId, role: 'viewer', roleKey: 'parent', branchIds: null },
    ttlMs: 60_000,
  })
  const accepted = await call(fx.app, '', 'POST', '/auth/accept-invite', { token, password: 'family-pass-2026' })
  assert.equal(accepted.status, 200, accepted.error)
  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: fx.tenantId }))
  assert.deepEqual(accepted.body, { ok: true, email, tenantSlug: tenant!.slug })
  const login = await call(fx.app, '', 'POST', '/auth/login', { email, password: 'family-pass-2026', tenantSlug: tenant!.slug })
  assert.equal(login.status, 200, login.error)
})
