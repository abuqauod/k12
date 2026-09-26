// SAMS 8: production readiness — boot checks, health/ready, request ids,
// the error handler, security headers, rate limits and error reporting.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { preflight } from '../runtime/preflight.js'
import { buildEnvelope, parseDsn } from '../runtime/errorReporting.js'
import { authLimiter, createLimiter } from '../runtime/rateLimit.js'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../server.js'
import { createFixture, type Fixture } from './harness.js'

let fx: Fixture
let boom: FastifyInstance

before(async () => {
  fx = await createFixture()
  // A server with a route that fails, to see what the client gets.
  boom = buildServer()
  boom.get('/__boom', async () => {
    throw new Error('secret detail from the database')
  })
  await boom.ready()
})
after(async () => {
  await boom.close()
  await fx.close()
})

describe('preflight', () => {
  const good = {
    JWT_SECRET: 'x'.repeat(40),
    DATABASE_URL: 'mongodb://root:s3cret@db:27017/timetable',
    APP_URL: 'https://school.example.com',
    CORS_ORIGINS: 'https://school.example.com',
    BACKUP_DIR: '/backups',
    SMTP_HOST: 'smtp.example.com',
  }

  test('a complete production environment passes', () => {
    const out = preflight(good)
    assert.deepEqual(out.fatal, [])
    assert.deepEqual(out.warnings, [])
    assert.ok(out.channels.some((c) => c.startsWith('email: on')))
    assert.ok(out.channels.includes('sms: off'))
  })

  test('default or short secrets and the default database password stop the start', () => {
    assert.equal(preflight({ ...good, JWT_SECRET: 'dev-only-secret-change-me-in-production' }).fatal.length, 1)
    assert.match(preflight({ ...good, JWT_SECRET: 'short' }).fatal[0]!, /32/)
    assert.match(preflight({ ...good, DATABASE_URL: 'mongodb://root:mongo_root_password@db/x' }).fatal[0]!, /MONGO_ROOT_PASSWORD/)
  })

  test('local links, no backups and no email are warnings', () => {
    const out = preflight({ ...good, APP_URL: 'http://localhost:5183', CORS_ORIGINS: 'http://localhost:5183', BACKUP_DIR: '', SMTP_HOST: '' })
    assert.equal(out.fatal.length, 0)
    assert.equal(out.warnings.length, 3)
    assert.ok(out.channels[0]!.startsWith('email: off'))
  })
})

describe('health and errors', () => {
  test('/live, /health and /ready answer with a request id and the headers', async () => {
    for (const url of ['/live', '/health', '/ready']) {
      const res = await fx.app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 200, url)
      assert.equal(res.json().ok, true)
      assert.ok(res.headers['x-request-id'])
      assert.equal(res.headers['x-content-type-options'], 'nosniff')
      assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN')
    }
  })

  test('the proxy request id is kept when sane, replaced when not', async () => {
    const kept = await fx.app.inject({ method: 'GET', url: '/live', headers: { 'x-request-id': 'edge-1234abcd' } })
    assert.equal(kept.headers['x-request-id'], 'edge-1234abcd')
    const replaced = await fx.app.inject({ method: 'GET', url: '/live', headers: { 'x-request-id': '<script>' } })
    assert.notEqual(replaced.headers['x-request-id'], '<script>')
  })

  test('an unexpected error answers INTERNAL with the request id, never the message', async () => {
    const res = await boom.inject({ method: 'GET', url: '/__boom' })
    assert.equal(res.statusCode, 500)
    const body = res.json()
    assert.equal(body.error, 'INTERNAL')
    assert.equal(body.requestId, res.headers['x-request-id'])
    assert.ok(!res.body.includes('secret detail'))
  })

  test('a malformed body stays a 400', async () => {
    const res = await fx.app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: '{nope' })
    assert.equal(res.statusCode, 400)
    assert.ok(res.json().requestId)
  })
})

describe('rate limits', () => {
  test('a fixed window per key', () => {
    const limiter = createLimiter('t', { max: 2, windowMs: 1000 })
    assert.equal(limiter.hit('a', 0).ok, true)
    assert.equal(limiter.hit('a', 10).ok, true)
    const third = limiter.hit('a', 20)
    assert.equal(third.ok, false)
    assert.equal(third.retryAfterS, 1)
    assert.equal(limiter.hit('b', 20).ok, true)
    assert.equal(limiter.hit('a', 1001).ok, true)
  })

  test('sign-in from one address is refused past the budget', async () => {
    authLimiter.reset()
    const attempt = () =>
      fx.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nobody@example.test', password: 'wrong-password' } })
    let last = await attempt()
    for (let i = 0; i < 60; i++) last = await attempt()
    assert.equal(last.statusCode, 429)
    assert.equal(last.json().error, 'RATE_LIMITED')
    assert.ok(Number(last.headers['retry-after']) > 0)
    authLimiter.reset()
  })
})

describe('error reporting', () => {
  test('parses a DSN into the envelope endpoint', () => {
    assert.deepEqual(parseDsn('https://abc123@o1.ingest.example.io/42'), {
      endpoint: 'https://o1.ingest.example.io/api/42/envelope/',
      key: 'abc123',
    })
    assert.equal(parseDsn('not a url'), null)
    assert.equal(parseDsn('https://o1.example.io/42'), null)
  })

  test('the envelope carries the error and route, not request data', () => {
    const lines = buildEnvelope(new Error('boom'), { requestId: 'r-1', method: 'GET', route: '/students/:id', tenantId: 't1', userId: 'u1' }).split('\n')
    assert.equal(lines.length, 3)
    const event = JSON.parse(lines[2]!)
    assert.equal(event.exception.values[0].value, 'boom')
    assert.equal(event.transaction, 'GET /students/:id')
    assert.equal(event.tags.request_id, 'r-1')
    assert.deepEqual(event.user, { id: 'u1' })
  })
})

describe('scoped aggregation', () => {
  test('runs inside the tenant and refuses stages that reach other collections', async () => {
    const { withTenant } = await import('../db.js')
    const rows = await withTenant(fx.tenantId, (ctx) => ctx.branches.aggregate<{ _id: null; n: number }>({}, [{ $group: { _id: null, n: { $sum: 1 } } }]).toArray())
    assert.equal(rows[0]!.n, 2)
    await assert.rejects(
      withTenant(fx.tenantId, (ctx) => ctx.branches.aggregate({}, [{ $lookup: { from: 'users', pipeline: [], as: 'u' } }]).toArray()),
      /not allowed/,
    )
  })
})
