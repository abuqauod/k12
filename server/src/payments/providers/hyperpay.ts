import { GatewayError, major, minor, type CheckoutInput, type PaymentProvider, type PaymentStatus, type RefundResult } from './types.js'

/**
 * HyperPay (OPPWA COPYandPAY): the school's entity id and access token. A
 * checkout id is created server-side; the card form is HyperPay's widget,
 * shown on a small page this API serves (`/payments/hyperpay/:id`), which
 * returns the family's browser to `returnUrl`.
 * https://wordpresshyperpay.docs.oppwa.com/integrations/widget
 */

export interface HyperPayCredentials {
  entityId: string
  accessToken: string
  /** `test` or `live`. */
  mode: string
  /** Card brands for the widget, e.g. "VISA MASTER MADA". */
  brands?: string
}

// Successful / pending result codes, as HyperPay documents them.
const SUCCESS = /^(000\.000\.|000\.100\.1|000\.[36])/
const PENDING = /^(000\.200)/

export function hyperPayBase(mode: string): string {
  return process.env.HYPERPAY_BASE_URL ?? (mode === 'live' ? 'https://eu-prod.oppwa.com' : 'https://eu-test.oppwa.com')
}

interface OppwaResponse {
  id?: string
  amount?: string
  currency?: string
  result?: { code?: string; description?: string }
}

export function hyperPay(creds: HyperPayCredentials, pageUrl: (reference: string) => string): PaymentProvider {
  const base = hyperPayBase(creds.mode)

  async function call(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<OppwaResponse> {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${creds.accessToken}`,
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new GatewayError(`HyperPay unreachable: ${(error as Error).message}`, 'GATEWAY_UNREACHABLE')
    }
    const json = (await res.json().catch(() => ({}))) as OppwaResponse
    if (res.status === 401 || res.status === 403) throw new GatewayError('HyperPay refused the access token', 'GATEWAY_AUTH')
    return json
  }

  const outcome = (r: OppwaResponse): PaymentStatus => {
    const code = r.result?.code ?? ''
    return {
      status: SUCCESS.test(code) ? 'paid' : PENDING.test(code) || !code ? 'pending' : 'failed',
      paymentId: r.id ?? null,
      amount: r.amount ? minor(r.amount) : null,
      currency: r.currency ?? null,
      message: r.result?.description ?? null,
    }
  }

  return {
    key: 'hyperpay',

    async createCheckout(input: CheckoutInput) {
      const r = await call('POST', '/v1/checkouts', {
        entityId: creds.entityId,
        amount: major(input.amount),
        currency: input.currency,
        paymentType: 'DB',
        merchantTransactionId: input.reference,
        ...(input.customer.email ? { 'customer.email': input.customer.email } : {}),
        'customer.givenName': input.customer.name.slice(0, 48),
      })
      if (!r.id) throw new GatewayError(`HyperPay gave no checkout: ${r.result?.description ?? ''}`)
      return { redirectUrl: pageUrl(input.reference), providerRef: r.id }
    },

    async status(providerRef: string) {
      return outcome(await call('GET', `/v1/checkouts/${encodeURIComponent(providerRef)}/payment?entityId=${encodeURIComponent(creds.entityId)}`))
    },

    async refund(input): Promise<RefundResult> {
      if (!input.paymentId) return { ok: false, error: 'NO_PAYMENT_ID' }
      try {
        const r = await call('POST', `/v1/payments/${encodeURIComponent(input.paymentId)}`, {
          entityId: creds.entityId,
          amount: major(input.amount),
          currency: input.currency,
          paymentType: 'RF',
        })
        if (!SUCCESS.test(r.result?.code ?? '')) return { ok: false, error: r.result?.description ?? 'REFUND_DECLINED' }
        return { ok: true, refundRef: r.id ?? '' }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    },
  }
}

/** The page that shows HyperPay's card widget for one checkout. */
export function hyperPayPage(opts: { base: string; checkoutId: string; returnUrl: string; brands: string; lang: 'en' | 'ar'; title: string; amount: string }): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html>
<html lang="${opts.lang}" dir="${opts.lang === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7fb;margin:0;padding:24px 16px;color:#1c1d2b}
main{max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;color:#5b5d72}</style>
<script>var wpwlOptions = { locale: "${opts.lang}", style: "card" }</script>
<script async src="${esc(opts.base)}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(opts.checkoutId)}"></script>
</head>
<body><main><h1>${esc(opts.title)}</h1><p>${esc(opts.amount)}</p>
<form action="${esc(opts.returnUrl)}" class="paymentWidgets" data-brands="${esc(opts.brands)}"></form>
</main></body></html>`
}
