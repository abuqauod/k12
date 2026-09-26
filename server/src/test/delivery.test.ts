// Email/SMS delivery: SMS providers (Twilio, an HTTP gateway), which
// failures stop retrying, the channel status and test-send endpoints, and
// re-queuing messages that died before a provider was set up.
import { after, afterEach, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import type { NotificationJobDoc } from '../db.js'
import { config } from '../config.js'
import { deliver, deliveryErrorCode, isPermanent } from '../notifications/channels.js'
import { normalizePhone, PermanentSmsError, SmsNotConfiguredError } from '../notifications/sms.js'
import { call, createFixture, member, type Fixture } from './harness.js'

let fx: Fixture
const realFetch = globalThis.fetch
const realSms = config.sms

before(async () => {
  fx = await createFixture()
})
after(async () => {
  await fx.close()
})
afterEach(() => {
  globalThis.fetch = realFetch
  ;(config as { sms: typeof config.sms }).sms = realSms
})

/** Records the requests a provider call makes and answers with `reply`. */
function stubFetch(reply: { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}
const useSms = (sms: NonNullable<typeof config.sms>) => ((config as { sms: typeof config.sms }).sms = sms)

describe('phone numbers', () => {
  test('local numbers become international with the default country code', () => {
    assert.equal(normalizePhone('079 111-2233', '962'), '+962791112233')
    assert.equal(normalizePhone('00962791112233', '962'), '+962791112233')
    assert.equal(normalizePhone('+44 20 7946 0958', '962'), '+442079460958')
    assert.equal(normalizePhone('0791112233', ''), '0791112233')
    assert.throws(() => normalizePhone('call me', '962'), PermanentSmsError)
  })
})

describe('SMS providers', () => {
  test('Twilio: form post with basic auth; a messaging service SID picks the sender', async () => {
    useSms({ provider: 'twilio', accountSid: 'AC123', authToken: 'secret', from: 'MG999' })
    const calls = stubFetch({ status: 201, body: { sid: 'SM1' } })
    const out = await deliver({ channel: 'sms', to: '+962791112233', subject: '', body: 'Hello' })
    assert.equal(out.providerMessageId, 'SM1')
    assert.equal(calls[0]!.url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json')
    const form = new URLSearchParams(String(calls[0]!.init.body))
    assert.deepEqual([form.get('To'), form.get('Body'), form.get('MessagingServiceSid'), form.get('From')], ['+962791112233', 'Hello', 'MG999', null])
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('AC123:secret').toString('base64')}`)
  })

  test('a refused number stops retrying; an outage or rate limit retries', async () => {
    useSms({ provider: 'twilio', accountSid: 'AC123', authToken: 'secret', from: '+15550001111' })
    stubFetch({ status: 400, body: { message: 'Invalid To' } })
    const refused = await deliver({ channel: 'sms', to: '+962791112233', subject: '', body: 'x' }).catch((e: unknown) => e)
    assert.ok(isPermanent(refused))
    assert.match(deliveryErrorCode(refused), /^SMS_REJECTED: 400/)
    for (const status of [429, 503]) {
      stubFetch({ status, body: {} })
      const later = await deliver({ channel: 'sms', to: '+962791112233', subject: '', body: 'x' }).catch((e: unknown) => e)
      assert.ok(!isPermanent(later), `status ${status} should retry`)
    }
  })

  test('an HTTP gateway gets JSON with the bearer token', async () => {
    useSms({ provider: 'webhook', url: 'https://sms.example.test/send', token: 'tok', from: 'SCHOOL' })
    const calls = stubFetch({ status: 200, body: { id: 42 } })
    const out = await deliver({ channel: 'sms', to: '+962791112233', subject: '', body: 'مرحبا' })
    assert.equal(out.providerMessageId, '42')
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { to: '+962791112233', body: 'مرحبا', from: 'SCHOOL' })
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer tok')
  })

  test('without a provider, an SMS fails at once and visibly', async () => {
    useSms(null as unknown as NonNullable<typeof config.sms>)
    const err = await deliver({ channel: 'sms', to: '+962791112233', subject: '', body: 'x' }).catch((e: unknown) => e)
    assert.ok(err instanceof SmsNotConfiguredError)
    assert.ok(isPermanent(err))
    assert.equal(deliveryErrorCode(err), 'SMS_NOT_CONFIGURED')
  })
})

describe('channel status and test messages', () => {
  test('show whether each channel is set up, without secrets', async () => {
    const res = await call(fx.app, fx.tokens.admin, 'GET', '/communication/channels')
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(res.body).sort(), ['email', 'sms'])
    assert.equal(JSON.stringify(res.body).includes('pass'), false)
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'GET', '/communication/channels')).error, 'FORBIDDEN')
  })

  test('a test send reports the provider’s answer, and is audited', async () => {
    useSms({ provider: 'webhook', url: 'https://sms.example.test/send', token: null, from: null })
    stubFetch({ status: 200, body: { id: 'abc' } })
    const ok = await call(fx.app, fx.tokens.admin, 'POST', '/communication/test-send', { channel: 'sms', to: '+962791112233' })
    assert.equal(ok.status, 200, ok.error)
    assert.equal((ok.body as { providerMessageId: string }).providerMessageId, 'abc')
    const bad = await call(fx.app, fx.tokens.admin, 'POST', '/communication/test-send', { channel: 'sms', to: 'not a phone' })
    assert.equal(bad.error, 'SEND_FAILED')
    assert.match((bad.body as { reason: string }).reason, /^INVALID_PHONE/)
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', '/communication/test-send', { channel: 'email', to: 'nope' })).error, 'INVALID_EMAIL')
    const audits = await withTenant(fx.tenantId, (ctx) => ctx.auditLog.find({ action: 'notification.test' }).toArray())
    assert.equal(audits.length, 2)
  })
})

describe('retrying given-up messages', () => {
  const dead = (branchId: string, lastError: string, kind: NotificationJobDoc['kind'] = 'announcement') => {
    const now = new Date()
    return withTenant(fx.tenantId, (ctx) =>
      ctx.notificationJobs.insertOne({
        _id: randomUUID(),
        branchId,
        studentId: '',
        guardianId: 'p',
        date: '2026-09-01',
        channel: 'email',
        to: 'x@example.test',
        guardianName: 'X',
        language: 'en',
        subject: 's',
        body: 'b',
        status: 'dead',
        attempts: 3,
        maxAttempts: 3,
        nextAttemptAt: now,
        lastError,
        providerMessageId: null,
        trigger: 'auto',
        actorId: null,
        kind,
        sourceId: 'src',
        createdAt: now,
        updatedAt: now,
      }),
    )
  }

  test('re-queues them in the caller’s branches, by reason if asked', async () => {
    await dead(fx.branchA, 'EMAIL_NOT_CONFIGURED')
    await dead(fx.branchA, 'SMS_REJECTED: 400')
    await dead(fx.branchB, 'EMAIL_NOT_CONFIGURED')
    const branchAdmin = (await member(fx.tenantId, 'admin', [fx.branchA])).token
    const a = await call(fx.app, branchAdmin, 'POST', '/communication/log/retry', { error: 'EMAIL_NOT_CONFIGURED' })
    assert.equal(a.status, 200, a.error)
    assert.equal((a.body as { requeued: number }).requeued, 1)
    // Branch B's job was left alone by the branch-A admin.
    const b = await withTenant(fx.tenantId, (ctx) => ctx.notificationJobs.findOne({ branchId: fx.branchB, sourceId: 'src' }))
    assert.equal(b!.maxAttempts, 3)
    const all = await call(fx.app, fx.tokens.admin, 'POST', '/communication/log/retry', {})
    assert.equal((all.body as { requeued: number }).requeued, 2)
    // Each was given one more try (the queue may already have used it:
    // there is no SMTP in the test run).
    const jobs = await withTenant(fx.tenantId, (ctx) => ctx.notificationJobs.find({ sourceId: 'src' }).toArray())
    assert.deepEqual(jobs.map((j) => j.maxAttempts), [4, 4, 4])
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', '/communication/log/retry', {})).error, 'FORBIDDEN')
  })
})
