// Backlog: printable ID cards — the right people, with their numbers as
// barcodes, inside the caller's branches.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { code128Values } from '../idcards/code128.js'
import { config } from '../config.js'
import { createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
const get = (token: string, path: string) =>
  fx.app.inject({ method: 'GET', url: config.routePrefix + path, headers: { authorization: `Bearer ${token}` } })

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
})
after(async () => {
  await fx.close()
})

describe('id cards', () => {
  test('the check symbol follows Code 128', () => {
    // "PJJ123C": start B (104), data, then (104 + Σ value × position) mod 103.
    const v = code128Values('PJJ123C')
    const check = (104 + v.slice(1, -2).reduce((s, x, i) => s + x * (i + 1), 0)) % 103
    assert.equal(v.at(-2), check)
    assert.equal(v[0], 104)
    assert.equal(v.at(-1), 106)
  })

  test('students of a class, with name, number and barcode; a confined member stays in their branch', async () => {
    const a = await fin.student(fx.branchA)
    await fin.student(fx.branchB)
    const s = await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: a }))
    const res = await get(fx.tokens.viewer, `/id-cards/students?classId=${fin.classOf[fx.branchA]}&layout=card`)
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'] as string, /text\/html/)
    assert.ok(res.body.includes(s!.studentNumber))
    assert.equal((res.body.match(/<article class="card">/g) ?? []).length, 1)
    assert.match(res.body, /<svg[^>]*aria-label/)
    assert.match(res.body, /size: 85\.6mm 54mm/)
    const scoped = await get(fx.scopedToken, `/id-cards/students?branchId=${fx.branchB}`)
    assert.equal(scoped.statusCode, 403)
    const mine = await get(fx.scopedToken, '/id-cards/students')
    assert.ok(!mine.body.includes('Branch B'))
  })

  test('staff cards need HR access', async () => {
    const hr = (await member(fx.tenantId, 'viewer', null, 'hr')).token
    const created = await fx.app.inject({
      method: 'POST',
      url: config.routePrefix + '/hr/employees',
      headers: { authorization: `Bearer ${hr}` },
      payload: { branchId: fx.branchA, givenName: 'Rana', familyName: 'Khalil', hireDate: '2024-08-15' },
    })
    assert.equal(created.statusCode, 201, created.body)
    const res = await get(hr, '/id-cards/employees?lang=ar')
    assert.equal(res.statusCode, 200)
    assert.ok(res.body.includes('Rana Khalil'))
    assert.match(res.body, /<html lang="ar" dir="rtl">/)
    assert.equal((await get(fx.tokens.scheduler, '/id-cards/employees')).statusCode, 403)
  })
})
