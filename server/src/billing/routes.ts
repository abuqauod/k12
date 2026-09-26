import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { withoutTenant } from '../db.js'
import type { SubscriptionInvoiceDoc, TenantDoc } from '../db.js'
import { authenticate, requirePermission, requirePlatformAdmin } from '../auth/guard.js'
import { createLimiter } from '../runtime/rateLimit.js'
import { apiBaseOf } from '../payments/service.js'
import { hyperPayBase, hyperPayPage } from '../payments/providers/hyperpay.js'
import { major } from '../payments/providers/types.js'
import { CURRENCIES, PLANS, limitsOf, modulesOf, planOf, subscriptionState, type PlanKey } from './plans.js'
import { usageOf } from './usage.js'
import {
  applyPayment,
  createInvoice,
  quote,
  settleCardPayment,
  startCardPayment,
  vendorProvider,
  vendorProviderKey,
} from './service.js'

/**
 * SAMS 13.3 / 13.4 — the school's Subscription page, card payment through
 * the vendor's gateway, and the console's invoices and revenue view.
 *
 * The school's routes deliberately skip the subscription check: a school
 * whose subscription lapsed must still be able to see what it owes and pay.
 */

const SOLD: [PlanKey, ...PlanKey[]] = ['essentials', 'professional', 'enterprise']

const choiceBody = z.object({
  plan: z.enum(SOLD),
  term: z.enum(['year', 'month']),
  students: z.number().int().min(1).max(100_000).optional(),
})

const consoleInvoiceBody = choiceBody.extend({
  currency: z.enum(CURRENCIES).optional(),
  taxRate: z.number().min(0).max(50).optional(),
  dueDays: z.number().int().min(0).max(120).optional(),
  extraLines: z
    .array(z.object({ label: z.string().min(1).max(200), amount: z.number().int() }))
    .max(10)
    .optional(),
})

const transferBody = z.object({
  reference: z.string().trim().min(1).max(120),
  paidAt: z.string().date().optional(),
})

export function invoiceResponse(doc: SubscriptionInvoiceDoc) {
  return {
    id: doc._id,
    number: doc.number,
    plan: doc.plan,
    term: doc.term,
    periodStart: doc.periodStart,
    periodEnd: doc.periodEnd,
    students: doc.students,
    currency: doc.currency,
    lines: doc.lines,
    subtotal: doc.subtotal,
    taxRate: doc.taxRate,
    tax: doc.tax,
    total: doc.total,
    status: doc.status,
    dueDate: doc.dueDate,
    issuedAt: doc.issuedAt.toISOString(),
    paidAt: doc.paidAt?.toISOString() ?? null,
    paidBy: doc.paidBy,
    reference: doc.reference,
    source: doc.source,
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** A printable invoice, from the vendor's details in the environment. */
function invoicePage(doc: SubscriptionInvoiceDoc, tenant: TenantDoc): string {
  const vendor = process.env.VENDOR_NAME ?? 'ArrangeMySchool'
  const vendorLines = [process.env.VENDOR_ADDRESS, process.env.VENDOR_TAX_NUMBER ? `Tax no. ${process.env.VENDOR_TAX_NUMBER}` : null].filter(Boolean) as string[]
  const amount = (n: number) => `${major(n)} ${doc.currency}`
  const rows = doc.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="n">${amount(l.amount)}</td></tr>`).join('')
  const bank = process.env.VENDOR_BANK_DETAILS
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(doc.number)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#1d1d1d}h1{margin:0}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}.n{text-align:right;white-space:nowrap}.muted{color:#666}.row{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}.paid{color:#0f7a45;font-weight:700}pre{white-space:pre-wrap;font:inherit}@media print{button{display:none}}</style></head>
<body><button onclick="print()">Print</button>
<div class="row"><div><h1>Invoice ${esc(doc.number)}</h1><p class="muted">Issued ${doc.issuedAt.toISOString().slice(0, 10)} · due ${doc.dueDate}</p></div>
<div><strong>${esc(vendor)}</strong><br>${vendorLines.map(esc).join('<br>')}</div></div>
<p><strong>Bill to:</strong> ${esc(tenant.name)}${tenant.profile?.address ? `<br>${esc(tenant.profile.address)}` : ''}${tenant.profile?.taxNumber ? `<br>Tax no. ${esc(tenant.profile.taxNumber)}` : ''}</p>
<table><thead><tr><th>Item</th><th class="n">Amount</th></tr></thead><tbody>${rows}
<tr><td>Subtotal</td><td class="n">${amount(doc.subtotal)}</td></tr>
${doc.tax ? `<tr><td>Tax (${doc.taxRate}%)</td><td class="n">${amount(doc.tax)}</td></tr>` : ''}
<tr><th>Total</th><th class="n">${amount(doc.total)}</th></tr></tbody></table>
${doc.status === 'paid' ? `<p class="paid">Paid ${doc.paidAt?.toISOString().slice(0, 10) ?? ''} (${doc.paidBy}${doc.reference ? `, ${esc(doc.reference)}` : ''})</p>` : doc.status === 'void' ? '<p><strong>Void</strong></p>' : bank ? `<h3>Bank transfer</h3><pre>${esc(bank)}</pre><p class="muted">Please quote ${esc(doc.number)} as the reference.</p>` : ''}
</body></html>`
}

export function registerBillingRoutes(app: FastifyInstance): void {
  // ------------------------------------------------- the school's side --
  const reading = { preHandler: [authenticate, requirePermission('settings.read')] }
  const managing = { preHandler: [authenticate, requirePermission('settings.manage')] }
  const tenantOf = (request: FastifyRequest) => withoutTenant((db) => db.tenants.findOne({ _id: request.auth!.tenantId! }))

  app.get('/subscription', reading, async (request, reply) => {
    const tenant = await tenantOf(request)
    if (!tenant) return reply.code(404).send({ error: 'NOT_FOUND' })
    const invoices = await withoutTenant((db) =>
      db.subscriptionInvoices.find({ tenantId: tenant._id, status: { $ne: 'void' } }).sort({ issuedAt: -1 }).limit(24).toArray(),
    )
    return reply.send({
      plan: tenant.plan,
      listed: Boolean(planOf(tenant)?.listed),
      modules: [...modulesOf(tenant)].sort(),
      limits: limitsOf(tenant),
      usage: await usageOf(tenant._id),
      validUntil: tenant.validUntil,
      graceDays: tenant.graceDays,
      ...subscriptionState(tenant),
      billing: tenant.billing ?? null,
      invoices: invoices.map(invoiceResponse),
      cardPayments: vendorProviderKey() !== null,
      bankDetails: process.env.VENDOR_BANK_DETAILS ?? null,
      salesEmail: process.env.SALES_EMAIL ?? null,
    })
  })

  /** What a plan would cost this school, without writing anything. */
  app.post('/subscription/quote', reading, async (request, reply) => {
    const parsed = choiceBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenant = await tenantOf(request)
    if (!tenant) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send(await quote(tenant, parsed.data))
  })

  /** The school picks a plan: an invoice to pay. A previous one it made
   * itself and hasn't paid is replaced; one from the vendor is kept. */
  app.post('/subscription/invoices', managing, async (request, reply) => {
    const parsed = choiceBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenant = await tenantOf(request)
    if (!tenant) return reply.code(404).send({ error: 'NOT_FOUND' })
    // A custom deal is the vendor's to change.
    if (!planOf(tenant) && tenant.plan !== 'trial') return reply.code(409).send({ error: 'CUSTOM_PLAN' })
    const open = await withoutTenant((db) => db.subscriptionInvoices.find({ tenantId: tenant._id, status: 'open' }).toArray())
    const vendorMade = open.find((i) => i.source !== 'self')
    if (vendorMade) return reply.code(409).send({ error: 'OPEN_INVOICE_EXISTS', invoice: invoiceResponse(vendorMade) })
    const now = new Date()
    await withoutTenant((db) =>
      db.subscriptionInvoices.updateMany({ tenantId: tenant._id, status: 'open', source: 'self' }, { $set: { status: 'void', updatedAt: now } }),
    )
    const doc = await createInvoice(tenant, { ...parsed.data, source: 'self', createdBy: request.auth!.sub })
    return reply.code(201).send(invoiceResponse(doc))
  })

  app.post('/subscription/invoices/:id/pay', managing, async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenant = await tenantOf(request)
    const invoice = await withoutTenant((db) => db.subscriptionInvoices.findOne({ _id: id, tenantId: request.auth!.tenantId! }))
    if (!tenant || !invoice) return reply.code(404).send({ error: 'NOT_FOUND' })
    const user = await withoutTenant((db) => db.users.findOne({ _id: request.auth!.sub }))
    const lang = (request.body as { lang?: string } | undefined)?.lang === 'ar' ? 'ar' : 'en'
    const out = await startCardPayment({
      invoice,
      tenant,
      userId: request.auth!.sub,
      customer: { name: user?.displayName ?? tenant.name, email: user?.email ?? null },
      apiBase: apiBaseOf(request),
      lang,
    })
    if (!out.ok) return reply.code(out.error === 'NOT_OPEN' ? 409 : 503).send({ error: out.error })
    return reply.send({ redirectUrl: out.redirectUrl, checkoutId: out.checkoutId })
  })

  app.get('/subscription/invoices/:id/print', reading, async (request, reply) => {
    const { id } = request.params as { id: string }
    const invoice = await withoutTenant((db) => db.subscriptionInvoices.findOne({ _id: id, tenantId: request.auth!.tenantId! }))
    const tenant = await tenantOf(request)
    if (!invoice || !tenant) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(invoicePage(invoice, tenant))
  })

  /** A card payment's outcome, for the page the school comes back to. */
  app.get('/subscription/checkouts/:id', reading, async (request, reply) => {
    const { id } = request.params as { id: string }
    const doc = await settleCardPayment(id, apiBaseOf(request))
    if (!doc || doc.tenantId !== request.auth!.tenantId) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply.send({ id: doc._id, status: doc.status, amount: doc.amount, currency: doc.currency, invoiceId: doc.invoiceId })
  })

  // --------------------------------------- the vendor's gateway, public --
  const limiter = createLimiter('billing', { max: Number(process.env.RATE_LIMIT_PAYMENTS ?? 120), windowMs: 60_000 })
  const publicGuard = { preHandler: limiter.guard }
  const findCheckout = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string }
    if (!/^[\w-]{8,64}$/.test(id)) return null
    return withoutTenant((db) => db.subscriptionCheckouts.findOne({ _id: id }))
  }
  const onReturn = async (request: FastifyRequest, reply: FastifyReply) => {
    const doc = await findCheckout(request)
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' })
    await settleCardPayment(doc._id, apiBaseOf(request))
    return reply.redirect(`${config.appUrl}/settings/subscription?checkout=${doc._id}`, 303)
  }
  app.get('/billing/return/:id', publicGuard, onReturn)
  app.post('/billing/return/:id', publicGuard, onReturn)
  app.post('/billing/callback/:id', publicGuard, async (request, reply) => {
    const doc = await findCheckout(request)
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' })
    const provider = vendorProvider(apiBaseOf(request), doc.provider)
    const raw = (request as { rawBody?: string }).rawBody ?? ''
    if (provider?.verifyCallback && !provider.verifyCallback(raw, request.headers)) return reply.code(401).send({ error: 'INVALID_SIGNATURE' })
    const out = await settleCardPayment(doc._id, apiBaseOf(request))
    return reply.send({ ok: true, status: out?.status ?? 'pending' })
  })
  app.get('/billing/hyperpay/:id', publicGuard, async (request, reply) => {
    const doc = await findCheckout(request)
    if (!doc || doc.provider !== 'hyperpay' || doc.status !== 'pending' || !doc.providerRef) return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        hyperPayPage({
          base: hyperPayBase(process.env.VENDOR_HYPERPAY_MODE ?? 'test'),
          checkoutId: doc.providerRef,
          returnUrl: `${apiBaseOf(request)}/billing/return/${doc._id}`,
          brands: process.env.VENDOR_HYPERPAY_BRANDS || 'VISA MASTER MADA',
          lang: 'en',
          title: 'Subscription payment',
          amount: `${major(doc.amount)} ${doc.currency}`,
        }),
      )
  })
  app.get('/billing/test/:id', publicGuard, async (request, reply) => {
    const doc = await findCheckout(request)
    if (!doc || doc.provider !== 'test' || doc.status !== 'pending') return reply.code(404).send({ error: 'NOT_FOUND' })
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test payment</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px}button{font-size:16px;padding:10px 16px;margin-inline-end:8px}</style></head>
<body><h1>Test payment</h1><p>Subscription. No card is charged. Amount: <strong>${major(doc.amount)} ${doc.currency}</strong></p>
<form method="post" action="${apiBaseOf(request)}/billing/test/${doc._id}"><button name="outcome" value="paid">Pay</button><button name="outcome" value="failed">Decline</button></form></body></html>`)
  })
  app.post('/billing/test/:id', publicGuard, async (request, reply) => {
    const doc = await findCheckout(request)
    if (!doc || doc.provider !== 'test' || doc.status !== 'pending') return reply.code(404).send({ error: 'NOT_FOUND' })
    const outcome = (request.body as { outcome?: string } | undefined)?.outcome === 'paid' ? 'paid' : 'failed'
    await withoutTenant((db) => db.subscriptionCheckouts.updateOne({ _id: doc._id, status: 'pending' }, { $set: { testOutcome: outcome } }))
    return reply.redirect(`${apiBaseOf(request)}/billing/return/${doc._id}`, 303)
  })

  // ------------------------------------------------------- the console --
  const guarded = { preHandler: [authenticate, requirePlatformAdmin] }

  app.get('/admin/tenants/:id/subscription-invoices', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const docs = await withoutTenant((db) => db.subscriptionInvoices.find({ tenantId: id }).sort({ issuedAt: -1 }).toArray())
    return reply.send({ invoices: docs.map(invoiceResponse) })
  })

  app.post('/admin/tenants/:id/subscription-invoices', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = consoleInvoiceBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: id }))
    if (!tenant) return reply.code(404).send({ error: 'NOT_FOUND' })
    const doc = await createInvoice(tenant, { ...parsed.data, source: 'console', createdBy: request.auth!.sub })
    return reply.code(201).send(invoiceResponse(doc))
  })

  /** A bank transfer arrived. */
  app.post('/admin/subscription-invoices/:id/pay', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = transferBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const out = await applyPayment(id, {
      paidBy: 'transfer',
      reference: parsed.data.reference,
      paidAt: parsed.data.paidAt ? new Date(`${parsed.data.paidAt}T12:00:00Z`) : undefined,
    })
    if (!out.ok) return reply.code(out.error === 'NOT_FOUND' ? 404 : 409).send({ error: out.error })
    return reply.send(invoiceResponse(out.invoice))
  })

  app.post('/admin/subscription-invoices/:id/void', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const doc = await withoutTenant((db) =>
      db.subscriptionInvoices.findOneAndUpdate({ _id: id, status: 'open' }, { $set: { status: 'void', updatedAt: new Date() } }, { returnDocument: 'after' }),
    )
    if (!doc) return reply.code(409).send({ error: 'NOT_OPEN' })
    return reply.send(invoiceResponse(doc))
  })

  /** SAMS 13.4: recurring revenue, receivables, trials and each school's use. */
  app.get('/admin/revenue', guarded, async (_request, reply) => {
    const on = new Date().toISOString().slice(0, 10)
    const [tenants, invoices] = await withoutTenant((db) =>
      Promise.all([db.tenants.find({}).toArray(), db.subscriptionInvoices.find({ status: { $ne: 'void' } }).toArray()]),
    )
    const byCurrency = () => Object.fromEntries(CURRENCIES.map((c) => [c, 0])) as Record<string, number>
    const mrr = byCurrency()
    const collectedMonth = byCurrency()
    const collectedYear = byCurrency()
    const open = byCurrency()
    const overdue = byCurrency()
    const month = on.slice(0, 7)
    const year = on.slice(0, 4)
    for (const inv of invoices) {
      if (inv.status === 'paid') {
        // Recurring revenue: the paid invoice covering today, net of tax
        // and one-off lines, spread over its months.
        if (inv.periodStart <= on && on <= inv.periodEnd) mrr[inv.currency]! += Math.round(inv.lines[0]!.amount / (inv.term === 'year' ? 12 : 1))
        const paid = inv.paidAt?.toISOString() ?? ''
        if (paid.startsWith(month)) collectedMonth[inv.currency]! += inv.total
        if (paid.startsWith(year)) collectedYear[inv.currency]! += inv.total
      } else {
        open[inv.currency]! += inv.total
        if (inv.dueDate < on) overdue[inv.currency]! += inv.total
      }
    }
    const plans: Record<string, number> = {}
    for (const t of tenants) if (t.status === 'active') plans[t.plan] = (plans[t.plan] ?? 0) + 1
    const signups = tenants.filter((t) => t.source === 'signup')
    const decided = signups.filter((t) => t.plan !== 'trial' || (t.validUntil ?? on) < on)
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    const schools = await Promise.all(
      tenants.map(async (t) => ({
        id: t._id,
        name: t.name,
        plan: t.plan,
        status: t.status,
        validUntil: t.validUntil,
        state: subscriptionState(t).state,
        billedStudents: t.billing?.students ?? null,
        currency: t.billing?.currency ?? null,
        usage: await usageOf(t._id),
      })),
    )
    return reply.send({
      asOf: on,
      mrr,
      arr: Object.fromEntries(Object.entries(mrr).map(([c, v]) => [c, v * 12])),
      collectedMonth,
      collectedYear,
      open,
      overdue,
      plans,
      trials: {
        active: tenants.filter((t) => t.plan === 'trial' && (t.validUntil ?? on) >= on).length,
        endingThisWeek: tenants.filter((t) => t.plan === 'trial' && t.validUntil && t.validUntil >= on && t.validUntil <= soon).length,
        signups: signups.length,
        converted: signups.filter((t) => t.plan !== 'trial').length,
        conversionRate: decided.length ? signups.filter((t) => t.plan !== 'trial').length / decided.length : null,
      },
      schools,
      listPrices: Object.fromEntries(SOLD.map((k) => [k, PLANS[k].price])),
    })
  })
}
