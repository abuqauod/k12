import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config, isProduction } from './config.js'
import { closeClient, ping } from './db.js'
import { registerAuthRoutes } from './auth/routes.js'
import { registerDatasetRoutes } from './datasets/routes.js'

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

  app.get('/health', async () => {
    await ping()
    return { ok: true }
  })

  registerAuthRoutes(app)
  registerDatasetRoutes(app)

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
