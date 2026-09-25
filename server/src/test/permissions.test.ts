// Role × route authorization matrix. Pins today's behavior so migrating a
// route's guard (requireRole → requirePermission) or regrouping scope
// bundles can't silently widen or narrow access. "Denied" means the guard
// itself refused (error FORBIDDEN); anything else — 200, 400, 404 — means the
// caller got past authorization, which is all this file asserts.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Role } from '../auth/tokens.js'
import { call, createFixture, ROLES, type Fixture } from './harness.js'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const X = 'does-not-exist'

// [method, path, minimum role that passes the guard]
const ROUTES: [Method, string, Role][] = [
  ['GET', '/academic-years', 'viewer'],
  ['POST', '/academic-years', 'scheduler'],
  ['POST', `/academic-years/${X}/set-current`, 'scheduler'],
  ['GET', '/branches', 'viewer'],
  ['GET', '/classes', 'viewer'],
  ['POST', '/classes', 'admin'],
  ['POST', '/classes/bulk', 'admin'],
  ['PATCH', `/classes/${X}`, 'admin'],
  ['DELETE', `/classes/${X}`, 'admin'],
  ['GET', '/datasets/timetable', 'viewer'],
  ['PUT', '/datasets/timetable', 'scheduler'],
  ['GET', '/datasets/timetable/versions', 'viewer'],
  ['GET', '/datasets/timetable/versions/1', 'viewer'],
  ['GET', `/students/${X}/enrollments`, 'viewer'],
  ['POST', `/students/${X}/transfer`, 'admin'],
  ['POST', `/students/${X}/withdraw`, 'admin'],
  ['POST', '/enrollments/bulk-assign', 'admin'],
  ['POST', `/students/${X}/enrollments`, 'admin'],
  ['POST', `/enrollments/${X}/activate`, 'admin'],
  ['POST', `/enrollments/${X}/cancel`, 'admin'],
  ['GET', '/finance/fee-structures', 'viewer'],
  ['GET', `/finance/fee-structures/${X}`, 'viewer'],
  ['POST', '/finance/fee-structures', 'admin'],
  ['PATCH', `/finance/fee-structures/${X}`, 'admin'],
  ['POST', `/finance/fee-structures/${X}/deactivate`, 'admin'],
  ['GET', '/finance/invoices', 'viewer'],
  ['GET', `/finance/invoices/${X}`, 'viewer'],
  ['POST', '/finance/invoices', 'scheduler'],
  ['POST', `/finance/invoices/${X}/line-items`, 'scheduler'],
  ['PATCH', `/finance/invoices/${X}/line-items/${X}`, 'scheduler'],
  ['DELETE', `/finance/invoices/${X}/line-items/${X}`, 'scheduler'],
  ['POST', `/finance/invoices/${X}/void`, 'admin'],
  ['GET', '/finance/payments', 'viewer'],
  ['POST', `/finance/invoices/${X}/payments`, 'scheduler'],
  ['POST', `/finance/payments/${X}/void`, 'admin'],
  ['GET', '/finance/receipts', 'viewer'],
  ['GET', `/finance/receipts/${X}`, 'viewer'],
  ['GET', `/finance/students/${X}/balance`, 'viewer'],
  ['GET', '/memberships', 'admin'],
  ['POST', '/memberships/invite', 'admin'],
  ['PATCH', `/memberships/${X}`, 'admin'],
  ['PATCH', `/memberships/${X}/branches`, 'admin'],
  ['DELETE', `/memberships/${X}`, 'admin'],
  ['GET', `/branches/${X}/notification-settings`, 'admin'],
  ['PUT', `/branches/${X}/notification-settings`, 'admin'],
  ['GET', `/branches/${X}/calendar`, 'admin'],
  ['PUT', `/branches/${X}/calendar`, 'admin'],
  ['GET', '/notifications', 'admin'],
  ['POST', '/notifications/run', 'scheduler'],
  ['GET', '/parents', 'viewer'],
  ['GET', `/parents/${X}`, 'viewer'],
  ['POST', '/parents', 'scheduler'],
  ['PATCH', `/parents/${X}`, 'scheduler'],
  ['POST', `/parents/${X}/archive`, 'admin'],
  ['POST', `/parents/${X}/reactivate`, 'admin'],
  ['POST', `/parents/${X}/links`, 'scheduler'],
  ['PATCH', `/parents/${X}/links/${X}`, 'scheduler'],
  ['POST', `/parents/${X}/links/${X}/deactivate`, 'admin'],
  ['GET', '/students', 'viewer'],
  ['GET', `/students/${X}`, 'viewer'],
  ['POST', '/students', 'scheduler'],
  ['PATCH', `/students/${X}`, 'scheduler'],
  ['GET', `/students/${X}/family`, 'viewer'],
  ['GET', '/attendance', 'viewer'],
  ['GET', `/attendance/student/${X}`, 'viewer'],
  ['GET', `/attendance/student/${X}/corrections`, 'viewer'],
  ['PUT', '/attendance', 'scheduler'],
  ['GET', '/transport/buses', 'viewer'],
  ['POST', '/transport/buses', 'scheduler'],
  ['PATCH', `/transport/buses/${X}`, 'scheduler'],
  ['POST', `/transport/buses/${X}/deactivate`, 'scheduler'],
  ['GET', '/transport/stops', 'viewer'],
  ['POST', '/transport/stops', 'scheduler'],
  ['PATCH', `/transport/stops/${X}`, 'scheduler'],
  ['POST', `/transport/stops/${X}/deactivate`, 'scheduler'],
  ['GET', `/branches/${X}/transport-settings`, 'viewer'],
  ['PUT', `/branches/${X}/transport-settings`, 'admin'],
  ['GET', '/audit-log', 'admin'],
  ['GET', '/audit-log/export', 'admin'],
  ['GET', '/search?q=test', 'viewer'],
  ['GET', '/tenant', 'viewer'],
  ['GET', '/admissions/applications', 'scheduler'],
  ['GET', `/admissions/applications/${X}`, 'scheduler'],
  ['POST', '/admissions/applications', 'scheduler'],
  ['PATCH', `/admissions/applications/${X}`, 'scheduler'],
  ['POST', `/admissions/applications/${X}/submit`, 'scheduler'],
  ['POST', `/admissions/applications/${X}/review`, 'scheduler'],
  ['POST', `/admissions/applications/${X}/withdraw`, 'scheduler'],
  ['POST', `/admissions/applications/${X}/convert`, 'scheduler'],
  ['GET', `/documents?ownerType=student&ownerId=${X}`, 'viewer'],
  ['GET', `/documents/${X}/versions`, 'viewer'],
  ['POST', `/documents/${X}/link`, 'viewer'],
  // admissions.manage (scheduler) may upload an applicant's documents;
  // which owners it covers is checked in the handler (documents.test.ts).
  ['POST', '/documents', 'scheduler'],
  ['POST', `/documents/${X}/versions`, 'scheduler'],
  ['POST', `/documents/${X}/verify`, 'admin'],
  ['POST', `/documents/${X}/archive`, 'admin'],
]

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
