// A member confined to branch A must not read or write branch B's records,
// while a tenant-wide member of the same role can. Fixture records are
// inserted directly (through the tenant scope) so this file tests the
// isolation boundary, not the create endpoints.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import { call, createFixture, type Fixture } from './harness.js'

let fx: Fixture
let classB: string
let studentB: string
let feeStructureB: string

before(async () => {
  fx = await createFixture()
  classB = randomUUID()
  studentB = randomUUID()
  feeStructureB = randomUUID()
  const now = new Date()
  // Only the fields the guarded reads touch; casts keep the fixture minimal.
  await withTenant(fx.tenantId, async (ctx) => {
    await ctx.classes.insertOne({ _id: classB, branchId: fx.branchB, createdAt: now } as never)
    await ctx.students.insertOne({
      _id: studentB,
      branchId: fx.branchB,
      classId: classB,
      status: 'enrolled',
      givenName: 'B',
      familyName: 'Student',
      createdAt: now,
      updatedAt: now,
    } as never)
    await ctx.feeStructures.insertOne({ _id: feeStructureB, branchId: fx.branchB, createdAt: now } as never)
  })
})
after(async () => {
  await fx.close()
})

describe('branch-A scheduler vs branch B', () => {
  const cases: [string, 'GET' | 'PUT' | 'POST', () => string, () => unknown][] = [
    ['list students in B', 'GET', () => `/students?branchId=${fx.branchB}`, () => undefined],
    ['read a B student', 'GET', () => `/students/${studentB}`, () => undefined],
    ['read B attendance', 'GET', () => `/attendance?classId=${classB}&date=2026-09-01`, () => undefined],
    ['read a B student attendance', 'GET', () => `/attendance/student/${studentB}`, () => undefined],
    [
      'mark a B student',
      'PUT',
      () => '/attendance',
      () => ({ date: '2026-09-01', records: [{ studentId: studentB, status: 'present' }] }),
    ],
    ['list B fee structures', 'GET', () => `/finance/fee-structures?branchId=${fx.branchB}`, () => undefined],
    ['list B invoices', 'GET', () => `/finance/invoices?branchId=${fx.branchB}`, () => undefined],
    [
      'invoice from a B fee structure',
      'POST',
      () => '/finance/invoices',
      () => ({ feeStructureId: feeStructureB, studentId: studentB }),
    ],
  ]

  for (const [name, method, url, body] of cases) {
    test(name, async () => {
      const scoped = await call(fx.app, fx.scopedToken, method, url(), body())
      assert.equal(scoped.status, 403, `scoped: ${scoped.status} ${scoped.error}`)
      assert.equal(scoped.error, 'BRANCH_FORBIDDEN')
      const wide = await call(fx.app, fx.tokens.scheduler, method, url(), body())
      assert.notEqual(wide.error, 'BRANCH_FORBIDDEN', `tenant-wide: ${wide.status}`)
    })
  }
})
