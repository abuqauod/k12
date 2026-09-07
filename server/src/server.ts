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
import { registerApiKeyRoutes } from './apikeys/routes.js'
import { registerAuditLogRoutes } from './auditlog/routes.js'

export function buildServer() {
  const app = Fastify({
    logger: { level: isProduction ? 'info' : 'warn' },
    bodyLimit: config.maxBodyBytes,
    trustProxy: true,
  })

  app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
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

  app.get('/health', async () => {
    await ping()
    return { ok: true }
  })

  // The platform-admin console: a plain static page, no build step, no
  // shared code with the school-facing frontend — it's just another client
  // of the already-secured /admin/* API. Serving it from this same process
  // avoids needing a second hosting slot/subdomain/certificate for
  // something only the vendor ever loads.
  const here = dirname(fileURLToPath(import.meta.url))
  app.register(staticFiles, {
    root: join(here, '..', 'public', 'console'),
    prefix: '/console/',
    index: ['index.html'],
  })

  registerAuthRoutes(app)
  registerDatasetRoutes(app)
  registerAdminRoutes(app)
  registerMembershipRoutes(app)
  registerApiKeyRoutes(app)
  registerAuditLogRoutes(app)

  return app
}

const entry = process.argv[1] ?? ''
if (entry.endsWith('server.ts') || entry.endsWith('server.js')) {
  const app = buildServer()
  app
    .listen({ port: config.port, host: config.host })
    .then(() => console.log(`API listening on ${config.host}:${config.port}`))
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
