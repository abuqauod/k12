import type { FastifyInstance } from 'fastify'
import { registerEmployeeRoutes } from './employees.js'
import { registerLeaveRoutes } from './leave.js'
import { registerStaffAttendanceRoutes } from './attendance.js'
import { registerHrReportRoutes } from './reports.js'

/** SAMS Phase 4 — HR & staff. */
export function registerHrRoutes(app: FastifyInstance): void {
  registerEmployeeRoutes(app)
  registerLeaveRoutes(app)
  registerStaffAttendanceRoutes(app)
  registerHrReportRoutes(app)
}
