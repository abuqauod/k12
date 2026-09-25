// Permanent student delete (password re-check, finance guard, cascade,
// audit) and the school-app login fix for platform admins.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { hash } from '@node-rs/argon2'
import { withTenant, withoutTenant } from '../db.js'
import { signAccessToken } from '../auth/tokens.js'
import { call, createFixture, type Fixture } from './harness.js'

let fx: Fixture
const PASSWORD = 'correct horse battery'
let adminToken: string
let adminEmail: string

/** An admin with a real password (the harness members have none). */
async function adminWithPassword(): Promise<void> {
  const userId = randomUUID()
  adminEmail = `admin-${userId.slice(0, 8)}@test.local`
  await withoutTenant(async (db) => {
    await db.users.insertOne({
      _id: userId,
      email: adminEmail,
      passwordHash: await hash(PASSWORD),
      displayName: 'Admin',
      displayNameAr: null,
      active: true,
      emailVerified: true,
      platformAdmin: false,
      createdAt: new Date(),
      lastLoginAt: null,
    })
    await db.memberships.insertOne({
      _id: `${fx.tenantId}:${userId}`,
      tenantId: fx.tenantId,
      userId,
      role: 'admin',
      branchIds: null,
      createdAt: new Date(),
    })
  })
  adminToken = await signAccessToken({ sub: userId, email: adminEmail, tenantId: fx.tenantId, role: 'admin' })
}

async function student(branchId = fx.branchA): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await withTenant(fx.tenantId, async (ctx) => {
    await ctx.students.insertOne({
      _id: id,
      studentNumber: `S-${id.slice(0, 8)}`,
      givenName: 'Test',
      familyName: 'Student',
      branchId,
      classId: '',
      status: 'enrolled',
      createdAt: now,
      updatedAt: now,
    } as never)
    await ctx.enrollments.insertOne({ _id: randomUUID(), studentId: id, branchId, status: 'active' } as never)
  })
  return id
}

const del = (token: string, id: string, password?: string) =>
  call(fx.app, token, 'DELETE', `/students/${id}`, password === undefined ? {} : { password })

before(async () => {
  fx = await createFixture()
  await adminWithPassword()
})
after(async () => {
  await fx.close()
})

describe('permanent student delete', () => {
  test('needs students.delete, a password, and the right password', async () => {
    const id = await student()
    assert.equal((await del(fx.tokens.scheduler, id, PASSWORD)).error, 'FORBIDDEN')
    assert.equal((await del(adminToken, id)).error, 'PASSWORD_REQUIRED')
    assert.equal((await del(adminToken, id, 'wrong')).error, 'INVALID_PASSWORD')
    const still = await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: id }))
    assert.ok(still, 'nothing deleted on a failed attempt')
  })

  test('deletes the student with enrollments and links, and audits a snapshot', async () => {
    const id = await student()
    const res = await del(adminToken, id, PASSWORD)
    assert.equal(res.status, 204)
    const left = await withTenant(fx.tenantId, async (ctx) => ({
      student: await ctx.students.findOne({ _id: id }),
      enrollments: await ctx.enrollments.countDocuments({ studentId: id }),
      audit: await ctx.auditLog.findOne({ action: 'student.delete', entityId: id }),
    }))
    assert.equal(left.student, null)
    assert.equal(left.enrollments, 0)
    assert.equal((left.audit?.meta.before as { student: { _id: string } }).student._id, id)
  })

  test('a student with financial history is refused', async () => {
    const id = await student()
    await withTenant(fx.tenantId, (ctx) =>
      ctx.invoices.insertOne({ _id: randomUUID(), studentId: id, branchId: fx.branchA, status: 'open' } as never),
    )
    assert.equal((await del(adminToken, id, PASSWORD)).error, 'HAS_FINANCIAL_HISTORY')
  })

  test('another branch student is refused for a branch-confined admin', async () => {
    const id = await student(fx.branchB)
    await withoutTenant((db) =>
      db.memberships.updateOne({ _id: `${fx.tenantId}:${JSON.parse(atob(adminToken.split('.')[1]!)).sub}` }, { $set: { branchIds: [fx.branchA] } }),
    )
    assert.equal((await del(adminToken, id, PASSWORD)).error, 'BRANCH_FORBIDDEN')
    await withoutTenant((db) =>
      db.memberships.updateOne({ _id: `${fx.tenantId}:${JSON.parse(atob(adminToken.split('.')[1]!)).sub}` }, { $set: { branchIds: null } }),
    )
  })
})

describe('school-app login for a platform admin', () => {
  test('the app gets a school session; the console keeps the platform session', async () => {
    await withoutTenant((db) => db.users.updateOne({ email: adminEmail }, { $set: { platformAdmin: true } }))
    const login = (body: object) =>
      fx.app.inject({ method: 'POST', url: '/auth/login', payload: { email: adminEmail, password: PASSWORD, ...body } })

    const app = (await login({ context: 'app' })).json() as { tenant: { id: string } | null }
    assert.equal(app.tenant?.id, fx.tenantId)

    const consoleRes = (await login({})).json() as { tenant: unknown; platformAdmin?: boolean }
    assert.equal(consoleRes.tenant, null)
    assert.equal(consoleRes.platformAdmin, true)
  })
})
