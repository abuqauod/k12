import type { FastifyInstance } from 'fastify'
import { registerAssetRoutes } from './assets.js'
import { registerInventoryRoutes } from './inventory.js'
import { registerFacilityRoutes } from './facilities.js'
import { registerTransportAdminRoutes } from './transportAdmin.js'
import { registerLibraryRoutes } from './library.js'
import { registerEventRoutes } from './events.js'

/** SAMS Phase 5 — operations. */
export function registerOpsRoutes(app: FastifyInstance): void {
  registerAssetRoutes(app)
  registerInventoryRoutes(app)
  registerFacilityRoutes(app)
  registerTransportAdminRoutes(app)
  registerLibraryRoutes(app)
  registerEventRoutes(app)
}
