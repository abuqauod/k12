// Named role presets (SAMS 1.8): each preset reaches what its job needs and
// nothing else, preset changes apply immediately, and the grant rules hold.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import type { RoleKey } from '../auth/scopes.js'
import { call, createFixture, member, type Fixture } from './harness.js'

const X = 'does-not-exist'
type Method = 'GET' | 'POST' | 'PATCH'

let fx: Fixture
let studentB: string
const tokens = {} as Record<RoleKey, string>

before(async () => {
  fx = await createFixture()
  const presets: [RoleKey, string[] | null][] = [
    ['school_admin', null],
    ['branch_admin', [fx.branchA]],
    ['registrar', null],
    ['finance_officer', null],
    ['hr', null],
    ['operations', null],
    ['reception', null],
    ['nurse', null],
  ]
  for (const [key, branches] of presets) tokens[key] = (await member(fx.tenantId, 'viewer', branches, key)).token
  studentB = randomUUID()
  await withTenant(fx.tenantId, (ctx) =>
    ctx.students.insertOne({
      _id: studentB,
      branchId: fx.branchB,
      status: 'enrolled',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never),
  )
})
after(async () => {
  await fx.close()
})

const denied = (res: { error?: string }) => res.error === 'FORBIDDEN'

// [preset, method, path, allowed?]
const MATRIX: [RoleKey, Method, string, boolean][] = [
  ['finance_officer', 'POST', `/finance/invoices/${X}/payments`, true],
  ['finance_officer', 'POST', `/finance/invoices/${X}/void`, true],
  ['finance_officer', 'POST', '/finance/fee-structures', true],
  ['finance_officer', 'POST', '/students', false],
  ['finance_officer', 'POST', '/parents', false],
  ['finance_officer', 'GET', '/memberships', false],
  ['registrar', 'POST', '/students', true],
  ['registrar', 'POST', `/students/${X}/withdraw`, true],
  ['registrar', 'POST', '/classes', true],
  ['registrar', 'GET', '/finance/invoices', false],
  ['registrar', 'POST', '/finance/invoices', false],
  ['reception', 'POST', '/students', true],
  ['reception', 'PATCH', `/students/${X}`, false],
  ['reception', 'POST', `/students/${X}/transfer`, false],
  ['reception', 'GET', '/finance/invoices', false],
  ['nurse', 'GET', '/clinic/visits', true],
  ['nurse', 'PUT' as Method, `/students/${X}/health`, true],
  ['nurse', 'POST', '/discipline/incidents', true],
  ['nurse', 'POST', '/students', false],
  ['nurse', 'GET', '/finance/invoices', false],
  ['registrar', 'GET', '/clinic/visits', false],
  ['registrar', 'POST', `/discipline/incidents/${X}/actions`, true],
  ['hr', 'GET', '/students', true],
  ['hr', 'GET', '/finance/invoices', false],
  ['hr', 'POST', '/students', false],
  ['operations', 'POST', '/transport/buses', true],
  ['operations', 'PUT' as Method, `/branches/${X}/transport-settings`, true],
  ['operations', 'POST', '/students', false],
  ['branch_admin', 'POST', '/classes', true],
  ['branch_admin', 'POST', `/finance/payments/${X}/void`, true],
  ['branch_admin', 'GET', '/memberships', false],
  ['branch_admin', 'GET', '/audit-log/export', false],
  ['school_admin', 'GET', '/memberships', true],
  ['school_admin', 'GET', '/audit-log/export', true],
]

describe('preset × route', () => {
  for (const [key, method, path, allowed] of MATRIX) {
    test(`${key} ${allowed ? 'can' : 'cannot'} ${method} ${path}`, async () => {
      const body = method === 'GET' ? undefined : {}
      const res = await call(fx.app, tokens[key], method, path, body)
      assert.notEqual(res.error, 'Not Found', 'no such route')
      assert.equal(denied(res), !allowed, `${res.status} ${res.error}`)
    })
  }

  test('branch_admin stays inside its branches', async () => {
    const res = await call(fx.app, tokens.branch_admin, 'GET', `/students/${studentB}`)
    assert.equal(res.error, 'BRANCH_FORBIDDEN')
  })

  test('a preset holder may not use an admin-only field its preset lacks', async () => {
    const body = { label: 'Books', amount: 1000, discount: { type: 'amount', value: 100 } }
    const res = await call(fx.app, tokens.registrar, 'POST', `/finance/invoices/${X}/line-items`, body)
    assert.equal(res.error, 'FORBIDDEN')
  })
})

describe('/auth/me', () => {
  test('returns the preset and its resolved scopes', async () => {
    const res = await call(fx.app, tokens.finance_officer, 'GET', '/auth/me')
    const body = res.body as { roleKey: string; scopes: string[] }
    assert.equal(body.roleKey, 'finance_officer')
    assert.ok(body.scopes.includes('finance.payment.void'))
    assert.ok(!body.scopes.includes('students.create'))
  })

  test('a rank-only member gets the rank bundle', async () => {
    const res = await call(fx.app, fx.tokens.scheduler, 'GET', '/auth/me')
    const body = res.body as { roleKey: string | null; scopes: string[] }
    assert.equal(body.roleKey, null)
    assert.ok(body.scopes.includes('students.create'))
    assert.ok(!body.scopes.includes('finance.payment.void'))
  })
})

describe('granting roles', () => {
  const owner = () => fx.tokens.owner

  test('a preset change applies on the next request, same token', async () => {
    const m = await member(fx.tenantId, 'viewer', null, 'finance_officer')
    const url = `/finance/invoices/${X}/payments`
    assert.notEqual((await call(fx.app, m.token, 'POST', url, {})).error, 'FORBIDDEN')
    const patch = await call(fx.app, owner(), 'PATCH', `/memberships/${m.userId}`, { roleKey: 'reception' })
    assert.equal(patch.status, 200)
    assert.equal((await call(fx.app, m.token, 'POST', url, {})).error, 'FORBIDDEN')
  })

  test('a plain rank change clears the preset and is audited', async () => {
    const m = await member(fx.tenantId, 'viewer', null, 'registrar')
    const patch = await call(fx.app, owner(), 'PATCH', `/memberships/${m.userId}`, { role: 'viewer' })
    assert.equal(patch.status, 200)
    const list = await call(fx.app, owner(), 'GET', '/memberships')
    const row = (list.body as { members: { userId: string; roleKey: string | null; role: string }[] }).members.find(
      (x) => x.userId === m.userId,
    )
    assert.deepEqual([row?.role, row?.roleKey], ['viewer', null])
    const audit = await withTenant(fx.tenantId, (ctx) =>
      ctx.auditLog.findOne({ action: 'membership.role', entityId: m.userId }),
    )
    assert.equal((audit?.meta.before as { roleKey: string }).roleKey, 'registrar')
  })

  test('role and roleKey together are rejected', async () => {
    const m = await member(fx.tenantId, 'viewer', null)
    const res = await call(fx.app, owner(), 'PATCH', `/memberships/${m.userId}`, { role: 'viewer', roleKey: 'hr' })
    assert.equal(res.error, 'INVALID_BODY')
  })

  test('only an owner grants owner', async () => {
    const m = await member(fx.tenantId, 'viewer', null)
    const res = await call(fx.app, fx.tokens.admin, 'PATCH', `/memberships/${m.userId}`, { role: 'owner' })
    assert.equal(res.error, 'FORBIDDEN')
  })

  test('branch_admin needs branches', async () => {
    const m = await member(fx.tenantId, 'viewer', null)
    const url = `/memberships/${m.userId}`
    const bare = await call(fx.app, owner(), 'PATCH', url, { roleKey: 'branch_admin' })
    assert.equal(bare.error, 'BRANCHES_REQUIRED')
    const unknown = await call(fx.app, owner(), 'PATCH', url, { roleKey: 'branch_admin', branchIds: [X] })
    assert.equal(unknown.error, 'UNKNOWN_BRANCH')
    const ok = await call(fx.app, owner(), 'PATCH', url, { roleKey: 'branch_admin', branchIds: [fx.branchA] })
    assert.equal(ok.status, 200)
    const widen = await call(fx.app, owner(), 'PATCH', `${url}/branches`, { branchIds: null })
    assert.equal(widen.error, 'BRANCHES_REQUIRED')
    const viaRole = await call(fx.app, owner(), 'PATCH', url, { roleKey: 'branch_admin', branchIds: null })
    assert.equal(viaRole.error, 'BRANCHES_REQUIRED')
  })

  test('a demotion applies on the next request, same token', async () => {
    const m = await member(fx.tenantId, 'viewer', null, 'school_admin')
    assert.notEqual((await call(fx.app, m.token, 'GET', '/memberships')).error, 'FORBIDDEN')
    await call(fx.app, owner(), 'PATCH', `/memberships/${m.userId}`, { role: 'viewer' })
    assert.equal((await call(fx.app, m.token, 'GET', '/memberships')).error, 'FORBIDDEN')
  })

  test('the roles catalog lists every preset with its scopes', async () => {
    const res = await call(fx.app, owner(), 'GET', '/memberships/roles')
    const body = res.body as { presets: { key: string; scopes: string[] }[] }
    assert.equal(body.presets.length, 8)
    assert.ok(body.presets.find((p) => p.key === 'nurse')?.scopes.includes('health.write'))
    assert.ok(body.presets.find((p) => p.key === 'reception')?.scopes.includes('students.create'))
  })
})
