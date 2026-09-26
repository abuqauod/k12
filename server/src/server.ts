import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import staticFiles from '@fastify/static'
import { config, isProduction } from './config.js'
import { closeClient, ping } from './db.js'
import { runWithRequestContext } from './requestContext.js'
import { registerAuthRoutes } from './auth/routes.js'
import { registerDatasetRoutes } from './datasets/routes.js'
import { registerAdminRoutes } from './admin/routes.js'
import { registerMembershipRoutes } from './memberships/routes.js'
import { registerAuditLogRoutes } from './auditlog/routes.js'
import { registerStudentRoutes } from './students/routes.js'
import { registerEnrollmentRoutes } from './enrollments/routes.js'
import { registerAcademicYearRoutes } from './academicYears/routes.js'
import { registerAttendanceRoutes } from './attendance/routes.js'
import { registerBranchRoutes } from './branches/routes.js'
import { registerTenantRoutes } from './tenant/routes.js'
import { registerClassRoutes } from './classes/routes.js'
import { registerParentRoutes } from './parents/routes.js'
import { registerFinanceRoutes } from './finance/routes.js'
import { registerNotificationRoutes } from './notifications/routes.js'
import { registerTransportRoutes } from './transport/routes.js'
import { registerSearchRoutes } from './search/routes.js'
import { registerDashboardRoutes } from './dashboard/routes.js'
import { registerApprovalRoutes } from './approvals/routes.js'
import { registerSettingsRoutes } from './settings/routes.js'
import { registerDocumentRoutes } from './documents/routes.js'
import { registerAdmissionRoutes } from './admissions/routes.js'
import { registerHrRoutes } from './hr/routes.js'
import { registerOpsRoutes } from './ops/routes.js'
import { registerCommunicationRoutes } from './communication/routes.js'
import { registerPortalRoutes } from './portal/routes.js'
import { registerReportRoutes } from './reports/routes.js'
import { registerHealthRoutes } from './health/routes.js'
import { registerDisciplineRoutes } from './discipline/routes.js'
import { registerImportRoutes } from './imports/routes.js'
import { registerIdCardRoutes } from './idcards/routes.js'
import { registerPaymentRoutes } from './payments/routes.js'
import { registerGradeRoutes } from './grades/routes.js'
import { startAbsenceSweeper } from './notifications/sweep.js'
import { reportError } from './runtime/errorReporting.js'
import { preflight } from './runtime/preflight.js'

/** Set once shutdown starts: /ready turns 503 so the proxy stops sending. */
let draining = false
const startedAt = Date.now()

export function buildServer() {
  const app = Fastify({
    logger: { level: isProduction ? 'info' : 'warn' },
    bodyLimit: config.maxBodyBytes,
    trustProxy: true,
    // Fastify's default is 100 characters per path parameter. Parent links
    // made by the guardian backfill have ids of about 130
    // (`tenant:bf:student:guardian`), which made them impossible to edit or
    // remove (414) — and since SAMS 2.3 those links decide absence alerts.
    maxParamLength: 256,
    // SAMS 8.3: one id per request, taken from the proxy's X-Request-Id when
    // it sends a sane one, so a log line, an error response and the
    // proxy's access log can be matched up.
    genReqId: (req) => {
      const given = req.headers['x-request-id']
      return typeof given === 'string' && /^[\w.:-]{8,128}$/.test(given) ? given : randomUUID()
    },
  })

  // SAMS 8.3/8.4: the request id and security headers on every response.
  // The API only returns JSON, files and a few print pages, so these cost
  // nothing: no MIME sniffing, no framing by other sites, no referrer to
  // third parties, HTTPS remembered in production.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'strict-origin-when-cross-origin')
    reply.header('x-frame-options', 'SAMEORIGIN')
    if (isProduction) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
  })

  // SAMS 8.3: an unexpected error is logged with its request id, reported
  // (when ERROR_REPORTING_DSN is set) and answered with that id, never with
  // the error's message or stack. Errors Fastify raised with a 4xx status
  // (bad JSON, too large) keep their status.
  app.setErrorHandler((error: import('fastify').FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500
    if (status >= 500) {
      request.log.error(error, 'request failed')
      reportError(error, {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions?.url,
        tenantId: request.auth?.tenantId ?? null,
        userId: request.auth?.sub ?? null,
      })
      return reply.code(500).send({ error: 'INTERNAL', requestId: request.id })
    }
    return reply.code(status).send({ error: error.code ?? 'BAD_REQUEST', message: error.message, requestId: request.id })
  })

  app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    // PATCH was missing here — every PATCH route in the app (student/
    // parent/fee-structure/class edits, and now bus/stop edits) has been
    // silently failing its cross-origin preflight in the browser this
    // whole time; nothing caught it because testing PATCH endpoints was
    // otherwise done server-to-server (curl, scripts), which isn't subject
    // to CORS at all.
    methods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // Response headers are only readable by cross-origin page JS (the normal
    // topology here — the frontend's baseUrl is rarely same-origin with this
    // server) when explicitly exposed. Needed so the audit-log CSV export's
    // client can read the server-chosen filename off the response.
    exposedHeaders: ['Content-Disposition'],
  })

  // Fastify's default JSON parser rejects a request whose Content-Type is
  // application/json but whose body is empty — correct in the strictest
  // reading, but plenty of real HTTP clients (this project's own frontend
  // included) set that header on every request out of habit, even a bodyless
  // DELETE. Every route that actually needs a body already validates its
  // presence with zod, so treating "empty" as "no body" here just moves that
  // check to the place that already produces a sane error for it.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    // SAMS 11.1: a payment gateway signs the exact bytes it sent.
    ;(request as { rawBody?: string }).rawBody = body as string
    if (body === '') {
      done(null, undefined)
      return
    }
    try {
      done(null, JSON.parse(body as string))
    } catch {
      // A client's mistake, not ours: 400, not the 500 a bare SyntaxError got.
      done(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400, code: 'INVALID_JSON' }), undefined)
    }
  })

  // SAMS 11.1: payment gateways return the family's browser with a form
  // post. Parsed flat (every value a string); no route but the payment
  // return pages reads one.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (request, body, done) => {
    ;(request as { rawBody?: string }).rawBody = body as string
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  })

  // Audit context (SAMS 1.12): every recordAudit in this request picks up
  // the client IP (trustProxy is on) and user agent. Callback-style so the
  // route's guards and handler run inside the context.
  app.addHook('preHandler', (request, _reply, done) => {
    const agent = request.headers['user-agent']
    runWithRequestContext(
      { ip: request.ip ?? null, userAgent: typeof agent === 'string' ? agent.slice(0, 512) : null },
      done,
    )
  })

  // Wrapped in one plugin so config.routePrefix applies to every route at
  // once — see the comment on routePrefix in config.ts for why this exists
  // (a host that mounts the app at a path like heymueen.com/api rather than
  // a subdomain, and forwards that path prefix rather than stripping it).
  app.register(
    async (instance) => {
      // SAMS 8.2: /live answers while the process runs (a restart check);
      // /health and /ready also reach the database (a routing check), and
      // /ready turns 503 while shutting down so the proxy drains first.
      instance.get('/live', async () => ({ ok: true }))
      const ready = async (_request: unknown, reply: import('fastify').FastifyReply) => {
        if (draining) return reply.code(503).send({ ok: false, error: 'SHUTTING_DOWN' })
        try {
          await ping()
        } catch {
          return reply.code(503).send({ ok: false, error: 'DATABASE_UNREACHABLE' })
        }
        return reply.send({ ok: true, uptimeS: Math.round((Date.now() - startedAt) / 1000), release: process.env.APP_RELEASE ?? null })
      }
      instance.get('/health', ready)
      instance.get('/ready', ready)

      // The platform-admin console: a plain static page, no build step, no
      // shared code with the school-facing frontend — it's just another
      // client of the already-secured /admin/* API. Serving it from this
      // same process avoids needing a second hosting slot/subdomain/
      // certificate for something only the vendor ever loads.
      const here = dirname(fileURLToPath(import.meta.url))
      instance.register(staticFiles, {
        root: join(here, '..', 'public', 'console'),
        prefix: '/console/',
        index: ['index.html'],
      })

      registerAuthRoutes(instance)
      registerDatasetRoutes(instance)
      registerAdminRoutes(instance)
      registerMembershipRoutes(instance)
      registerAuditLogRoutes(instance)
      registerStudentRoutes(instance)
      registerEnrollmentRoutes(instance)
      registerAcademicYearRoutes(instance)
      registerAttendanceRoutes(instance)
      registerBranchRoutes(instance)
      registerTenantRoutes(instance)
      registerClassRoutes(instance)
      registerParentRoutes(instance)
      registerFinanceRoutes(instance)
      registerNotificationRoutes(instance)
      registerTransportRoutes(instance)
      registerSearchRoutes(instance)
      registerDashboardRoutes(instance)
      registerApprovalRoutes(instance)
      registerSettingsRoutes(instance)
      registerDocumentRoutes(instance)
      registerAdmissionRoutes(instance)
      registerHrRoutes(instance)
      registerOpsRoutes(instance)
      registerCommunicationRoutes(instance)
      registerPortalRoutes(instance)
      registerReportRoutes(instance)
      registerHealthRoutes(instance)
      registerDisciplineRoutes(instance)
      registerImportRoutes(instance)
      registerIdCardRoutes(instance)
      registerPaymentRoutes(instance)
      registerGradeRoutes(instance)
    },
    { prefix: config.routePrefix },
  )

  return app
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('server.ts') || entry.endsWith('server.js')) {
  // SAMS 8.1: a production start refuses what would be unsafe to run with.
  if (isProduction) {
    const check = preflight(process.env)
    for (const line of check.channels) console.log(`[preflight] ${line}`)
    for (const line of check.warnings) console.warn(`[preflight] warning: ${line}`)
    if (check.fatal.length > 0) {
      for (const line of check.fatal) console.error(`[preflight] fatal: ${line}`)
      process.exit(1)
    }
  }

  const app = buildServer()
  let stopSweeper: (() => void) | null = null
  app
    .listen({ port: config.port, host: config.host })
    .then(() => {
      console.log(`API listening on ${config.host}:${config.port}`)
      // The absence-notification cron. Lives with the API process rather than
      // a separate worker — one small school-management server, not a fleet.
      stopSweeper = startAbsenceSweeper()
    })
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })

  // SAMS 8.2: on SIGTERM (a deploy) stop taking work, let requests in
  // flight finish, then close the database. A stuck request cannot hold
  // the deploy: after SHUTDOWN_GRACE_MS the process exits anyway.
  const shutdown = (signal: string) => {
    if (draining) return
    draining = true
    console.log(`${signal}: shutting down`)
    stopSweeper?.()
    const grace = Number(process.env.SHUTDOWN_GRACE_MS ?? 10_000)
    setTimeout(() => {
      console.error('shutdown grace period over; exiting')
      process.exit(1)
    }, grace).unref()
    void app
      .close()
      .then(closeClient)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('shutdown failed', error)
        process.exit(1)
      })
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(signal))

  process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection', reason)
    reportError(reason, {})
  })
}
