import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../db.js'
import type { OnlinePaymentDoc, PaymentProviderKey } from '../db.js'
import { config } from '../config.js'
import { recordAudit } from '../audit.js'
import { branchFilter, scoped } from '../records.js'
import { portalContext } from '../portal/routes.js'
import { createLimiter } from '../runtime/rateLimit.js'
import { sealSecret } from './secrets.js'
import { PAYTABS_REGIONS } from './providers/paytabs.js'
import { hyperPayBase, hyperPayPage } from './providers/hyperpay.js'
import { major } from './providers/types.js'
import {
  apiBaseOf,
  loadPaymentSettings,
  onlinePaymentResponse,
  PROVIDER_FIELDS,
  providerFor,
  settle,
  startCheckout,
  testProviderAllowed,
} from './service.js'

/**
 * SAMS 11.1 routes: the school's gateway settings, a family paying from the
 * portal, the gateway's return and callback, and the office's list.
 */

const PROVIDERS = ['paytabs', 'hyperpay', 'test'] as const
const settingsBody = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(PROVIDERS).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    settings: z.record(z.string().max(200)).default({}),
    /** Only the secrets being set or changed; a blank one keeps what is stored. */
    secrets: z.record(z.string().max(500)).default({}),
  })
  .strict()

const payBody = z.object({ amount: z.number().int().positive().nullable().default(null) }).strict()
const listQuery = z.object({
  branchId: z.string().optional(),
  status: z.enum(['pending', 'paid', 'failed', 'cancelled']).optional(),
  studentId: z.string().optional(),
})

/** Callbacks, returns and the test page are public: a per-IP budget. */
const publicLimiter = createLimiter('payments', { max: Number(process.env.RATE_LIMIT_PAYMENTS ?? 120), windowMs: 60_000 })

export function registerPaymentRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------ settings --

  const settingsView = async (tenantId: string) => {
    const s = await withTenant(tenantId, (ctx) => loadPaymentSettings(ctx, tenantId))
    return {
      enabled: s.enabled,
      provider: s.provider,
      currency: s.currency,
      settings: s.settings,
      // Which secrets are stored — never their values.
      secretsSet: Object.fromEntries(Object.keys(s.secrets).map((k) => [k, true])),
      providers: PROVIDERS.filter((p) => p !== 'test' || testProviderAllowed()),
      fields: PROVIDER_FIELDS,
      paytabsRegions: Object.keys(PAYTABS_REGIONS),
    }
  }

  app.get('/settings/payments', scoped('settings.read'), async (request, reply) => {
    return reply.send(await settingsView(request.auth!.tenantId!))
  })

  app.put('/settings/payments', scoped('settings.manage'), async (request, reply) => {
    const parsed = settingsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const body = parsed.data
    const tenantId = request.auth!.tenantId!
    if (body.provider === 'test' && !testProviderAllowed()) return reply.code(400).send({ error: 'TEST_PROVIDER_NOT_ALLOWED' })

    const error = await withTenant(tenantId, async (ctx) => {
      const before = await loadPaymentSettings(ctx, tenantId)
      const fields = body.provider ? PROVIDER_FIELDS[body.provider as PaymentProviderKey] : { settings: [], secrets: [] }
      const settings = Object.fromEntries(fields.settings.map((k) => [k, (body.settings[k] ?? '').trim()]).filter(([, v]) => v !== ''))
      // Switching gateway drops the other gateway's secrets.
      const kept = before.provider === body.provider ? before.secrets : {}
      const secrets: Record<string, string> = {}
      for (const k of fields.secrets) {
        const given = (body.secrets[k] ?? '').trim()
        if (given) secrets[k] = sealSecret(given)
        else if (kept[k]) secrets[k] = kept[k]!
      }
      if (body.enabled) {
        if (!body.provider) return 'PROVIDER_REQUIRED'
        const required = body.provider === 'hyperpay' ? ['entityId'] : body.provider === 'paytabs' ? ['profileId'] : []
        if (required.some((k) => !settings[k]) || fields.secrets.some((k) => !secrets[k])) return 'CREDENTIALS_REQUIRED'
        if (body.provider === 'paytabs' && settings.region && !PAYTABS_REGIONS[settings.region]) return 'INVALID_REGION'
      }
      const now = new Date()
      await ctx.paymentSettings.findOneAndUpdate(
        { _id: tenantId },
        {
          $set: { enabled: body.enabled, provider: body.provider, currency: body.currency, settings, secrets, updatedAt: now, updatedBy: request.auth!.sub },
          $setOnInsert: { tenantId },
        },
        { upsert: true },
      )
      await recordAudit(ctx.auditLog, {
        actorId: request.auth!.sub,
        action: 'settings.payments.update',
        entity: 'tenant',
        entityId: tenantId,
        before: { enabled: before.enabled, provider: before.provider, currency: before.currency, settings: before.settings },
        // Which secrets changed, never what they are.
        after: { enabled: body.enabled, provider: body.provider, currency: body.currency, settings, secretsChanged: Object.keys(body.secrets).filter((k) => body.secrets[k]) },
      })
      return null
    })
    if (error) return reply.code(400).send({ error })
    return reply.send(await settingsView(tenantId))
  })

  // ------------------------------------------------ family pays --

  app.post('/portal/children/:id/pay', scoped('portal.parent'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = payBody.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const tenantId = request.auth!.tenantId!
    type Who = { error: string; status: number } | { parent: NonNullable<Awaited<ReturnType<typeof portalContext>>>['parent'] }
    const who = await withTenant(tenantId, async (ctx): Promise<Who> => {
      const pc = await portalContext(ctx, request.auth!.sub)
      if (!pc) return { error: 'PORTAL_DISABLED', status: 403 }
      const link = pc.links.find((l) => l.studentId === id)
      if (!link) return { error: 'NOT_FOUND', status: 404 }
      if (!link.financialResponsibility) return { error: 'FINANCE_NOT_SHARED', status: 403 }
      return { parent: pc.parent }
    })
    if ('error' in who) return reply.code(who.status).send({ error: who.error })
    const result = await startCheckout({
      tenantId,
      studentId: id,
      parentId: who.parent._id,
      payer: { name: who.parent.fullName, email: who.parent.email, phone: who.parent.primaryPhone },
      amount: parsed.data.amount,
      apiBase: apiBaseOf(request),
      lang: who.parent.preferredLanguage === 'ar' ? 'ar' : 'en',
      actorId: request.auth!.sub,
    })
    if (!result.ok) return reply.code(result.status).send({ error: result.error, outstanding: result.outstanding })
    return reply.code(201).send({ ...onlinePaymentResponse(result.payment), redirectUrl: result.redirectUrl })
  })

  /** How a family's payment stands (the portal shows it on coming back). */
  app.get('/portal/payments/:id', scoped('portal.parent'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const doc = await withTenant(tenantId, async (ctx) => {
      const pc = await portalContext(ctx, request.auth!.sub)
      if (!pc) return null
      const p = await ctx.onlinePayments.findOne({ _id: id })
      return p && pc.links.some((l) => l.studentId === p.studentId && l.financialResponsibility) ? p : null
    })
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' })
    const fresh = doc.status === 'pending' ? ((await settle(tenantId, id, apiBaseOf(request))).payment ?? doc) : doc
    return reply.send(onlinePaymentResponse(fresh))
  })

  // --------------------------------------------- gateway, public --

  const publicGuard = { preHandler: publicLimiter.guard }
  const findPublic = async (request: FastifyRequest): Promise<OnlinePaymentDoc | null> => {
    const { tenantId, id } = request.params as { tenantId: string; id: string }
    if (!/^[\w-]{8,64}$/.test(tenantId) || !/^[\w-]{8,64}$/.test(id)) return null
    return withTenant(tenantId, (ctx) => ctx.onlinePayments.findOne({ _id: id }))
  }
  const backToPortal = (reply: FastifyReply, doc: OnlinePaymentDoc) =>
    reply.redirect(`${config.appUrl}/portal/children/${doc.studentId}?tab=finance&payment=${doc._id}`, 303)

  // The family's browser coming back from the gateway (GET or a form POST).
  const onReturn = async (request: FastifyRequest, reply: FastifyReply) => {
    const doc = await findPublic(request)
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' })
    const out = await settle(doc.tenantId, doc._id, apiBaseOf(request))
    return backToPortal(reply, out.payment ?? doc)
  }
  app.get('/payments/return/:tenantId/:id', publicGuard, onReturn)
  app.post('/payments/return/:tenantId/:id', publicGuard, onReturn)

  // The gateway's server-to-server notice. Checked for a signature where the
  // gateway signs; either way it only prompts a status query.
  app.post('/payments/callback/:tenantId/:id', publicGuard, async (request, reply) => {
    const doc = await findPublic(request)
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' })
    const settings = await withTenant(doc.tenantId, (ctx) => loadPaymentSettings(ctx, doc.tenantId))
    const provider = providerFor({ ...settings, enabled: true, provider: doc.provider }, { apiBase: apiBaseOf(request), tenantId: doc.tenantId })
    const raw = (request as { rawBody?: string }).rawBody ?? ''
    if (provider?.verifyCallback && !provider.verifyCallback(raw, request.headers)) {
      return reply.code(401).send({ error: 'INVALID_SIGNATURE' })
    }
    const out = await settle(doc.tenantId, doc._id, apiBaseOf(request))
    return reply.send({ ok: true, status: out.status })
  })

  // HyperPay's card widget, for one checkout.
  app.get('/payments/hyperpay/:tenantId/:id', publicGuard, async (request, reply) => {
    const doc = await findPublic(request)
    if (!doc || doc.provider !== 'hyperpay' || doc.status !== 'pending' || !doc.providerRef) return reply.code(404).send({ error: 'NOT_FOUND' })
    const settings = await withTenant(doc.tenantId, (ctx) => loadPaymentSettings(ctx, doc.tenantId))
    const parent = doc.parentId ? await withTenant(doc.tenantId, (ctx) => ctx.parents.findOne({ _id: doc.parentId! })) : null
    const lang = parent?.preferredLanguage === 'ar' ? 'ar' : 'en'
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        hyperPayPage({
          base: hyperPayBase(settings.settings.mode ?? 'test'),
          checkoutId: doc.providerRef,
          returnUrl: `${apiBaseOf(request)}/payments/return/${doc.tenantId}/${doc._id}`,
          brands: settings.settings.brands || 'VISA MASTER MADA',
          lang,
          title: lang === 'ar' ? 'دفع الرسوم المدرسية' : 'Pay school fees',
          amount: `${major(doc.amount)} ${doc.currency}`,
        }),
      )
  })

  // The test gateway's "payment page" (development and demos only).
  app.get('/payments/test/:tenantId/:id', publicGuard, async (request, reply) => {
    const doc = await findPublic(request)
    if (!doc || doc.provider !== 'test' || !testProviderAllowed() || doc.status !== 'pending') return reply.code(404).send({ error: 'NOT_FOUND' })
    const action = `${apiBaseOf(request)}/payments/test/${doc.tenantId}/${doc._id}`
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test payment</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px}button{font-size:16px;padding:10px 16px;margin-inline-end:8px}</style></head>
<body><h1>Test payment</h1><p>No card is charged. Amount: <strong>${major(doc.amount)} ${doc.currency}</strong></p>
<form method="post" action="${action}"><button name="outcome" value="paid">Pay</button><button name="outcome" value="failed">Decline</button></form></body></html>`)
  })
  app.post('/payments/test/:tenantId/:id', publicGuard, async (request, reply) => {
    const doc = await findPublic(request)
    if (!doc || doc.provider !== 'test' || !testProviderAllowed() || doc.status !== 'pending') return reply.code(404).send({ error: 'NOT_FOUND' })
    const outcome = (request.body as { outcome?: string } | undefined)?.outcome === 'paid' ? 'paid' : 'failed'
    await withTenant(doc.tenantId, (ctx) => ctx.onlinePayments.updateMany({ _id: doc._id, status: 'pending' }, { $set: { testOutcome: outcome } }))
    return reply.redirect(`${apiBaseOf(request)}/payments/return/${doc.tenantId}/${doc._id}`, 303)
  })

  // ---------------------------------------------------- the office --

  app.get('/finance/online-payments', scoped('finance.read'), async (request, reply) => {
    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_QUERY' })
    const branches = await branchFilter(request, parsed.data.branchId)
    if (!branches.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const rows = await withTenant(request.auth!.tenantId!, async (ctx) => {
      const docs = await ctx.onlinePayments
        .find({
          ...(branches.branchIds ? { branchId: { $in: branches.branchIds } } : {}),
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
          ...(parsed.data.studentId ? { studentId: parsed.data.studentId } : {}),
        })
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray()
      const students = await ctx.students.find({ _id: { $in: [...new Set(docs.map((d) => d.studentId))] } }).toArray()
      const names = new Map(students.map((s) => [s._id, `${s.givenName} ${s.familyName}`.trim()]))
      return docs.map((d) => onlinePaymentResponse(d, { student: names.get(d.studentId) }))
    })
    return reply.send({ payments: rows })
  })

  /** Asks the gateway again now (the sweep does this every few minutes). */
  app.post('/finance/online-payments/:id/check', scoped('finance.read'), async (request, reply) => {
    const { id } = request.params as { id: string }
    const tenantId = request.auth!.tenantId!
    const doc = await withTenant(tenantId, (ctx) => ctx.onlinePayments.findOne({ _id: id }))
    if (!doc) return reply.code(404).send({ error: 'NOT_FOUND' })
    const allowed = await branchFilter(request, doc.branchId)
    if (!allowed.ok) return reply.code(403).send({ error: 'BRANCH_FORBIDDEN' })
    const out = await settle(tenantId, id, apiBaseOf(request))
    return reply.send(onlinePaymentResponse(out.payment ?? doc))
  })
}
