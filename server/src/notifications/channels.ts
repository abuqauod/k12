import { EmailNotConfiguredError, sendPlainEmail } from '../email.js'
import type { NotifyChannel } from '../db.js'
import { PermanentSmsError, sendSms, SmsNotConfiguredError } from './sms.js'

export { SmsNotConfiguredError }

/**
 * The Provider layer: one function per channel that turns a rendered message
 * into an actual send and reports back a provider message id when it has
 * one. Adding WhatsApp or push is a new `case` here (and a value in
 * `NotifyChannel`), not a schema change.
 *
 * Email goes through the SMTP already configured for invites; SMS through
 * the provider in `SMS_PROVIDER` (sms.ts). Without one, a job dies cleanly
 * and visibly (SMS_NOT_CONFIGURED) rather than silently doing nothing.
 */

/** A permanent failure — the worker should not keep retrying this job. */
export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentDeliveryError'
  }
}

export interface DeliverInput {
  channel: NotifyChannel
  /** Email address or phone number, depending on channel. */
  to: string
  subject: string
  body: string
}

export interface DeliverResult {
  /** The provider's id for the accepted message, if it returns one. */
  providerMessageId: string | null
}

export async function deliver(input: DeliverInput): Promise<DeliverResult> {
  if (input.channel === 'email') {
    return { providerMessageId: await sendPlainEmail({ to: input.to, subject: input.subject, body: input.body }) }
  }
  return { providerMessageId: await sendSms(input.to, input.body) }
}

/** Whether an error means "stop retrying this job". */
export function isPermanent(error: unknown): boolean {
  return (
    error instanceof PermanentDeliveryError ||
    error instanceof EmailNotConfiguredError ||
    error instanceof SmsNotConfiguredError ||
    error instanceof PermanentSmsError ||
    // SMTP refused the recipient or the login (5xx reply): retrying won't help.
    (typeof (error as { responseCode?: unknown })?.responseCode === 'number' && (error as { responseCode: number }).responseCode >= 500) ||
    (error as { code?: unknown })?.code === 'EAUTH' ||
    (error as { code?: unknown })?.code === 'EENVELOPE'
  )
}

/** Short, storable reason string for the job / attempt log. */
export function deliveryErrorCode(error: unknown): string {
  if (error instanceof SmsNotConfiguredError) return 'SMS_NOT_CONFIGURED'
  if (error instanceof EmailNotConfiguredError) return 'EMAIL_NOT_CONFIGURED'
  if (error instanceof PermanentSmsError) return error.message
  if ((error as { code?: unknown })?.code === 'EAUTH') return 'EMAIL_AUTH_FAILED'
  if (error instanceof Error) return error.message.slice(0, 200)
  return 'UNKNOWN'
}
