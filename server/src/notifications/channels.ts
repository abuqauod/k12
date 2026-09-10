import { EmailNotConfiguredError, sendPlainEmail } from '../email.js'
import type { NotifyChannel } from '../db.js'

/**
 * The Provider layer: one function per channel that turns a rendered message
 * into an actual send and reports back a provider message id when it has
 * one. Adding WhatsApp or push is a new `case` here (and a value in
 * `NotifyChannel`), not a schema change.
 *
 * Email goes through the SMTP already configured for invites. SMS is a
 * deliberate stub — a job for it retries, then dies cleanly and visibly,
 * rather than silently doing nothing — until a provider is wired here.
 */

export class SmsNotConfiguredError extends Error {
  constructor() {
    super('No SMS provider is configured')
    this.name = 'SmsNotConfiguredError'
  }
}

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
    await sendPlainEmail({ to: input.to, subject: input.subject, body: input.body })
    // nodemailer returns a messageId, but sendPlainEmail doesn't surface it;
    // not worth widening that signature for a value nothing reads yet.
    return { providerMessageId: null }
  }
  // channel === 'sms'
  throw new SmsNotConfiguredError()
}

/** Whether an error means "stop retrying this job". */
export function isPermanent(error: unknown): boolean {
  return error instanceof PermanentDeliveryError || error instanceof EmailNotConfiguredError
}

/** Short, storable reason string for the job / attempt log. */
export function deliveryErrorCode(error: unknown): string {
  if (error instanceof SmsNotConfiguredError) return 'SMS_NOT_CONFIGURED'
  if (error instanceof EmailNotConfiguredError) return 'EMAIL_NOT_CONFIGURED'
  if (error instanceof Error) return error.message.slice(0, 200)
  return 'UNKNOWN'
}
