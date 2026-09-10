import { EmailNotConfiguredError, sendPlainEmail } from '../email.js'
import type { NotifyChannel } from '../db.js'

/**
 * One place that turns a channel + a rendered message into an actual send.
 * Email goes through the SMTP already configured for invites. SMS is a
 * deliberate stub: the settings model and the log already carry it, so
 * wiring a provider later is one function here plus a credential, not a
 * schema change. Until then an SMS attempt fails loudly and is logged as
 * such, rather than silently doing nothing.
 */

export class SmsNotConfiguredError extends Error {
  constructor() {
    super('No SMS provider is configured')
    this.name = 'SmsNotConfiguredError'
  }
}

export interface DeliverInput {
  channel: NotifyChannel
  /** Email address or phone number, depending on channel. */
  to: string
  subject: string
  body: string
}

export async function deliver(input: DeliverInput): Promise<void> {
  if (input.channel === 'email') {
    await sendPlainEmail({ to: input.to, subject: input.subject, body: input.body })
    return
  }
  throw new SmsNotConfiguredError()
}

/** Human-facing error code for the notification log. */
export function deliveryErrorCode(error: unknown): string {
  if (error instanceof SmsNotConfiguredError) return 'SMS_NOT_CONFIGURED'
  if (error instanceof EmailNotConfiguredError) return 'EMAIL_NOT_CONFIGURED'
  if (error instanceof Error) return error.message.slice(0, 200)
  return 'UNKNOWN'
}
