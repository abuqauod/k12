import { config } from '../config.js'

/**
 * SMS providers (configured in config.ts, `SMS_PROVIDER`). Each takes one
 * rendered message and returns the provider's id for it. A refusal that
 * sending again can't fix (a bad number, bad credentials) is a
 * `PermanentSmsError`, so the queue stops retrying it; anything else
 * (network, 5xx, rate limit) is retried with backoff.
 */

export class SmsNotConfiguredError extends Error {
  constructor() {
    super('No SMS provider is configured')
    this.name = 'SmsNotConfiguredError'
  }
}

export class PermanentSmsError extends Error {
  constructor(readonly code: string, detail = '') {
    super(detail ? `${code}: ${detail}`.slice(0, 200) : code)
    this.name = 'PermanentSmsError'
  }
}

/**
 * A number as providers want it (E.164, "+9627…"). Numbers are stored as
 * people type them; with `SMS_DEFAULT_COUNTRY_CODE` a local "07…" becomes
 * "+9627…". "00…" becomes "+…". Anything that isn't a phone number is
 * refused before it reaches the provider.
 */
export function normalizePhone(raw: string, countryCode = process.env.SMS_DEFAULT_COUNTRY_CODE ?? ''): string {
  let n = raw.replace(/[\s\-().]/g, '')
  if (n.startsWith('00')) n = `+${n.slice(2)}`
  const cc = countryCode.replace(/\D/g, '')
  if (!n.startsWith('+') && cc) n = `+${cc}${n.replace(/^0+/, '')}`
  if (!/^\+?\d{7,15}$/.test(n)) throw new PermanentSmsError('INVALID_PHONE', raw)
  return n
}

/** Whether a failed HTTP status means "don't try again". */
const isPermanentStatus = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429

async function post(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function failure(res: Response, code: string): Promise<Error> {
  const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
  return isPermanentStatus(res.status)
    ? new PermanentSmsError(code, `${res.status} ${text}`)
    : new Error(`${code}: ${res.status} ${text}`.slice(0, 200))
}

export async function sendSms(to: string, body: string): Promise<string | null> {
  const sms = config.sms
  if (!sms) throw new SmsNotConfiguredError()
  const number = normalizePhone(to)

  if (sms.provider === 'twilio') {
    const form = new URLSearchParams({ To: number, Body: body })
    // A messaging service SID ("MG…") picks the sender itself.
    form.set(sms.from.startsWith('MG') ? 'MessagingServiceSid' : 'From', sms.from)
    const res = await post(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sms.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sms.accountSid}:${sms.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    if (!res.ok) throw await failure(res, 'SMS_REJECTED')
    const json = (await res.json().catch(() => ({}))) as { sid?: string }
    return json.sid ?? null
  }

  if (sms.provider === 'webhook') {
    const res = await post(sms.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sms.token ? { Authorization: `Bearer ${sms.token}` } : {}),
      },
      body: JSON.stringify({ to: number, body, from: sms.from }),
    })
    if (!res.ok) throw await failure(res, 'SMS_REJECTED')
    const json = (await res.json().catch(() => ({}))) as { id?: unknown; messageId?: unknown }
    const id = json.id ?? json.messageId
    return id === undefined || id === null ? null : String(id)
  }

  // provider === 'log'
  console.log(`[sms:log] to ${number}: ${body}`)
  return `log-${Date.now()}`
}

export const smsStatus = () => ({ configured: config.sms !== null, provider: config.sms?.provider ?? null })
