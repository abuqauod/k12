/**
 * SAMS 11.1: what the school's side needs from a card gateway. Each
 * provider takes the school's own credentials, so fees land in the school's
 * merchant account, never the vendor's.
 */

export interface CheckoutInput {
  /** Our online payment id: the gateway's cart/merchant transaction id. */
  reference: string
  /** Minor units (hundredths). */
  amount: number
  currency: string
  description: string
  customer: { name: string; email: string | null; phone: string | null }
  /** Where the family's browser comes back to. */
  returnUrl: string
  /** Where the gateway posts its server-to-server notice. */
  callbackUrl: string
  lang: 'en' | 'ar'
}

export interface CheckoutResult {
  /** Where to send the family's browser. */
  redirectUrl: string
  providerRef: string
}

export interface PaymentStatus {
  status: 'paid' | 'failed' | 'pending'
  /** The captured payment's id, where the gateway has one (refunds use it). */
  paymentId: string | null
  /** As charged, minor units; null when the gateway did not say. */
  amount: number | null
  currency: string | null
  message: string | null
}

export type RefundResult = { ok: true; refundRef: string } | { ok: false; error: string }

export interface PaymentProvider {
  readonly key: 'paytabs' | 'hyperpay' | 'test'
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>
  /** Asks the gateway how a checkout ended. The only thing a payment is
   * ever settled on: a callback or return merely prompts this check. */
  status(providerRef: string, reference: string): Promise<PaymentStatus>
  refund(input: { providerRef: string; paymentId: string | null; reference: string; amount: number; currency: string; reason: string }): Promise<RefundResult>
  /** Checks a gateway callback's signature, where the gateway signs them. */
  verifyCallback?(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean
}

/** Minor units to the gateways' "12.50". */
export const major = (minor: number) => (minor / 100).toFixed(2)
/** "12.50" (or 12.5) to minor units. */
export const minor = (value: string | number) => Math.round(Number(value) * 100)

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: string = 'GATEWAY_ERROR',
  ) {
    super(message)
  }
}
