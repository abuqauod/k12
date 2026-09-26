// SAMS 11.1: online fee payment — the school's gateway settings, a family
// paying from the portal (test gateway, and PayTabs / HyperPay against
// local stand-ins), settlement exactly once, refunds back to the card.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { withTenant } from '../db.js'
import { signAccessToken } from '../auth/tokens.js'
import { reconcilePending } from '../payments/service.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
const post = (path: string, body: unknown, token = fx.tokens.admin) => call(fx.app, token, 'POST', path, body)
const get = (path: string, token = fx.tokens.admin) => call(fx.app, token, 'GET', path)
const put = (path: string, body: unknown, token = fx.tokens.admin) => call(fx.app, token, 'PUT', path, body)

/** A family with the portal on, responsible for `studentId`'s fees. */
async function family(studentId: string, financial = true): Promise<{ parentId: string; token: string }> {
  const p = await post('/parents', { fullName: 'Huda Parent', primaryPhone: '0791234567', email: `p-${studentId.slice(0, 8)}@family.test` })
  const parentId = (p.body as { parent: { id: string } }).parent.id
  const link = await post(`/parents/${parentId}/links`, { studentId, relationshipType: 'mother', financialResponsibility: financial, portalAccess: true })
  assert.equal(link.status, 201, link.error)
  assert.equal((await post(`/parents/${parentId}/portal/enable`, {})).status, 200)
  const doc = await withTenant(fx.tenantId, (ctx) => ctx.parents.findOne({ _id: parentId }))
  return { parentId, token: await signAccessToken({ sub: doc!.portalAccess.userId!, email: doc!.email!, tenantId: fx.tenantId, role: 'viewer' }) }
}

/** Follows the test gateway's page as a family clicking a button. */
async function payOnTestPage(redirectUrl: string, outcome: 'paid' | 'failed') {
  const path = new URL(redirectUrl).pathname
  const page = await fx.app.inject({ method: 'GET', url: path })
  assert.equal(page.statusCode, 200)
  const back = await fx.app.inject({ method: 'POST', url: path, payload: `outcome=${outcome}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  assert.equal(back.statusCode, 303)
  const ret = await fx.app.inject({ method: 'GET', url: new URL(back.headers.location as string).pathname })
  assert.equal(ret.statusCode, 303)
  return ret.headers.location as string
}

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
})
after(async () => {
  await fx.close()
})

describe('settings', () => {
  test('secrets are stored sealed and never returned; enabling needs the credentials', async () => {
    assert.equal((await put('/settings/payments', { enabled: true, provider: 'paytabs', currency: 'JOD', settings: { profileId: '123' } })).error, 'CREDENTIALS_REQUIRED')
    const saved = await put('/settings/payments', {
      enabled: true,
      provider: 'paytabs',
      currency: 'JOD',
      settings: { profileId: '123', region: 'jordan' },
      secrets: { serverKey: 'SK-super-secret' },
    })
    assert.equal(saved.status, 200, saved.error)
    const view = await get('/settings/payments', fx.tokens.viewer)
    assert.ok(!JSON.stringify(view.body).includes('SK-super-secret'))
    assert.deepEqual((view.body as { secretsSet: Record<string, boolean> }).secretsSet, { serverKey: true })
    const stored = await withTenant(fx.tenantId, (ctx) => ctx.paymentSettings.findOne({ _id: fx.tenantId }))
    assert.ok(stored!.secrets.serverKey && !stored!.secrets.serverKey.includes('SK-super'))
    // A blank secret keeps the stored one; a new gateway drops it.
    assert.equal((await put('/settings/payments', { enabled: true, provider: 'paytabs', currency: 'JOD', settings: { profileId: '124' }, secrets: { serverKey: '' } })).status, 200)
    assert.equal((await put('/settings/payments', { enabled: true, provider: 'hyperpay', currency: 'JOD', settings: { entityId: 'e1' } })).error, 'CREDENTIALS_REQUIRED')
    const audit = await withTenant(fx.tenantId, (ctx) => ctx.auditLog.find({ action: 'settings.payments.update' }).toArray())
    assert.ok(audit.length >= 2 && !JSON.stringify(audit).includes('SK-super-secret'))
    assert.equal((await put('/settings/payments', { enabled: false, provider: null, currency: 'JOD' }, fx.tokens.scheduler)).error, 'FORBIDDEN')
  })
})

describe('paying from the portal (test gateway)', () => {
  before(async () => {
    const res = await put('/settings/payments', { enabled: true, provider: 'test', currency: 'JOD' })
    assert.equal(res.status, 200, res.error)
  })

  test('a paid checkout becomes one payment with a receipt, however often it is settled', async () => {
    const inv = await fin.invoice({ dueDate: '2026-09-01' })
    const { token } = await family(inv.studentId)
    const start = await post(`/portal/children/${inv.studentId}/pay`, { amount: 5000 }, token)
    assert.equal(start.status, 201, start.error)
    const { id, redirectUrl } = start.body as { id: string; redirectUrl: string }
    const landing = await payOnTestPage(redirectUrl, 'paid')
    assert.match(landing, new RegExp(`/portal/children/${inv.studentId}\\?tab=finance&payment=${id}$`))

    const status = await get(`/portal/payments/${id}`, token)
    assert.equal((status.body as { status: string }).status, 'paid')
    // The gateway's callback arriving late settles nothing twice.
    await fx.app.inject({ method: 'POST', url: `/payments/callback/${fx.tenantId}/${id}`, payload: {} })
    await reconcilePending('')
    const payments = await withTenant(fx.tenantId, (ctx) => ctx.payments.find({ invoiceId: inv.id }).toArray())
    assert.equal(payments.length, 1)
    assert.equal(payments[0]!.method, 'online')
    assert.equal(payments[0]!.amount, 5000)
    const receipts = await withTenant(fx.tenantId, (ctx) => ctx.receipts.find({ studentId: inv.studentId }).toArray())
    assert.equal(receipts.length, 1)
    const notice = await withTenant(fx.tenantId, (ctx) => ctx.notificationJobs.countDocuments({ kind: 'payment_received', sourceId: receipts[0]!._id }))
    assert.equal(notice, 1)
    const invoice = (await get(`/finance/invoices/${inv.id}`)).body as { status: string }
    assert.equal(invoice.status, 'partially_paid')
  })

  test('a declined card records nothing; the family may try again', async () => {
    const inv = await fin.invoice()
    const { token } = await family(inv.studentId)
    const start = (await post(`/portal/children/${inv.studentId}/pay`, {}, token)).body as { id: string; redirectUrl: string; amount: number }
    assert.equal(start.amount, 12000, 'defaults to everything outstanding')
    await payOnTestPage(start.redirectUrl, 'failed')
    assert.equal(((await get(`/portal/payments/${start.id}`, token)).body as { status: string }).status, 'failed')
    assert.equal(await withTenant(fx.tenantId, (ctx) => ctx.payments.countDocuments({ invoiceId: inv.id })), 0)
    assert.equal((await post(`/portal/children/${inv.studentId}/pay`, {}, token)).status, 201)
  })

  test('refuses more than is owed, other families’ children, and families not paying fees', async () => {
    const inv = await fin.invoice()
    const { token } = await family(inv.studentId)
    const over = await post(`/portal/children/${inv.studentId}/pay`, { amount: 12001 }, token)
    assert.equal(over.error, 'AMOUNT_EXCEEDS_OUTSTANDING')
    const other = await fin.invoice()
    assert.equal((await post(`/portal/children/${other.studentId}/pay`, {}, token)).error, 'NOT_FOUND')
    const notPaying = await family(other.studentId, false)
    assert.equal((await post(`/portal/children/${other.studentId}/pay`, {}, notPaying.token)).error, 'FINANCE_NOT_SHARED')
    assert.equal((await post(`/portal/children/${inv.studentId}/pay`, {}, fx.tokens.owner)).error, 'FORBIDDEN')
  })

  test('paid while the office took cash too: the rest is kept as credit and flagged', async () => {
    const inv = await fin.invoice()
    const { token } = await family(inv.studentId)
    const start = (await post(`/portal/children/${inv.studentId}/pay`, {}, token)).body as { id: string; redirectUrl: string }
    await fin.pay(inv.id, 10000)
    await payOnTestPage(start.redirectUrl, 'paid')
    const doc = await withTenant(fx.tenantId, (ctx) => ctx.onlinePayments.findOne({ _id: start.id }))
    assert.equal(doc!.status, 'paid')
    assert.equal(doc!.overpaid, 10000)
    const paid = await withTenant(fx.tenantId, (ctx) => ctx.payments.find({ invoiceId: inv.id, method: 'online' }).toArray())
    assert.equal(paid.reduce((s, p) => s + p.amount, 0), 12000)
  })

  test('the office lists them in its branches and can check one again', async () => {
    const list = await get('/finance/online-payments?status=paid', fx.tokens.viewer)
    assert.equal(list.status, 200, list.error)
    const rows = (list.body as { payments: { id: string; studentName: string }[] }).payments
    assert.ok(rows.length >= 2 && rows.every((r) => r.studentName))
    const confined = (await member(fx.tenantId, 'admin', [fx.branchB])).token
    assert.equal(((await get('/finance/online-payments', confined)).body as { payments: unknown[] }).payments.length, 0)
    assert.equal((await post(`/finance/online-payments/${rows[0]!.id}/check`, {}, confined)).error, 'BRANCH_FORBIDDEN')
  })

  test('the sweep settles payments the family never came back from', async () => {
    const inv = await fin.invoice()
    const { token } = await family(inv.studentId)
    const start = (await post(`/portal/children/${inv.studentId}/pay`, { amount: 2000 }, token)).body as { id: string }
    // Paid on the gateway, browser closed before coming back; three minutes on.
    await withTenant(fx.tenantId, (ctx) =>
      ctx.onlinePayments.updateMany({ _id: start.id }, { $set: { testOutcome: 'paid', createdAt: new Date(Date.now() - 3 * 60_000) } }),
    )
    assert.ok((await reconcilePending('')) >= 1)
    assert.equal(await withTenant(fx.tenantId, (ctx) => ctx.payments.countDocuments({ invoiceId: inv.id, method: 'online' })), 1)
  })

  test('an approved refund paid out "online" goes back to the card first', async () => {
    const inv = await fin.invoice()
    const { token } = await family(inv.studentId)
    const start = (await post(`/portal/children/${inv.studentId}/pay`, {}, token)).body as { id: string; redirectUrl: string }
    await payOnTestPage(start.redirectUrl, 'paid')
    // Raised by one person, approved by another.
    const refund = (await post(`/finance/invoices/${inv.id}/refunds`, { amount: 3000, reason: 'Left mid-term' }, fx.tokens.scheduler)).body as { id: string; approvalId: string }
    assert.equal((await post(`/approvals/${refund.approvalId}/approve`, {})).status, 200)
    const paid = await post(`/finance/refunds/${refund.id}/pay`, { paidAt: '2026-09-20', method: 'online', reference: null })
    assert.equal(paid.status, 200, JSON.stringify(paid.body))
    assert.match((paid.body as { reference: string }).reference, /^test_refund_/)
    const doc = await withTenant(fx.tenantId, (ctx) => ctx.onlinePayments.findOne({ _id: start.id }))
    assert.equal(doc!.refunded, 3000)
  })
})

/** A stand-in gateway on localhost that answers like the real one. */
async function fakeGateway(handler: (req: IncomingMessage, body: string) => { status?: number; json: unknown }): Promise<{ url: string; server: Server; calls: { path: string; body: string }[] }> {
  const calls: { path: string; body: string }[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      calls.push({ path: req.url ?? '', body })
      const out = handler(req, body)
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out.json))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, calls }
}

describe('PayTabs', () => {
  let gw: Awaited<ReturnType<typeof fakeGateway>>
  let charged = '120.00'
  before(async () => {
    gw = await fakeGateway((req, body) => {
      assert.equal(req.headers.authorization, 'SK-paytabs')
      const b = JSON.parse(body) as { tran_type?: string; cart_amount?: number; tran_ref?: string }
      if (req.url === '/payment/request' && b.tran_type === 'sale') return { json: { tran_ref: 'TST123', redirect_url: 'https://secure-jordan.paytabs.com/payment/page/abc' } }
      if (req.url === '/payment/request' && b.tran_type === 'refund') return { json: { tran_ref: 'TST124', payment_result: { response_status: 'A' } } }
      if (req.url === '/payment/query') return { json: { tran_ref: 'TST123', cart_amount: charged, cart_currency: 'JOD', payment_result: { response_status: 'A', response_message: 'Authorised' } } }
      return { status: 404, json: {} }
    })
    process.env.PAYTABS_BASE_URL = gw.url
    const res = await put('/settings/payments', { enabled: true, provider: 'paytabs', currency: 'JOD', settings: { profileId: '555', region: 'jordan' }, secrets: { serverKey: 'SK-paytabs' } })
    assert.equal(res.status, 200, res.error)
  })
  after(() => {
    delete process.env.PAYTABS_BASE_URL
    gw.server.close()
  })

  test('the hosted page, a signed callback, and the amount checked against the gateway', async () => {
    const inv = await fin.invoice()
    const { token } = await family(inv.studentId)
    const start = await post(`/portal/children/${inv.studentId}/pay`, {}, token)
    assert.equal(start.status, 201, start.error)
    const { id, redirectUrl } = start.body as { id: string; redirectUrl: string }
    assert.equal(redirectUrl, 'https://secure-jordan.paytabs.com/payment/page/abc')
    const sent = JSON.parse(gw.calls[0]!.body) as { profile_id: number; cart_id: string; cart_amount: number; callback: string }
    assert.deepEqual([sent.profile_id, sent.cart_id, sent.cart_amount], [555, id, 120])
    assert.match(sent.callback, new RegExp(`/payments/callback/${fx.tenantId}/${id}$`))

    const body = JSON.stringify({ tran_ref: 'TST123', cart_id: id })
    const bad = await fx.app.inject({ method: 'POST', url: `/payments/callback/${fx.tenantId}/${id}`, payload: body, headers: { 'content-type': 'application/json', signature: 'nope' } })
    assert.equal(bad.statusCode, 401)
    const signature = createHmac('sha256', 'SK-paytabs').update(body).digest('hex')
    const good = await fx.app.inject({ method: 'POST', url: `/payments/callback/${fx.tenantId}/${id}`, payload: body, headers: { 'content-type': 'application/json', signature } })
    assert.equal(good.statusCode, 200)
    assert.equal(good.json().status, 'paid')
    assert.equal(await withTenant(fx.tenantId, (ctx) => ctx.payments.countDocuments({ invoiceId: inv.id, method: 'online' })), 1)

    // A gateway reporting a different amount is never recorded.
    charged = '1.00'
    const other = await fin.invoice()
    const fam = await family(other.studentId)
    const second = (await post(`/portal/children/${other.studentId}/pay`, {}, fam.token)).body as { id: string }
    await fx.app.inject({ method: 'GET', url: `/payments/return/${fx.tenantId}/${second.id}` })
    const doc = await withTenant(fx.tenantId, (ctx) => ctx.onlinePayments.findOne({ _id: second.id }))
    assert.equal(doc!.status, 'failed')
    assert.match(doc!.message ?? '', /AMOUNT_MISMATCH/)
  })
})

describe('HyperPay', () => {
  let gw: Awaited<ReturnType<typeof fakeGateway>>
  before(async () => {
    gw = await fakeGateway((req) => {
      assert.equal(req.headers.authorization, 'Bearer HP-token')
      if (req.method === 'POST' && req.url === '/v1/checkouts') return { json: { id: 'CHK-1', result: { code: '000.200.100' } } }
      if (req.method === 'GET' && req.url?.startsWith('/v1/checkouts/CHK-1/payment')) {
        return { json: { id: 'PAY-9', amount: '120.00', currency: 'SAR', result: { code: '000.100.110', description: 'Request successfully processed' } } }
      }
      return { status: 404, json: {} }
    })
    process.env.HYPERPAY_BASE_URL = gw.url
    const res = await put('/settings/payments', { enabled: true, provider: 'hyperpay', currency: 'SAR', settings: { entityId: 'ENT-1', mode: 'test' }, secrets: { accessToken: 'HP-token' } })
    assert.equal(res.status, 200, res.error)
  })
  after(() => {
    delete process.env.HYPERPAY_BASE_URL
    gw.server.close()
  })

  test('the widget page, then the browser coming back settles it', async () => {
    const inv = await fin.invoice()
    const { token } = await family(inv.studentId)
    const start = (await post(`/portal/children/${inv.studentId}/pay`, {}, token)).body as { id: string; redirectUrl: string }
    const form = new URLSearchParams(gw.calls[0]!.body)
    assert.deepEqual([form.get('entityId'), form.get('amount'), form.get('currency'), form.get('paymentType')], ['ENT-1', '120.00', 'SAR', 'DB'])
    const page = await fx.app.inject({ method: 'GET', url: new URL(start.redirectUrl).pathname })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /paymentWidgets\.js\?checkoutId=CHK-1/)
    const back = await fx.app.inject({ method: 'GET', url: `/payments/return/${fx.tenantId}/${start.id}?id=CHK-1` })
    assert.equal(back.statusCode, 303)
    const doc = await withTenant(fx.tenantId, (ctx) => ctx.onlinePayments.findOne({ _id: start.id }))
    assert.equal(doc!.status, 'paid')
    assert.equal(doc!.providerPaymentId, 'PAY-9')
  })
})
