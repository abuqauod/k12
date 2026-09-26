import { createHmac, timingSafeEqual } from 'node:crypto'
import { GatewayError, major, minor, type CheckoutInput, type PaymentProvider, type PaymentStatus, type RefundResult } from './types.js'

/**
 * PayTabs (PT2 API): a hosted payment page. The school's profile id and
 * server key; the region picks the endpoint its account lives on.
 * https://site.paytabs.com/en/pt2-documentation/
 */

export const PAYTABS_REGIONS: Record<string, string> = {
  jordan: 'https://secure-jordan.paytabs.com',
  uae: 'https://secure.paytabs.com',
  saudi: 'https://secure.paytabs.sa',
  egypt: 'https://secure-egypt.paytabs.com',
  oman: 'https://secure-oman.paytabs.com',
  global: 'https://secure-global.paytabs.com',
}

export interface PayTabsCredentials {
  profileId: string
  serverKey: string
  region: string
}

interface PayTabsResult {
  response_status?: string
  response_code?: string
  response_message?: string
}

interface PayTabsResponse {
  tran_ref?: string
  redirect_url?: string
  cart_amount?: string
  cart_currency?: string
  payment_result?: PayTabsResult
  message?: string
  code?: number
}

export function payTabs(creds: PayTabsCredentials): PaymentProvider {
  // PAYTABS_BASE_URL points every school at a stand-in gateway (tests).
  const base = process.env.PAYTABS_BASE_URL ?? PAYTABS_REGIONS[creds.region] ?? PAYTABS_REGIONS.global!
  const profileId = Number(creds.profileId)

  async function post(path: string, body: Record<string, unknown>): Promise<PayTabsResponse> {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: creds.serverKey, 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, ...body }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new GatewayError(`PayTabs unreachable: ${(error as Error).message}`, 'GATEWAY_UNREACHABLE')
    }
    const json = (await res.json().catch(() => ({}))) as PayTabsResponse
    if (!res.ok) throw new GatewayError(`PayTabs ${res.status}: ${json.message ?? ''}`.trim(), res.status === 401 ? 'GATEWAY_AUTH' : 'GATEWAY_ERROR')
    return json
  }

  const outcome = (r: PayTabsResponse): PaymentStatus => {
    const code = r.payment_result?.response_status
    return {
      // A authorised; H on hold and P pending wait; anything else failed.
      status: code === 'A' ? 'paid' : code === 'H' || code === 'P' || !code ? 'pending' : 'failed',
      paymentId: r.tran_ref ?? null,
      amount: r.cart_amount ? minor(r.cart_amount) : null,
      currency: r.cart_currency ?? null,
      message: r.payment_result?.response_message ?? null,
    }
  }

  return {
    key: 'paytabs',

    async createCheckout(input: CheckoutInput) {
      const r = await post('/payment/request', {
        tran_type: 'sale',
        tran_class: 'ecom',
        cart_id: input.reference,
        cart_currency: input.currency,
        cart_amount: Number(major(input.amount)),
        cart_description: input.description.slice(0, 128),
        paypage_lang: input.lang,
        callback: input.callbackUrl,
        return: input.returnUrl,
        hide_shipping: true,
        customer_details: {
          name: input.customer.name,
          email: input.customer.email ?? undefined,
          phone: input.customer.phone ?? undefined,
        },
      })
      if (!r.tran_ref || !r.redirect_url) throw new GatewayError(`PayTabs gave no payment page: ${r.message ?? ''}`)
      return { redirectUrl: r.redirect_url, providerRef: r.tran_ref }
    },

    async status(providerRef: string) {
      return outcome(await post('/payment/query', { tran_ref: providerRef }))
    },

    async refund(input): Promise<RefundResult> {
      try {
        const r = await post('/payment/request', {
          tran_type: 'refund',
          tran_class: 'ecom',
          cart_id: `${input.reference}-r${Date.now()}`,
          cart_currency: input.currency,
          cart_amount: Number(major(input.amount)),
          cart_description: input.reason.slice(0, 128) || 'Refund',
          tran_ref: input.providerRef,
        })
        if (r.payment_result?.response_status !== 'A') return { ok: false, error: r.payment_result?.response_message ?? 'REFUND_DECLINED' }
        return { ok: true, refundRef: r.tran_ref ?? '' }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    },

    // The callback's body is signed: HMAC-SHA256 with the server key.
    verifyCallback(rawBody, headers) {
      const given = headers.signature
      if (typeof given !== 'string') return false
      const expected = createHmac('sha256', creds.serverKey).update(rawBody).digest('hex')
      return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    },
  }
}
