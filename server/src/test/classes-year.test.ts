// SAMS 12 (pilot): a class made without a year belongs to the current one.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { call, createFixture, type Fixture } from './harness.js'

let fx: Fixture
before(async () => {
  fx = await createFixture()
})
after(async () => {
  await fx.close()
})

test('classes made without a year join the current year, one or many', async () => {
  const year = await call(fx.app, fx.tokens.admin, 'POST', '/academic-years', { name: '2026–2027', startDate: '2026-08-20', endDate: '2027-06-30' })
  const yearId = (year.body as { id: string }).id
  const one = await call(fx.app, fx.tokens.admin, 'POST', '/classes', { branchId: fx.branchA, gradeLevel: 'Grade 1', name: 'A' })
  assert.equal(one.status, 201, one.error)
  const many = await call(fx.app, fx.tokens.admin, 'POST', '/classes/bulk', { branchId: fx.branchA, gradeLevel: 'Grade 2', sections: ['A', 'B'] })
  assert.equal(many.status, 201, many.error)
  const again = await call(fx.app, fx.tokens.admin, 'POST', '/classes/bulk', { branchId: fx.branchA, gradeLevel: 'Grade 2', sections: ['A', 'B', 'C'] })
  assert.equal(again.status, 201, again.error)
  const classes = await withTenant(fx.tenantId, (ctx) => ctx.classes.find({}).toArray())
  assert.equal(classes.length, 4)
  assert.ok(classes.every((c) => c.academicYearId === yearId))
})
