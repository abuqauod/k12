// SAMS 12 (pilot): billing a whole grade at once.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
})
after(async () => {
  await fx.close()
})

test('bills every enrolled student of the grade once, preview first', async () => {
  const ids = [await fin.student(fx.branchA), await fin.student(fx.branchA), await fin.student(fx.branchA)]
  await fin.invoice({ studentId: ids[0]! })
  const fee = fin.feeOf[fx.branchA]!
  const preview = await call(fx.app, fx.tokens.scheduler, 'POST', '/finance/invoices/bulk', { feeStructureId: fee, preview: true })
  assert.equal(preview.status, 200, preview.error)
  assert.deepEqual([(preview.body as { toBill: number }).toBill, (preview.body as { alreadyBilled: number }).alreadyBilled], [2, 1])
  assert.equal(await withTenant(fx.tenantId, (ctx) => ctx.invoices.countDocuments({ feeStructureId: fee })), 1, 'preview writes nothing')

  const run = await call(fx.app, fx.tokens.scheduler, 'POST', '/finance/invoices/bulk', { feeStructureId: fee, dueDate: '2026-10-01' })
  assert.equal((run.body as { created: number }).created, 2)
  const again = await call(fx.app, fx.tokens.scheduler, 'POST', '/finance/invoices/bulk', { feeStructureId: fee })
  assert.equal((again.body as { created: number }).created, 0)
  const invs = await withTenant(fx.tenantId, (ctx) => ctx.invoices.find({ feeStructureId: fee }).toArray())
  assert.equal(invs.length, 3)
  assert.ok(invs.filter((i) => i.dueDate === '2026-10-01').length === 2)

  const confined = (await member(fx.tenantId, 'scheduler', [fx.branchB])).token
  assert.equal((await call(fx.app, confined, 'POST', '/finance/invoices/bulk', { feeStructureId: fee, preview: true })).error, 'BRANCH_FORBIDDEN')
  assert.equal((await call(fx.app, fx.tokens.viewer, 'POST', '/finance/invoices/bulk', { feeStructureId: fee })).error, 'FORBIDDEN')
})
