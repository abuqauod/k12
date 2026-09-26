// Backlog: configurable numbering. Each numbered record takes the school's
// format; the count never goes back; numbers already used are skipped.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { formatNumber } from '../numbering.js'
import { call, createFixture, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
const year = new Date().getUTCFullYear()

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
})
after(async () => {
  await fx.close()
})

const put = (kind: string, body: Record<string, unknown>, token = fx.tokens.admin) =>
  call(fx.app, token, 'PUT', `/settings/numbering/${kind}`, { prefix: 'INV', separator: '-', padding: 6, includeYear: false, ...body })

describe('numbering', () => {
  test('formats', () => {
    assert.equal(formatNumber({ prefix: 'REC', separator: '/', padding: 5, includeYear: true }, 45, 2026), 'REC/2026/00045')
    assert.equal(formatNumber({ prefix: '', separator: '-', padding: 4, includeYear: false }, 7, 2026), '0007')
  })

  test('built-in formats until the school changes them', async () => {
    const res = await call(fx.app, fx.tokens.viewer, 'GET', '/settings/numbering')
    assert.equal(res.status, 200)
    const kinds = (res.body as unknown as { kinds: { kind: string; example: string }[] }).kinds
    assert.equal(kinds.find((k) => k.kind === 'invoiceNumber')?.example, 'INV-000001')
    const inv = await fin.invoice()
    assert.equal(inv.invoiceNumber, 'INV-000001')
  })

  test('a new format applies to the next record; the year restarts the count', async () => {
    const res = await put('invoiceNumber', { prefix: 'F', separator: '/', padding: 4, includeYear: true })
    assert.equal(res.status, 200, res.error)
    assert.equal((res.body as { example: string }).example, `F/${year}/0001`)
    assert.equal((await fin.invoice()).invoiceNumber, `F/${year}/0001`)
    assert.equal((await fin.invoice()).invoiceNumber, `F/${year}/0002`)
  })

  test('the next number moves forward only', async () => {
    assert.equal((await put('invoiceNumber', { prefix: 'F', separator: '/', padding: 4, includeYear: true, nextNumber: 500 })).status, 200)
    assert.equal((await fin.invoice()).invoiceNumber, `F/${year}/0500`)
    const back = await put('invoiceNumber', { prefix: 'F', separator: '/', padding: 4, includeYear: true, nextNumber: 10 })
    assert.equal(back.error, 'NUMBER_GOES_BACK')
  })

  test('student numbers: typed, or the next free one when left blank', async () => {
    await put('studentNumber', { prefix: 'S', padding: 3 })
    const create = (studentNumber?: string) =>
      call(fx.app, fx.tokens.admin, 'POST', '/students', {
        ...(studentNumber !== undefined ? { studentNumber } : {}),
        givenName: 'Nour',
        familyName: 'Test',
        classId: fin.classOf[fx.branchA],
      })
    // Someone typed the number the counter would give next: it is skipped.
    assert.equal((await create('S-001')).status, 201)
    const auto = await create()
    assert.equal(auto.status, 201, auto.error)
    const s = await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: (auto.body as { id: string }).id }))
    assert.equal(s!.studentNumber, 'S-002')
    assert.equal((await create('')).status, 201)
    assert.equal((await create('S-001')).error, 'STUDENT_NUMBER_TAKEN')
  })

  test('only settings managers change it, and bad formats are refused', async () => {
    assert.equal((await put('invoiceNumber', {}, fx.tokens.scheduler)).error, 'FORBIDDEN')
    assert.equal((await put('invoiceNumber', { prefix: 'IN V' })).error, 'INVALID_BODY')
    assert.equal((await put('invoiceNumber', { padding: 0 })).error, 'INVALID_BODY')
    assert.equal((await put('nope', {})).error, 'UNKNOWN_NUMBER_KIND')
    const audits = await withTenant(fx.tenantId, (ctx) => ctx.auditLog.countDocuments({ action: 'numbering.update' }))
    assert.ok(audits >= 3)
  })
})
