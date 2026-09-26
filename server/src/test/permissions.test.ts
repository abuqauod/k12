// Role × route authorization matrix. Pins today's behavior so migrating a
// route's guard (requireRole → requirePermission) or regrouping scope
// bundles can't silently widen or narrow access. "Denied" means the guard
// itself refused (error FORBIDDEN); anything else — 200, 400, 404 — means the
// caller got past authorization, which is all this file asserts.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Role } from '../auth/tokens.js'
import { call, createFixture, ROLES, type Fixture } from './harness.js'
import { PLATFORM_ROUTES, PORTAL_ROUTES, ROUTES, X } from './routeMatrix.js'

const RANK: Record<Role, number> = { viewer: 0, scheduler: 1, admin: 2, owner: 3 }

let fx: Fixture
before(async () => {
  fx = await createFixture()
})
after(async () => {
  await fx.close()
})

describe('role × route matrix', () => {
  for (const [method, path, minimum] of ROUTES) {
    test(`${method} ${path} needs ${minimum}`, async () => {
      for (const role of ROLES) {
        const body = method === 'GET' || method === 'DELETE' ? undefined : {}
        const res = await call(fx.app, fx.tokens[role], method, path, body)
        // Fastify's own 404 (unregistered route) — a typo'd row, not a pass.
        assert.notEqual(res.error, 'Not Found', `no such route: ${method} ${path}`)
        const allowed = RANK[role] >= RANK[minimum]
        if (allowed) assert.notEqual(res.error, 'FORBIDDEN', `${role} should pass (got ${res.status})`)
        else assert.equal(res.error, 'FORBIDDEN', `${role} should be denied (got ${res.status} ${res.error})`)
      }
    })
  }
})

describe('parent portal routes', () => {
  for (const [method, path] of PORTAL_ROUTES) {
    test(`${method} ${path} refuses every staff rank`, async () => {
      for (const role of ROLES) {
        const res = await call(fx.app, fx.tokens[role], method, path, method === 'GET' ? undefined : {})
        assert.notEqual(res.error, 'Not Found', `no such route: ${method} ${path}`)
        assert.equal(res.error, 'FORBIDDEN', `${role} should be denied`)
      }
    })
  }
})

describe('platform console routes', () => {
  for (const [method, path] of PLATFORM_ROUTES) {
    test(`${method} ${path} refuses every school rank, owner included`, async () => {
      for (const role of ROLES) {
        const res = await call(fx.app, fx.tokens[role], method, path, method === 'GET' || method === 'DELETE' ? undefined : {})
        assert.notEqual(res.error, 'Not Found', `no such route: ${method} ${path}`)
        assert.equal(res.error, 'FORBIDDEN', `${role} should be denied`)
      }
    })
  }
})

describe('admin-only fields inside scheduler routes', () => {
  const parent = { fullName: 'Test Parent', primaryPhone: '0790000000' }

  test('portal flag on a new parent needs admin', async () => {
    const body = { ...parent, portalAccessEnabled: true }
    const s = await call(fx.app, fx.tokens.scheduler, 'POST', '/parents', body)
    assert.equal(s.error, 'PORTAL_FLAG_REQUIRES_ADMIN')
    const a = await call(fx.app, fx.tokens.admin, 'POST', '/parents', body)
    assert.equal(a.status, 201)
  })

  test('portal flag on a parent update needs admin', async () => {
    const s = await call(fx.app, fx.tokens.scheduler, 'PATCH', `/parents/${X}`, { portalAccessEnabled: false })
    assert.equal(s.error, 'PORTAL_FLAG_REQUIRES_ADMIN')
    const a = await call(fx.app, fx.tokens.admin, 'PATCH', `/parents/${X}`, { portalAccessEnabled: false })
    assert.notEqual(a.error, 'PORTAL_FLAG_REQUIRES_ADMIN')
  })

  test('financial responsibility on a link needs admin', async () => {
    const body = { studentId: X, relationshipType: 'father', financialResponsibility: true }
    const s = await call(fx.app, fx.tokens.scheduler, 'POST', `/parents/${X}/links`, body)
    assert.equal(s.error, 'FINANCIAL_FLAG_REQUIRES_ADMIN')
    const a = await call(fx.app, fx.tokens.admin, 'POST', `/parents/${X}/links`, body)
    assert.notEqual(a.error, 'FINANCIAL_FLAG_REQUIRES_ADMIN')
    const u = await call(fx.app, fx.tokens.scheduler, 'PATCH', `/parents/${X}/links/${X}`, { portalAccess: true })
    assert.equal(u.error, 'PORTAL_FLAG_REQUIRES_ADMIN')
  })

  test('invoice line discount needs admin', async () => {
    const body = { label: 'Books', amount: 1000, discount: { type: 'amount', value: 100 } }
    const url = `/finance/invoices/${X}/line-items`
    const s = await call(fx.app, fx.tokens.scheduler, 'POST', url, body)
    assert.equal(s.error, 'DISCOUNT_REQUIRES_ADMIN')
    const a = await call(fx.app, fx.tokens.admin, 'POST', url, body)
    assert.notEqual(a.error, 'DISCOUNT_REQUIRES_ADMIN')
    const p = await call(fx.app, fx.tokens.scheduler, 'PATCH', `${url}/${X}`, { discount: body.discount })
    assert.equal(p.error, 'DISCOUNT_REQUIRES_ADMIN')
  })
})
