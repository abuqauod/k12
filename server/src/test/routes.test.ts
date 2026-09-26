// SAMS 9.1: every route the server registers must have a row in the
// permission matrix (routeMatrix.ts) or be listed below with the reason it
// has none. A new route cannot ship without deciding who may call it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildServer } from '../server.js'
import { PLATFORM_ROUTES, PORTAL_ROUTES, ROUTES } from './routeMatrix.js'

/** Routes deliberately outside the role matrix, and why. */
const EXEMPT: Record<string, string> = {
  'GET /live': 'public health check',
  'GET /health': 'public health check',
  'GET /ready': 'public health check',
  'GET /console/*': 'static files of the platform console (its API is /admin/*)',
  'POST /auth/login': 'public; rate-limited',
  'POST /auth/refresh': 'public; rate-limited',
  'POST /auth/logout': 'public; revokes the presented refresh token only',
  'POST /auth/forgot-password': 'public; rate-limited',
  'POST /auth/reset-password': 'public; one-time token',
  'POST /auth/accept-invite': 'public; one-time token',
  'GET /auth/me': 'any signed-in user, about themselves',
  'GET /auth/sessions': 'any signed-in user, their own sessions',
  'DELETE /auth/sessions/:id': 'any signed-in user, their own sessions',
  'POST /auth/change-password': 'any signed-in user, their own password',
  'GET /payments/return/:tenantId/:id': 'public; the gateway returns the browser here — settles only on the gateway’s own status answer',
  'POST /payments/return/:tenantId/:id': 'public; as above (form post)',
  'POST /payments/callback/:tenantId/:id': 'public; signature-checked where the gateway signs, then a status query',
  'GET /payments/hyperpay/:tenantId/:id': 'public; the card widget page for a pending checkout',
  'GET /payments/test/:tenantId/:id': 'public; the test gateway page, off in production',
  'POST /payments/test/:tenantId/:id': 'public; the test gateway page, off in production',
  'GET /documents/file': 'signed, expiring download link (auth.test / documents.test)',
}


/** A matrix row's concrete path matches a registered pattern. */
function matches(pattern: string, concrete: string): boolean {
  const path = concrete.split('?')[0]!
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]+/g, '[^/]+').replace(/\*/g, '.*') + '$')
  return re.test(path)
}

test('every registered route has a permission-matrix row or a stated exemption', async () => {
  const app = buildServer()
  const registered: string[] = []
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const m of methods) if (m !== 'HEAD' && m !== 'OPTIONS') registered.push(`${m} ${route.url}`)
  })
  await app.ready()
  await app.close()

  const rows = [...ROUTES.map(([m, p]) => [m, p] as const), ...PORTAL_ROUTES, ...PLATFORM_ROUTES]
  const missing = registered.filter((key) => {
    if (EXEMPT[key]) return false
    const [method, pattern] = key.split(' ') as [string, string]
    return !rows.some(([m, p]) => m === method && matches(pattern, p))
  })
  assert.deepEqual(missing, [], `routes with no permission row:\n${missing.join('\n')}`)

  // And no exemption outlives its route.
  const stale = Object.keys(EXEMPT).filter((key) => !registered.includes(key))
  assert.deepEqual(stale, [], `exemptions for routes that no longer exist:\n${stale.join('\n')}`)
})
