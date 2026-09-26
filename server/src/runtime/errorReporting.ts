import { randomUUID } from 'node:crypto'

/**
 * SAMS 8.3 — optional error reporting to a Sentry-compatible service
 * (Sentry, GlitchTip, self-hosted Sentry) without its SDK: one HTTP POST of
 * an envelope per unexpected error. `ERROR_REPORTING_DSN` looks like
 * `https://<key>@<host>/<project>`. Reporting never throws and never delays
 * the response; what is sent is the error, the route and the request id —
 * no bodies, headers or query strings, which can carry personal data.
 */

interface Dsn {
  endpoint: string
  key: string
}

export function parseDsn(dsn: string | undefined): Dsn | null {
  if (!dsn) return null
  try {
    const url = new URL(dsn)
    const project = url.pathname.replace(/^\/+|\/+$/g, '')
    if (!url.username || !project) return null
    const base = `${url.protocol}//${url.host}`
    return { endpoint: `${base}/api/${project}/envelope/`, key: url.username }
  } catch {
    return null
  }
}

const dsn = parseDsn(process.env.ERROR_REPORTING_DSN)
const environment = process.env.ERROR_REPORTING_ENV ?? process.env.NODE_ENV ?? 'development'
const release = process.env.APP_RELEASE ?? undefined

export interface ErrorContext {
  requestId?: string
  route?: string
  method?: string
  tenantId?: string | null
  userId?: string | null
}

/** The envelope body for one error (exported for the test). */
export function buildEnvelope(error: unknown, context: ErrorContext, now = new Date()): string {
  const err = error instanceof Error ? error : new Error(String(error))
  const eventId = randomUUID().replace(/-/g, '')
  const frames = (err.stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/^at /, ''))
    .filter(Boolean)
    .reverse()
    .map((fn) => ({ function: fn }))
  const event = {
    event_id: eventId,
    timestamp: now.toISOString(),
    platform: 'node',
    level: 'error',
    environment,
    release,
    transaction: context.route ? `${context.method ?? ''} ${context.route}`.trim() : undefined,
    tags: { request_id: context.requestId, tenant: context.tenantId ?? undefined },
    user: context.userId ? { id: context.userId } : undefined,
    exception: { values: [{ type: err.name, value: err.message, stacktrace: { frames } }] },
  }
  return [
    JSON.stringify({ event_id: eventId, sent_at: now.toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n')
}

export function reportError(error: unknown, context: ErrorContext = {}): void {
  if (!dsn) return
  const body = buildEnvelope(error, context)
  void fetch(dsn.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-sentry-envelope',
      'x-sentry-auth': `Sentry sentry_version=7, sentry_client=sams/1.0, sentry_key=${dsn.key}`,
    },
    body,
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    // The logs already have it; a reporting outage must not become an error.
  })
}
