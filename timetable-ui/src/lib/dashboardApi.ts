import { settingsRequest } from './settingsApi'
import type { SettingsResult } from './settingsApi'
import type { TokenGetter } from './http'

/** `GET /dashboard/summary` (SAMS 1.12). Each section is present only when
 * the caller may see it; counts are branch-scoped server-side. */
export interface DashboardSummary {
  parents?: { total: number; multiChild: number; incomplete: number }
  /** SAMS 2.2: enrolled students whose record is missing something. */
  students?: { enrolled: number; incomplete: number }
  /** SAMS 2.5: waiting on the school, and accepted but not yet converted. */
  admissions?: { open: number; accepted: number }
  /** `pending`: planned places not yet started (SAMS 2.4). */
  enrollments?: { academicYear: string | null; active: number; withdrawals: number; transfers: number; pending?: number }
  approvals?: { pendingToDecide: number }
}

export function getDashboardSummary(
  getToken: TokenGetter,
  branchId: string | null,
): Promise<SettingsResult<DashboardSummary>> {
  const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''
  return settingsRequest(`/dashboard/summary${query}`, { method: 'GET' }, getToken)
}
