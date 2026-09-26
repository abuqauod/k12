import { randomUUID } from 'node:crypto'
// The driver's $push typing trips over Document's index signature.
import { MongoServerError, type UpdateFilter } from 'mongodb'
import { config } from '../config.js'
import { withTenant, withoutTenant } from '../db.js'
import type { SubscriptionCheckoutDoc, SubscriptionInvoiceDoc, TenantDoc } from '../db.js'
import { EmailNotConfiguredError, sendPlainEmail } from '../email.js'
import { withLock } from '../lock.js'
import { payTabs } from '../payments/providers/paytabs.js'
import { hyperPay } from '../payments/providers/hyperpay.js'
import { major, type PaymentProvider, type PaymentStatus } from '../payments/providers/types.js'
import { testProviderAllowed } from '../payments/service.js'
import { CURRENCIES, PLANS, TRIAL_DAYS, planOf, termPrice, type Currency, type PlanKey } from './plans.js'

/**
 * SAMS 13.3 — billing schools for their subscription: an invoice for the
 * next period at the price list, paid by card through the vendor's own
 * gateway or by bank transfer recorded in the console; paying moves the
 * school's paid-through date and plan. Renewal invoices and reminders go out
 * from the daily sweep.
 */

/** Sales tax on the vendor's invoices, by the school's country, in percent.
 * Defaults only — the vendor's accountant decides (VENDOR_TAX_RATES,
 * e.g. {"JO":16,"SA":15,"AE":5}); the console can set it per invoice. */
export function taxRateFor(country: string | null | undefined): number {
  let rates: Record<string, number> = { JO: 16, SA: 15, AE: 5 }
  try {
    if (process.env.VENDOR_TAX_RATES) rates = JSON.parse(process.env.VENDOR_TAX_RATES) as Record<string, number>
  } catch {
    // Keep the defaults.
  }
  return (country && rates[country.toUpperCase()]) || 0
}

export const INVOICE_DUE_DAYS = 14
/** Grace days a paying school gets; a trial ends on its day. */
export const PAID_GRACE_DAYS = 14

const iso = (d: Date) => d.toISOString().slice(0, 10)
const today = () => iso(new Date())
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return iso(d)
}
function addTerm(date: string, term: 'year' | 'month'): string {
  const d = new Date(`${date}T00:00:00Z`)
  if (term === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1)
  else d.setUTCMonth(d.getUTCMonth() + 1)
  d.setUTCDate(d.getUTCDate() - 1)
  return iso(d)
}

/** The period the next invoice buys: straight after the paid-through date,
 * or from today for a trial or a lapsed school. */
export function nextPeriod(tenant: Pick<TenantDoc, 'plan' | 'validUntil'>, term: 'year' | 'month', on = today()) {
  const continues = tenant.plan !== 'trial' && tenant.validUntil !== null && tenant.validUntil >= on
  const start = continues ? addDays(tenant.validUntil!, 1) : on
  return { periodStart: start, periodEnd: addTerm(start, term) }
}

async function enrolledStudents(tenantId: string): Promise<number> {
  return withTenant(tenantId, (ctx) => ctx.students.countDocuments({ status: 'enrolled' }))
}

export interface QuoteInput {
  plan: PlanKey
  term: 'year' | 'month'
  currency?: Currency
  /** Students to bill; at least those enrolled. */
  students?: number
  taxRate?: number
  extraLines?: { label: string; amount: number }[]
}

export async function quote(tenant: TenantDoc, input: QuoteInput) {
  const plan = PLANS[input.plan]
  if (!plan.price) throw new Error('PLAN_NOT_SOLD')
  const currency = input.currency ?? tenant.billing?.currency ?? 'USD'
  const students = Math.max(input.students ?? tenant.billing?.students ?? 0, await enrolledStudents(tenant._id))
  const { periodStart, periodEnd } = nextPeriod(tenant, input.term)
  const base = termPrice(plan, currency, students, input.term)
  const lines = [
    {
      label: `${plan.key[0]!.toUpperCase()}${plan.key.slice(1)} plan, ${students} students, ${periodStart} to ${periodEnd}`,
      amount: base,
    },
    ...(input.extraLines ?? []),
  ]
  const subtotal = lines.reduce((s, l) => s + l.amount, 0)
  const taxRate = input.taxRate ?? taxRateFor(tenant.billing?.country)
  const tax = Math.round((subtotal * taxRate) / 100)
  return { plan: plan.key, term: input.term, currency, students, periodStart, periodEnd, lines, subtotal, taxRate, tax, total: subtotal + tax }
}

async function nextNumber(year: string): Promise<string> {
  const count = await withoutTenant((db) => db.subscriptionInvoices.countDocuments({ number: { $regex: `^SUB-${year}-` } }))
  return `SUB-${year}-${String(count + 1).padStart(4, '0')}`
}

/** Where a school's billing emails go: its billing address, else its owners. */
export async function billingRecipients(tenant: TenantDoc): Promise<string[]> {
  if (tenant.billing?.email) return [tenant.billing.email]
  return withoutTenant(async (db) => {
    const owners = await db.memberships.find({ tenantId: tenant._id, role: 'owner' }).toArray()
    const users = await db.users.find({ _id: { $in: owners.map((o) => o.userId) }, active: true }).toArray()
    return users.map((u) => u.email)
  })
}

const money = (amount: number, currency: string) => `${major(amount)} ${currency}`

async function mailSchool(tenant: TenantDoc, subject: string, body: string): Promise<void> {
  for (const to of await billingRecipients(tenant)) {
    await sendPlainEmail({ to, subject, body }).catch((error) => {
      // No mail server is the operator's to fix (preflight says so).
      if (!(error instanceof EmailNotConfiguredError)) console.error('billing email failed', error)
    })
  }
}

export async function createInvoice(
  tenant: TenantDoc,
  input: QuoteInput & { source: SubscriptionInvoiceDoc['source']; createdBy: string | null; dueDays?: number },
): Promise<SubscriptionInvoiceDoc> {
  const q = await quote(tenant, input)
  const now = new Date()
  for (let attempt = 0; ; attempt++) {
    const doc: SubscriptionInvoiceDoc = {
      _id: randomUUID(),
      number: await nextNumber(String(now.getUTCFullYear())),
      tenantId: tenant._id,
      ...q,
      status: 'open',
      dueDate: addDays(today(), input.dueDays ?? INVOICE_DUE_DAYS),
      issuedAt: now,
      paidAt: null,
      paidBy: null,
      reference: null,
      source: input.source,
      reminders: [],
      createdBy: input.createdBy,
      updatedAt: now,
    }
    try {
      await withoutTenant((db) => db.subscriptionInvoices.insertOne(doc))
    } catch (error) {
      // Two invoices numbered at once: take the next number.
      if (error instanceof MongoServerError && error.code === 11000 && attempt < 5) continue
      throw error
    }
    await mailSchool(
      tenant,
      `Invoice ${doc.number} — ${tenant.name}`,
      [
        `Invoice ${doc.number} for ${tenant.name}: ${money(doc.total, doc.currency)}, due ${doc.dueDate}.`,
        ...doc.lines.map((l) => `${l.label}: ${money(l.amount, doc.currency)}`),
        doc.tax ? `Tax (${doc.taxRate}%): ${money(doc.tax, doc.currency)}` : '',
        `Pay by card or see the bank details in Settings → Subscription: ${config.appUrl}/settings/subscription`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
    return doc
  }
}

/**
 * Records an invoice as paid and gives the school what it bought: the plan,
 * paid through the invoice's period. Exactly once — only the open → paid
 * transition applies it.
 */
export async function applyPayment(
  invoiceId: string,
  payment: { paidBy: 'card' | 'transfer'; reference: string | null; paidAt?: Date },
): Promise<{ ok: true; invoice: SubscriptionInvoiceDoc } | { ok: false; error: 'NOT_FOUND' | 'NOT_OPEN' }> {
  const now = new Date()
  const invoice = await withoutTenant((db) =>
    db.subscriptionInvoices.findOneAndUpdate(
      { _id: invoiceId, status: 'open' },
      { $set: { status: 'paid', paidAt: payment.paidAt ?? now, paidBy: payment.paidBy, reference: payment.reference, updatedAt: now } },
      { returnDocument: 'after' },
    ),
  )
  if (!invoice) {
    const exists = await withoutTenant((db) => db.subscriptionInvoices.findOne({ _id: invoiceId }))
    return { ok: false, error: exists ? 'NOT_OPEN' : 'NOT_FOUND' }
  }
  const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: invoice.tenantId }))
  if (tenant) {
    // Never shortens what was already paid for (an early renewal adds on).
    const validUntil = tenant.validUntil && tenant.plan !== 'trial' && tenant.validUntil > invoice.periodEnd ? tenant.validUntil : invoice.periodEnd
    await withoutTenant((db) =>
      db.tenants.updateOne(
        { _id: tenant._id },
        {
          $set: {
            plan: invoice.plan,
            validUntil,
            status: 'active',
            graceDays: Math.max(tenant.graceDays, PAID_GRACE_DAYS),
            billing: {
              currency: invoice.currency,
              term: invoice.term,
              students: invoice.students,
              email: tenant.billing?.email ?? null,
              country: tenant.billing?.country ?? null,
            },
            updatedAt: now,
          },
        },
      ),
    )
    await mailSchool(
      tenant,
      `Payment received — ${invoice.number}`,
      `Thank you. ${money(invoice.total, invoice.currency)} received for invoice ${invoice.number}. ${tenant.name} is on the ${invoice.plan} plan, paid through ${validUntil}.`,
    )
  }
  return { ok: true, invoice }
}

// ------------------------------------------------------ vendor gateway --

export type VendorProviderKey = 'paytabs' | 'hyperpay' | 'test'

/** The vendor's own merchant account, from the environment — the schools'
 * gateways (SAMS 11.1) take fees for the school, this one for the vendor. */
export function vendorProviderKey(): VendorProviderKey | null {
  const key = process.env.VENDOR_PAYMENT_PROVIDER
  if (key === 'paytabs' || key === 'hyperpay') return key
  if (key === 'test' && testProviderAllowed()) return 'test'
  // Development: the test gateway when nothing is set up.
  if (!key && testProviderAllowed()) return 'test'
  return null
}

export function vendorProvider(apiBase: string, key = vendorProviderKey()): PaymentProvider | null {
  switch (key) {
    case 'paytabs': {
      const profileId = process.env.VENDOR_PAYTABS_PROFILE_ID
      const serverKey = process.env.VENDOR_PAYTABS_SERVER_KEY
      if (!profileId || !serverKey) return null
      return payTabs({ profileId, serverKey, region: process.env.VENDOR_PAYTABS_REGION ?? 'jordan' })
    }
    case 'hyperpay': {
      const entityId = process.env.VENDOR_HYPERPAY_ENTITY_ID
      const accessToken = process.env.VENDOR_HYPERPAY_ACCESS_TOKEN
      if (!entityId || !accessToken) return null
      return hyperPay(
        { entityId, accessToken, mode: process.env.VENDOR_HYPERPAY_MODE ?? 'test', brands: process.env.VENDOR_HYPERPAY_BRANDS },
        (reference) => `${apiBase}/billing/hyperpay/${reference}`,
      )
    }
    case 'test':
      return {
        key: 'test',
        async createCheckout(input) {
          return { redirectUrl: `${apiBase}/billing/test/${input.reference}`, providerRef: `test_${input.reference}` }
        },
        async status(_ref, reference) {
          const doc = await withoutTenant((db) => db.subscriptionCheckouts.findOne({ _id: reference }))
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
    default:
      return null
  }
}

export async function startCardPayment(input: {
  invoice: SubscriptionInvoiceDoc
  tenant: TenantDoc
  userId: string
  customer: { name: string; email: string | null }
  apiBase: string
  lang: 'en' | 'ar'
}): Promise<{ ok: true; redirectUrl: string; checkoutId: string } | { ok: false; error: string }> {
  const key = vendorProviderKey()
  const provider = key ? vendorProvider(input.apiBase, key) : null
  if (!key || !provider) return { ok: false, error: 'CARD_PAYMENT_UNAVAILABLE' }
  if (input.invoice.status !== 'open') return { ok: false, error: 'NOT_OPEN' }
  const checkout: SubscriptionCheckoutDoc = {
    _id: randomUUID(),
    invoiceId: input.invoice._id,
    tenantId: input.tenant._id,
    amount: input.invoice.total,
    currency: input.invoice.currency,
    provider: key,
    providerRef: null,
    status: 'pending',
    message: null,
    createdBy: input.userId,
    createdAt: new Date(),
    settledAt: null,
  }
  await withoutTenant((db) => db.subscriptionCheckouts.insertOne(checkout))
  try {
    const result = await provider.createCheckout({
      reference: checkout._id,
      amount: checkout.amount,
      currency: checkout.currency,
      description: `${input.invoice.number} — ${input.tenant.name}`,
      customer: { name: input.customer.name, email: input.customer.email, phone: null },
      returnUrl: `${input.apiBase}/billing/return/${checkout._id}`,
      callbackUrl: `${input.apiBase}/billing/callback/${checkout._id}`,
      lang: input.lang,
    })
    await withoutTenant((db) => db.subscriptionCheckouts.updateOne({ _id: checkout._id }, { $set: { providerRef: result.providerRef } }))
    return { ok: true, redirectUrl: result.redirectUrl, checkoutId: checkout._id }
  } catch (error) {
    await withoutTenant((db) =>
      db.subscriptionCheckouts.updateOne({ _id: checkout._id }, { $set: { status: 'failed', message: String((error as Error).message).slice(0, 300) } }),
    )
    return { ok: false, error: 'GATEWAY_ERROR' }
  }
}

/**
 * Asks the vendor's gateway how a card payment ended; a paid one pays its
 * invoice. Safe to repeat: only pending → paid applies anything, and the
 * invoice itself applies once.
 */
export async function settleCardPayment(checkoutId: string, apiBase: string): Promise<SubscriptionCheckoutDoc | null> {
  const doc = await withoutTenant((db) => db.subscriptionCheckouts.findOne({ _id: checkoutId }))
  if (!doc || doc.status !== 'pending' || !doc.providerRef) return doc
  const provider = vendorProvider(apiBase, doc.provider)
  if (!provider) return doc
  let answer: PaymentStatus
  try {
    answer = await provider.status(doc.providerRef, doc._id)
  } catch {
    return doc
  }
  if (answer.status === 'pending') return doc
  const mismatch =
    answer.status === 'paid' &&
    ((answer.amount !== null && answer.amount !== doc.amount) || (answer.currency !== null && answer.currency !== doc.currency))
  const paid = answer.status === 'paid' && !mismatch
  const claimed = await withoutTenant((db) =>
    db.subscriptionCheckouts.findOneAndUpdate(
      { _id: doc._id, status: 'pending' },
      {
        $set: {
          status: paid ? 'paid' : 'failed',
          message: mismatch ? `AMOUNT_MISMATCH: gateway ${answer.amount} ${answer.currency}` : answer.message,
          settledAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    ),
  )
  if (!claimed) return withoutTenant((db) => db.subscriptionCheckouts.findOne({ _id: doc._id }))
  if (paid) {
    const applied = await applyPayment(claimed.invoiceId, { paidBy: 'card', reference: answer.paymentId ?? claimed.providerRef })
    // Paid twice for one invoice (two tabs): the vendor refunds by hand.
    if (!applied.ok) console.error(`card payment ${claimed._id} for invoice ${claimed.invoiceId}: ${applied.error}`)
  }
  return claimed
}

// ------------------------------------------------------- daily sweep --

/** Renewal invoices this many days before the paid-through date. */
export const RENEW_DAYS_BEFORE = 30
/** Reminders on an open invoice, by days from its due date. */
const REMINDERS: [string, number][] = [
  ['due-7', -7],
  ['due', 0],
  ['overdue-7', 7],
]
/** Trial reminders, by days before it ends. */
const TRIAL_REMINDERS: [string, number][] = [
  ['trial-7', 7],
  ['trial-1', 1],
]

/**
 * Once a day: renewal invoices for paying schools nearing their date,
 * reminders on open invoices, and trial-ending notices; pending card
 * payments are asked about too.
 */
export async function runBillingSweep(apiBase: string, on = today()): Promise<{ renewals: number; reminders: number }> {
  return (
    (await withLock('billing-sweep', 15 * 60_000, async () => {
      let renewals = 0
      let reminders = 0
      const tenants = await withoutTenant((db) => db.tenants.find({ status: 'active' }).toArray())
      for (const tenant of tenants) {
        const plan = planOf(tenant)
        // Renewals: a sold plan, billed on file, due within the window, and
        // no open invoice already covering the next period.
        if (plan?.price && tenant.billing && tenant.validUntil && tenant.validUntil <= addDays(on, RENEW_DAYS_BEFORE)) {
          const open = await withoutTenant((db) => db.subscriptionInvoices.countDocuments({ tenantId: tenant._id, status: 'open' }))
          const next = nextPeriod(tenant, tenant.billing.term, on)
          const covered = await withoutTenant((db) =>
            db.subscriptionInvoices.countDocuments({ tenantId: tenant._id, status: 'paid', periodStart: next.periodStart }),
          )
          if (!open && !covered && (CURRENCIES as readonly string[]).includes(tenant.billing.currency)) {
            await createInvoice(tenant, {
              plan: plan.key,
              term: tenant.billing.term,
              source: 'renewal',
              createdBy: null,
              // Due on the last paid day, so the grace days are the margin.
              dueDays: Math.max(0, Math.round((Date.parse(tenant.validUntil) - Date.parse(on)) / 86_400_000)),
            })
            renewals++
          }
        }
        // Trials ending.
        if (tenant.plan === 'trial' && tenant.validUntil) {
          for (const [key, before] of TRIAL_REMINDERS) {
            if (addDays(on, before) !== tenant.validUntil) continue
            const marked = await withoutTenant((db) =>
              db.tenants.updateOne({ _id: tenant._id, trialReminders: { $ne: key } }, { $push: { trialReminders: key } } as unknown as UpdateFilter<TenantDoc>),
            )
            if (!marked.modifiedCount) continue
            await mailSchool(
              tenant,
              `Your trial ends on ${tenant.validUntil}`,
              [
                `The free trial of ${tenant.name} ends on ${tenant.validUntil}.`,
                `Choose a plan to keep going — everything you set up stays: ${config.appUrl}/settings/subscription`,
                `After the trial your data stays readable for 60 days, so nothing is lost while you decide.`,
              ].join('\n\n'),
            )
            reminders++
          }
        }
      }
      // Reminders on open invoices.
      const open = await withoutTenant((db) => db.subscriptionInvoices.find({ status: 'open' }).toArray())
      for (const invoice of open) {
        for (const [key, offset] of REMINDERS) {
          if (invoice.reminders.includes(key) || addDays(invoice.dueDate, offset) > on) continue
          // Only the latest reminder due is sent; earlier ones are marked.
          const later = REMINDERS.filter(([, o]) => o > offset && addDays(invoice.dueDate, o) <= on)
          const marked = await withoutTenant((db) =>
            db.subscriptionInvoices.updateOne({ _id: invoice._id, reminders: { $ne: key } }, { $push: { reminders: key } } as unknown as UpdateFilter<SubscriptionInvoiceDoc>),
          )
          if (!marked.modifiedCount || later.length) continue
          const tenant = await withoutTenant((db) => db.tenants.findOne({ _id: invoice.tenantId }))
          if (!tenant) continue
          const when = offset < 0 ? `is due on ${invoice.dueDate}` : offset === 0 ? 'is due today' : `was due on ${invoice.dueDate}`
          await mailSchool(
            tenant,
            `Reminder: invoice ${invoice.number} ${offset > 0 ? 'overdue' : 'due'}`,
            `Invoice ${invoice.number} (${money(invoice.total, invoice.currency)}) ${when}. Pay by card or bank transfer: ${config.appUrl}/settings/subscription`,
          )
          reminders++
        }
      }
      // Card payments nobody came back from.
      const pending = await withoutTenant((db) =>
        db.subscriptionCheckouts.find({ status: 'pending', createdAt: { $lt: new Date(Date.now() - 10 * 60_000) } }).toArray(),
      )
      for (const c of pending) await settleCardPayment(c._id, apiBase)
      return { renewals, reminders }
    })) ?? { renewals: 0, reminders: 0 }
  )
}

export { TRIAL_DAYS }
