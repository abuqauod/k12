import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { withTenant, withoutTenant } from '../db.js'
import type { OnlinePaymentDoc, PaymentProviderKey, PaymentSettingsDoc, RefundDoc, TenantContext } from '../db.js'
import { recordAudit } from '../audit.js'
import { allocate, openInvoices, recordPayments } from '../finance/service.js'
import { config, isProduction } from '../config.js'
import { openSecret } from './secrets.js'
import { payTabs } from './providers/paytabs.js'
import { hyperPay } from './providers/hyperpay.js'
import { GatewayError, type PaymentProvider, type PaymentStatus } from './providers/types.js'

/**
 * SAMS 11.1 — online fee payment. A family starts a checkout for an amount
 * up to what is outstanding; the gateway takes the card; the payment is
 * settled only on the gateway's own answer to a status query (a callback or
 * the browser coming back merely prompts that check, and the sweep checks
 * anything left pending). Settling records a normal payment through
 * `recordPayments` — allocated oldest due first, with a receipt and the
 * family's "payment received" notice — exactly once.
 */

export const DEFAULT_CURRENCY = 'JOD'

/** This API's public address: PUBLIC_API_URL, else how the request came in. */
export function apiBaseOf(request: FastifyRequest): string {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/+$/, '')
  return `${request.protocol}://${request.host}${config.routePrefix}`
}

/** The test gateway (a fake checkout page on this API) is for development
 * and demos; production needs PAYMENTS_ALLOW_TEST=true to offer it. */
export const testProviderAllowed = () => !isProduction || process.env.PAYMENTS_ALLOW_TEST === 'true'

export async function loadPaymentSettings(ctx: TenantContext, tenantId: string): Promise<PaymentSettingsDoc> {
  return (
    (await ctx.paymentSettings.findOne({ _id: tenantId })) ?? {
      _id: tenantId,
      tenantId,
      enabled: false,
      provider: null,
      currency: DEFAULT_CURRENCY,
      settings: {},
      secrets: {},
      updatedAt: new Date(0),
      updatedBy: null,
    }
  )
}

/** Which public settings and secrets each gateway needs. */
export const PROVIDER_FIELDS: Record<PaymentProviderKey, { settings: string[]; secrets: string[] }> = {
  paytabs: { settings: ['profileId', 'region'], secrets: ['serverKey'] },
  hyperpay: { settings: ['entityId', 'mode', 'brands'], secrets: ['accessToken'] },
  test: { settings: [], secrets: [] },
}

export interface ProviderContext {
  /** This API's public address, for the gateway's return and callback. */
  apiBase: string
  tenantId: string
}

/** The school's gateway, or null when it is off or its keys are unreadable. */
export function providerFor(settings: PaymentSettingsDoc, pc: ProviderContext): PaymentProvider | null {
  if (!settings.enabled || !settings.provider) return null
  const secret = (name: string) => (settings.secrets[name] ? openSecret(settings.secrets[name]!) : null)
  switch (settings.provider) {
    case 'paytabs': {
      const serverKey = secret('serverKey')
      if (!serverKey || !settings.settings.profileId) return null
      return payTabs({ profileId: settings.settings.profileId, serverKey, region: settings.settings.region ?? 'jordan' })
    }
    case 'hyperpay': {
      const accessToken = secret('accessToken')
      if (!accessToken || !settings.settings.entityId) return null
      return hyperPay(
        { entityId: settings.settings.entityId, accessToken, mode: settings.settings.mode ?? 'test', brands: settings.settings.brands },
        (reference) => `${pc.apiBase}/payments/hyperpay/${pc.tenantId}/${reference}`,
      )
    }
    case 'test':
      return testProviderAllowed() ? testProvider(pc) : null
  }
}

/** A stand-in gateway: its "payment page" is on this API and the outcome is
 * whatever the tester picks there. */
function testProvider(pc: ProviderContext): PaymentProvider {
  return {
    key: 'test',
    async createCheckout(input) {
      return { redirectUrl: `${pc.apiBase}/payments/test/${pc.tenantId}/${input.reference}`, providerRef: `test_${input.reference}` }
    },
    async status(_ref, reference) {
      const doc = await withTenant(pc.tenantId, (ctx) => ctx.onlinePayments.findOne({ _id: reference }))
      const picked = doc?.testOutcome ?? null
      return {
        status: picked ?? 'pending',
        paymentId: picked === 'paid' ? `test_pay_${reference}` : null,
        amount: doc?.amount ?? null,
        currency: doc?.currency ?? null,
        message: picked === 'failed' ? 'Declined (test)' : null,
      }
    },
    async refund(input) {
      return { ok: true, refundRef: `test_refund_${input.reference}` }
    },
  }
}

export type StartResult =
  | { ok: true; payment: OnlinePaymentDoc; redirectUrl: string }
  | { ok: false; error: string; status: number; outstanding?: number }

/** Opens a checkout for `amount` (default: everything outstanding). */
export async function startCheckout(input: {
  tenantId: string
  studentId: string
  parentId: string | null
  payer: { name: string; email: string | null; phone: string | null }
  amount: number | null
  apiBase: string
  lang: 'en' | 'ar'
  actorId: string | null
}): Promise<StartResult> {
  const pc = { apiBase: input.apiBase, tenantId: input.tenantId }
  type Prepared =
    | { error: string; status: number; outstanding?: number }
    | { doc: OnlinePaymentDoc; provider: PaymentProvider; studentName: string; studentNumber: string }
  const prepared = await withTenant(input.tenantId, async (ctx): Promise<Prepared> => {
    const settings = await loadPaymentSettings(ctx, input.tenantId)
    const provider = providerFor(settings, pc)
    if (!provider) return { error: 'PAYMENTS_OFF', status: 409 }
    const student = await ctx.students.findOne({ _id: input.studentId })
    if (!student) return { error: 'NOT_FOUND', status: 404 }
    const open = await openInvoices(ctx, input.studentId)
    const outstanding = open.reduce((sum, o) => sum + o.outstanding, 0)
    if (outstanding <= 0) return { error: 'NOTHING_OUTSTANDING', status: 409 }
    const amount = input.amount ?? outstanding
    if (amount <= 0) return { error: 'INVALID_AMOUNT', status: 400 }
    if (amount > outstanding) return { error: 'AMOUNT_EXCEEDS_OUTSTANDING', status: 400, outstanding }
    const now = new Date()
    const doc: OnlinePaymentDoc = {
      _id: randomUUID(),
      tenantId: input.tenantId,
      branchId: student.branchId,
      studentId: student._id,
      parentId: input.parentId,
      amount,
      currency: settings.currency,
      provider: settings.provider!,
      providerRef: null,
      providerPaymentId: null,
      status: 'pending',
      message: null,
      paymentBatchId: null,
      receiptId: null,
      overpaid: 0,
      refunded: 0,
      testOutcome: null,
      createdAt: now,
      updatedAt: now,
      settledAt: null,
      createdBy: input.actorId,
    }
    await ctx.onlinePayments.insertOne(doc)
    return { doc, provider, studentName: `${student.givenName} ${student.familyName}`.trim(), studentNumber: student.studentNumber }
  })
  if ('error' in prepared) return { ok: false, ...prepared }

  const { doc, provider } = prepared
  try {
    const checkout = await provider.createCheckout({
      reference: doc._id,
      amount: doc.amount,
      currency: doc.currency,
      description: `School fees — ${prepared.studentName} (${prepared.studentNumber})`,
      customer: input.payer,
      returnUrl: `${input.apiBase}/payments/return/${input.tenantId}/${doc._id}`,
      callbackUrl: `${input.apiBase}/payments/callback/${input.tenantId}/${doc._id}`,
      lang: input.lang,
    })
    const updated = await withTenant(input.tenantId, (ctx) =>
      ctx.onlinePayments.findOneAndUpdate(
        { _id: doc._id },
        { $set: { providerRef: checkout.providerRef, updatedAt: new Date() } },
        { returnDocument: 'after' },
      ),
    )
    return { ok: true, payment: updated!, redirectUrl: checkout.redirectUrl }
  } catch (error) {
    const message = error instanceof GatewayError ? error.message : String(error)
    await withTenant(input.tenantId, (ctx) =>
      ctx.onlinePayments.updateMany({ _id: doc._id }, { $set: { status: 'failed', message, updatedAt: new Date() } }),
    )
    return { ok: false, error: error instanceof GatewayError ? error.code : 'GATEWAY_ERROR', status: 502 }
  }
}

export type SettleResult = { status: OnlinePaymentDoc['status']; payment: OnlinePaymentDoc | null }

/**
 * Asks the gateway how the checkout ended and, if it was paid, records it.
 * Safe to call any number of times, from anywhere, concurrently: only the
 * pending → paid transition records a payment.
 */
export async function settle(tenantId: string, id: string, apiBase: string): Promise<SettleResult> {
  const found = await withTenant(tenantId, async (ctx) => {
    const doc = await ctx.onlinePayments.findOne({ _id: id })
    const settings = doc ? await loadPaymentSettings(ctx, tenantId) : null
    return { doc, settings }
  })
  const doc = found.doc
  if (!doc) return { status: 'failed', payment: null }
  if (doc.status !== 'pending' || !doc.providerRef) return { status: doc.status, payment: doc }
  // Settled with the gateway it was started on, even if the school has
  // switched gateways since.
  const provider = providerFor({ ...found.settings!, enabled: true, provider: doc.provider }, { apiBase, tenantId })
  if (!provider) return { status: doc.status, payment: doc }

  let answer: PaymentStatus
  try {
    answer = await provider.status(doc.providerRef, doc._id)
  } catch {
    return { status: 'pending', payment: doc }
  }
  if (answer.status === 'pending') return { status: 'pending', payment: doc }

  const mismatch =
    answer.status === 'paid' &&
    ((answer.amount !== null && answer.amount !== doc.amount) || (answer.currency !== null && answer.currency !== doc.currency))

  const result = await withTenant(tenantId, async (ctx) => {
    const now = new Date()
    if (answer.status === 'failed' || mismatch) {
      const failed = await ctx.onlinePayments.findOneAndUpdate(
        { _id: id, status: 'pending' },
        {
          $set: {
            status: 'failed',
            message: mismatch ? `AMOUNT_MISMATCH: gateway ${answer.amount} ${answer.currency}` : answer.message,
            updatedAt: now,
          },
        },
        { returnDocument: 'after' },
      )
      return failed ?? (await ctx.onlinePayments.findOne({ _id: id }))
    }
    // Claim the transition first: a second settle finds it no longer pending.
    const claimed = await ctx.onlinePayments.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'paid', providerPaymentId: answer.paymentId, message: answer.message, settledAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    )
    if (!claimed) return ctx.onlinePayments.findOne({ _id: id })

    const open = await openInvoices(ctx, claimed.studentId)
    const outstanding = open.reduce((sum, o) => sum + o.outstanding, 0)
    let allocations: { invoiceId: string; amount: number }[] = []
    if (outstanding > 0) {
      const split = allocate(open, Math.min(claimed.amount, outstanding))
      if (split.ok) allocations = split.allocations
    }
    let overpaid = claimed.amount - allocations.reduce((sum, a) => sum + a.amount, 0)
    if (overpaid > 0) {
      // Paid while the office took a payment too: the rest stays as credit
      // on the latest invoice, flagged for the office to refund or keep.
      const latest = allocations.length
        ? allocations[allocations.length - 1]!.invoiceId
        : (await ctx.invoices.find({ studentId: claimed.studentId, status: { $ne: 'void' } }).sort({ issueDate: -1 }).limit(1).toArray())[0]?._id
      if (latest) {
        const existing = allocations.find((a) => a.invoiceId === latest)
        if (existing) existing.amount += overpaid
        else allocations.push({ invoiceId: latest, amount: overpaid })
      } else {
        overpaid = claimed.amount
      }
    }
    const parent = claimed.parentId ? await ctx.parents.findOne({ _id: claimed.parentId }) : null
    let batchId: string | null = null
    let receiptId: string | null = null
    if (allocations.length > 0) {
      const recorded = await recordPayments(ctx, tenantId, {
        studentId: claimed.studentId,
        allocations,
        method: 'online',
        reference: answer.paymentId ?? claimed.providerRef,
        paidAt: now.toISOString().slice(0, 10),
        payerName: parent?.fullName ?? 'Online payment',
        notes: `${claimed.provider} ${claimed.providerRef}`,
        actorId: null,
      })
      if (recorded.ok) {
        batchId = recorded.payments[0]?.batchId ?? null
        receiptId = recorded.receipt?._id ?? null
      }
    }
    const settled = await ctx.onlinePayments.findOneAndUpdate(
      { _id: id },
      { $set: { paymentBatchId: batchId, receiptId, overpaid: Math.max(0, overpaid), updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
    await recordAudit(ctx.auditLog, {
      actorId: null,
      action: 'onlinePayment.settle',
      entity: 'onlinePayment',
      entityId: id,
      branchId: claimed.branchId,
      before: { status: 'pending' },
      after: { status: 'paid', amount: claimed.amount, currency: claimed.currency, provider: claimed.provider, receiptId, overpaid },
    })
    return settled
  })
  return { status: result?.status ?? 'failed', payment: result }
}

/** The sweep: checks payments the family never came back from. Anything
 * still pending after two days is given up (a checkout page expires long
 * before). */
export async function reconcilePending(apiBase: string): Promise<number> {
  const now = Date.now()
  const pending = await withoutTenant((db) =>
    db.onlinePayments
      .find({ status: 'pending', createdAt: { $lt: new Date(now - 2 * 60_000) } })
      .limit(200)
      .toArray(),
  )
  let settled = 0
  for (const p of pending) {
    const out = await settle(p.tenantId, p._id, apiBase)
    if (out.status === 'paid') settled++
    else if (out.status === 'pending' && p.createdAt.getTime() < now - 2 * 86_400_000) {
      await withTenant(p.tenantId, (ctx) =>
        ctx.onlinePayments.updateMany({ _id: p._id, status: 'pending' }, { $set: { status: 'cancelled', message: 'EXPIRED', updatedAt: new Date() } }),
      )
    }
  }
  return settled
}

export function onlinePaymentResponse(doc: OnlinePaymentDoc, names?: { student?: string }) {
  return {
    id: doc._id,
    studentId: doc.studentId,
    studentName: names?.student ?? null,
    branchId: doc.branchId,
    amount: doc.amount,
    currency: doc.currency,
    provider: doc.provider,
    providerRef: doc.providerRef,
    status: doc.status,
    message: doc.message,
    receiptId: doc.receiptId,
    overpaid: doc.overpaid,
    refunded: doc.refunded,
    createdAt: doc.createdAt.toISOString(),
    settledAt: doc.settledAt?.toISOString() ?? null,
  }
}

/**
 * Sends an approved refund back to the card it was paid with: an online
 * payment of the same student that went into the refund's invoice and has
 * enough left unrefunded. The gateway's refund id becomes the reference.
 */
export async function refundOnline(
  tenantId: string,
  refund: RefundDoc,
  apiBase: string,
): Promise<{ ok: true; refundRef: string } | { ok: false; error: string }> {
  const found = await withTenant(tenantId, async (ctx) => {
    const payments = await ctx.payments.find({ invoiceId: refund.invoiceId, method: 'online', voidedAt: null }).toArray()
    const batches = [...new Set(payments.map((p) => p.batchId).filter((b): b is string => Boolean(b)))]
    const online = await ctx.onlinePayments.find({ paymentBatchId: { $in: batches }, status: 'paid' }).sort({ settledAt: -1 }).toArray()
    const settings = await loadPaymentSettings(ctx, tenantId)
    return { online: online.find((o) => o.amount - o.refunded >= refund.amount) ?? null, settings }
  })
  if (!found.online) return { ok: false, error: 'NO_ONLINE_PAYMENT_TO_REFUND' }
  const doc = found.online
  const provider = providerFor({ ...found.settings, enabled: true, provider: doc.provider }, { apiBase, tenantId })
  if (!provider || !doc.providerRef) return { ok: false, error: 'PAYMENTS_OFF' }
  const out = await provider.refund({
    providerRef: doc.providerRef,
    paymentId: doc.providerPaymentId,
    reference: doc._id,
    amount: refund.amount,
    currency: doc.currency,
    reason: refund.reason,
  })
  if (!out.ok) return { ok: false, error: `GATEWAY_REFUSED: ${out.error}` }
  await withTenant(tenantId, (ctx) =>
    ctx.onlinePayments.updateMany({ _id: doc._id }, { $inc: { refunded: refund.amount }, $set: { updatedAt: new Date() } }),
  )
  return { ok: true, refundRef: out.refundRef || `${doc.provider}:${doc.providerRef}` }
}
