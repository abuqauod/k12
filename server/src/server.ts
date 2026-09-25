import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import staticFiles from '@fastify/static'
import { config, isProduction } from './config.js'
import { closeClient, ping } from './db.js'
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
import { startAbsenceSweeper } from './notifications/sweep.js'

export function buildServer() {
  const app = Fastify({
    logger: { level: isProduction ? 'info' : 'warn' },
    bodyLimit: config.maxBodyBytes,
    trustProxy: true,
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
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (body === '') {
      done(null, undefined)
      return
    }
    try {
      done(null, JSON.parse(body as string))
    } catch (error) {
      done(error as Error, undefined)
    }
  })

  // Wrapped in one plugin so config.routePrefix applies to every route at
  // once — see the comment on routePrefix in config.ts for why this exists
  // (a host that mounts the app at a path like heymueen.com/api rather than
  // a subdomain, and forwards that path prefix rather than stripping it).
  app.register(
    async (instance) => {
      instance.get('/health', async () => {
        await ping()
        return { ok: true }
      })

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
    },
    { prefix: config.routePrefix },
  )

  return app
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('server.ts') || entry.endsWith('server.js')) {
  const app = buildServer()
  app
    .listen({ port: config.port, host: config.host })
    .then(() => {
      console.log(`API listening on ${config.host}:${config.port}`)
      // The absence-notification cron. Lives with the API process rather than
      // a separate worker — one small school-management server, not a fleet.
      startAbsenceSweeper()
    })
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app
        .close()
        .then(closeClient)
        .then(() => process.exit(0))
    })
  }
}
