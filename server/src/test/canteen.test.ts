// SAMS 11.4: the canteen and students' wallets — top-ups, the till with
// the family's limits, refunds, the portal, and who may do what.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { signAccessToken } from '../auth/tokens.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
let till = ''
let student = ''
let card = ''
let portal = ''
const products: Record<string, string> = {}
const post = (path: string, body: unknown, token = fx.tokens.admin) => call(fx.app, token, 'POST', path, body)
const get = (path: string, token = fx.tokens.admin) => call(fx.app, token, 'GET', path)
const put = (path: string, body: unknown, token = fx.tokens.admin) => call(fx.app, token, 'PUT', path, body)

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
  student = await fin.student(fx.branchA)
  card = (await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: student })))!.studentNumber
  till = (await member(fx.tenantId, 'viewer', [fx.branchA], 'canteen')).token
  for (const [name, price, categoryCode] of [
    ['Falafel wrap', 150, 'meals'],
    ['Water', 25, 'drinks'],
    ['Chocolate', 50, 'sweets'],
  ] as const) {
    const res = await post('/canteen/products', { branchId: fx.branchA, name, price, categoryCode })
    assert.equal(res.status, 201, res.error)
    products[name] = (res.body as { id: string }).id
  }
  const p = await post('/parents', { fullName: 'Wallet Parent', primaryPhone: '0790002222', email: 'wallet@family.test' })
  const parentId = (p.body as { parent: { id: string } }).parent.id
  await post(`/parents/${parentId}/links`, { studentId: student, relationshipType: 'mother', financialResponsibility: true, portalAccess: true })
  await post(`/parents/${parentId}/portal/enable`, {})
  const doc = await withTenant(fx.tenantId, (ctx) => ctx.parents.findOne({ _id: parentId }))
  portal = await signAccessToken({ sub: doc!.portalAccess.userId!, email: doc!.email!, tenantId: fx.tenantId, role: 'viewer' })
})
after(async () => {
  await fx.close()
})

describe('wallets', () => {
  test('the office tops up; the till sells until the money runs out', async () => {
    assert.equal((await post(`/canteen/wallets/${student}/topup`, { amount: 300, method: 'cash' }, till)).error, 'FORBIDDEN')
    const top = await post(`/canteen/wallets/${student}/topup`, { amount: 300, method: 'cash' })
    assert.equal(top.status, 201, top.error)
    assert.equal((top.body as { balanceAfter: number }).balanceAfter, 300)

    const look = await get(`/canteen/card?card=${card}`, till)
    assert.equal(look.status, 200, look.error)
    assert.equal((look.body as { balance: number }).balance, 300)
    assert.ok(!('dob' in (look.body as object)), 'the till sees no more of the record')

    const sale = await post('/canteen/sales', { card, items: [{ productId: products['Falafel wrap']!, qty: 1 }, { productId: products['Water']!, qty: 2 }] }, till)
    assert.equal(sale.status, 201, sale.error)
    assert.deepEqual([(sale.body as { total: number }).total, (sale.body as { balanceAfter: number }).balanceAfter], [200, 100])
    const short = await post('/canteen/sales', { card, items: [{ productId: products['Falafel wrap']!, qty: 1 }] }, till)
    assert.equal(short.error, 'INSUFFICIENT_BALANCE')
    assert.equal((await post('/canteen/sales', { card: 'NOPE', items: [{ productId: products['Water']!, qty: 1 }] }, till)).error, 'UNKNOWN_CARD')
    const otherTill = (await member(fx.tenantId, 'viewer', [fx.branchB], 'canteen')).token
    assert.equal((await post('/canteen/sales', { card, items: [{ productId: products['Water']!, qty: 1 }] }, otherTill)).error, 'BRANCH_FORBIDDEN')
    assert.equal((await post('/canteen/products', { branchId: fx.branchA, name: 'X', price: 1 }, till)).error, 'FORBIDDEN')
  })

  test('two tills at once cannot spend the same money', async () => {
    await post(`/canteen/wallets/${student}/topup`, { amount: 150, method: 'cash' })
    const before = ((await get(`/canteen/card?card=${card}`, till)).body as { balance: number }).balance
    const buy = () => post('/canteen/sales', { card, items: [{ productId: products['Falafel wrap']!, qty: 1 }] }, till)
    const results = await Promise.all([buy(), buy(), buy()])
    const ok = results.filter((r) => r.status === 201).length
    assert.equal(ok, Math.floor(before / 150))
    const after = ((await get(`/canteen/card?card=${card}`, till)).body as { balance: number }).balance
    assert.ok(after >= 0)
    assert.equal(after, before - ok * 150)
  })

  test('the family sets a daily limit and blocks sweets; the till keeps to them', async () => {
    await post(`/canteen/wallets/${student}/topup`, { amount: 1000, method: 'cash' })
    const set = await put(`/portal/children/${student}/wallet/controls`, { dailyLimit: 0, blockedCategories: ['sweets'] }, portal)
    assert.equal(set.status, 200, set.error)
    assert.equal((await post('/canteen/sales', { card, items: [{ productId: products['Chocolate']!, qty: 1 }] }, till)).error, 'CATEGORY_BLOCKED')
    // Spending so far today already exceeds a limit of 0.
    assert.equal((await post('/canteen/sales', { card, items: [{ productId: products['Water']!, qty: 1 }] }, till)).error, 'DAILY_LIMIT')
    await put(`/portal/children/${student}/wallet/controls`, { dailyLimit: null, blockedCategories: [] }, portal)
    assert.equal((await post('/canteen/sales', { card, items: [{ productId: products['Water']!, qty: 1 }] }, till)).status, 201)
    assert.equal((await put(`/portal/children/${student}/wallet/controls`, { dailyLimit: null, blockedCategories: ['caviar'] }, portal)).error, 'INVALID_CATEGORY')
  })

  test('a sale taken back the same day returns the money, once', async () => {
    const sale = await post('/canteen/sales', { card, items: [{ productId: products['Water']!, qty: 1 }] }, till)
    const id = (sale.body as { id: string }).id
    const before = ((await get(`/canteen/card?card=${card}`, till)).body as { balance: number }).balance
    assert.equal((await post(`/canteen/sales/${id}/refund`, {}, till)).error, 'FORBIDDEN')
    assert.equal((await post(`/canteen/sales/${id}/refund`, {})).status, 200)
    assert.equal((await post(`/canteen/sales/${id}/refund`, {})).error, 'ALREADY_REFUNDED')
    const after = ((await get(`/canteen/card?card=${card}`, till)).body as { balance: number }).balance
    assert.equal(after, before + 25)
    const day = (await get('/canteen/summary')).body as { sales: number; products: { name: string; qty: number }[] }
    assert.ok(day.sales >= 3 && day.products.some((p) => p.name === 'Falafel wrap'))
  })

  test('the family sees the statement and tops up online', async () => {
    const view = await get(`/portal/children/${student}/wallet`, portal)
    assert.equal(view.status, 200, view.error)
    const w = view.body as { balance: number; transactions: { type: string }[]; canTopUp: boolean }
    assert.ok(w.transactions.some((t) => t.type === 'purchase') && w.transactions.some((t) => t.type === 'refund'))
    assert.equal(w.canTopUp, false, 'no gateway yet')
    assert.equal((await post(`/portal/children/${student}/wallet/topup`, { amount: 1000 }, portal)).error, 'PAYMENTS_OFF')
    await put('/settings/payments', { enabled: true, provider: 'test', currency: 'JOD' })
    assert.equal((await post(`/portal/children/${student}/wallet/topup`, { amount: 50 }, portal)).error, 'INVALID_AMOUNT')
    const start = await post(`/portal/children/${student}/wallet/topup`, { amount: 2000 }, portal)
    assert.equal(start.status, 201, start.error)
    const { id, redirectUrl } = start.body as { id: string; redirectUrl: string }
    const path = new URL(redirectUrl).pathname
    await fx.app.inject({ method: 'POST', url: path, payload: 'outcome=paid', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    await fx.app.inject({ method: 'GET', url: `/payments/return/${fx.tenantId}/${id}` })
    const after = (await get(`/portal/children/${student}/wallet`, portal)).body as { balance: number }
    assert.equal(after.balance, w.balance + 2000)
    // A wallet top-up never touches the fees.
    assert.equal(await withTenant(fx.tenantId, (ctx) => ctx.payments.countDocuments({ studentId: student })), 0)
  })
})
