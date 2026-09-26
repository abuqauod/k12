import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withoutTenant } from '../db.js'
import type { TenantBilling } from '../db.js'
import { createBranchForTenant } from '../branches/service.js'
import { inviteUserToTenant } from '../memberships/invite.js'
import { EmailNotConfiguredError, sendPlainEmail } from '../email.js'
import { emailLimiter } from '../runtime/rateLimit.js'
import { CURRENCIES, MODULES, MONTHLY_UPLIFT, PLANS, TRIAL_DAYS, type Currency } from './plans.js'

/**
 * SAMS 13.2 / 13.5 — the two things anyone may ask without an account: the
 * price list, and a free trial. A trial is a school on the `trial` plan for
 * TRIAL_DAYS, with a first campus and its owner invited by email; the email
 * link is the proof the address is real, as for any invite.
 */

/** Where the school is decides its currency and first campus's time zone. */
const COUNTRIES: Record<string, { currency: Currency; timezone: string }> = {
  JO: { currency: 'JOD', timezone: 'Asia/Amman' },
  SA: { currency: 'SAR', timezone: 'Asia/Riyadh' },
  AE: { currency: 'AED', timezone: 'Asia/Dubai' },
  KW: { currency: 'USD', timezone: 'Asia/Kuwait' },
  QA: { currency: 'USD', timezone: 'Asia/Qatar' },
  BH: { currency: 'USD', timezone: 'Asia/Bahrain' },
  OM: { currency: 'USD', timezone: 'Asia/Muscat' },
  EG: { currency: 'USD', timezone: 'Africa/Cairo' },
  IQ: { currency: 'USD', timezone: 'Asia/Baghdad' },
  PS: { currency: 'USD', timezone: 'Asia/Hebron' },
  LB: { currency: 'USD', timezone: 'Asia/Beirut' },
}

const signupBody = z.object({
  schoolName: z.string().trim().min(2).max(200),
  ownerName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(40).optional(),
  country: z.string().length(2).toUpperCase(),
  /** About how many students — sizes the quote, not the trial. */
  students: z.number().int().min(1).max(100_000).optional(),
  /** A field people don't see; bots fill it in. */
  website: z.string().max(500).optional(),
})

export function slugFor(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  // Arabic-only names leave nothing: the random part alone then.
  const suffix = randomBytes(3).toString('hex')
  return base ? `${base}-${suffix}` : `school-${suffix}`
}

const addDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

export function registerBillingPublicRoutes(app: FastifyInstance): void {
  /** The price list, for the pricing page. */
  app.get('/public/plans', async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=300').send({
      currencies: CURRENCIES,
      monthlyUplift: MONTHLY_UPLIFT,
      trialDays: TRIAL_DAYS,
      modules: MODULES,
      plans: Object.values(PLANS)
        .filter((p) => p.listed)
        .map((p) => ({ key: p.key, modules: p.modules, limits: p.limits, price: p.price })),
      signupOpen: process.env.SIGNUP !== 'off',
    }),
  )

  app.post('/public/signup', { preHandler: emailLimiter.guard }, async (request, reply) => {
    if (process.env.SIGNUP === 'off') return reply.code(403).send({ error: 'SIGNUP_CLOSED' })
    const parsed = signupBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_BODY' })
    const body = parsed.data
    // The hidden field: look successful, create nothing.
    if (body.website) return reply.code(201).send({ ok: true })

    const email = body.email.toLowerCase()
    const place = COUNTRIES[body.country] ?? { currency: 'USD' as Currency, timezone: 'UTC' }
    // One trial per address: a second one would just restart the clock.
    const earlier = await withoutTenant((db) => db.tenants.countDocuments({ source: 'signup', 'billing.email': email }))
    if (earlier) return reply.code(409).send({ error: 'ALREADY_SIGNED_UP' })

    const tenantId = randomUUID()
    const slug = slugFor(body.schoolName)
    const now = new Date()
    const billing: TenantBilling = {
      currency: place.currency,
      term: 'year',
      students: body.students ?? 0,
      email,
      country: body.country,
    }
    await withoutTenant((db) =>
      db.tenants.insertOne({
        _id: tenantId,
        slug,
        name: body.schoolName,
        profile: { nameAr: null, phone: body.phone ?? null, email, address: null, website: null, taxNumber: null },
        plan: 'trial',
        status: 'active',
        seats: 25,
        validUntil: addDays(TRIAL_DAYS),
        graceDays: 0,
        billing,
        source: 'signup',
        createdAt: now,
        updatedAt: now,
      }),
    )
    await createBranchForTenant(tenantId, { name: 'Main campus', code: 'main', address: null, timezone: place.timezone })

    let invite: string
    try {
      invite = (
        await inviteUserToTenant({
          email,
          tenantId,
          tenantName: body.schoolName,
          role: 'owner',
          inviterName: 'ArrangeMySchool',
          displayName: body.ownerName,
        })
      ).outcome
    } catch (error) {
      invite = error instanceof EmailNotConfiguredError ? 'EMAIL_NOT_CONFIGURED' : 'EMAIL_SEND_FAILED'
      request.log.error(error, 'trial sign-up: owner invite not sent')
    }

    // The sales team hears of every new trial.
    const notify = process.env.SALES_NOTIFY_EMAIL
    if (notify) {
      void sendPlainEmail({
        to: notify,
        subject: `New trial: ${body.schoolName}`,
        body: [
          `${body.schoolName} (${slug}) started a ${TRIAL_DAYS}-day trial.`,
          `Contact: ${body.ownerName}, ${email}${body.phone ? `, ${body.phone}` : ''}`,
          `Country: ${body.country} · about ${body.students ?? '?'} students`,
        ].join('\n'),
      }).catch(() => undefined)
    }
    return reply.code(201).send({ ok: true, slug, trialEndsOn: addDays(TRIAL_DAYS), invite })
  })
}
