import type { Role } from './tokens.js'

// Named permission scopes and the bundles that grant them (SAMS 1.1, 1.8).
//
// Two ways a member gets scopes:
//  - a rank role (viewer/scheduler/admin/owner) → `ROLE_SCOPES`, the
//    original bundles. A member with no `roleKey` resolves exactly as before.
//  - a named preset (`MembershipDoc.roleKey`, e.g. finance_officer) →
//    `PRESETS[key].scopes`. The preset still carries a base rank, which is
//    what the JWT holds and what the rank rules (who may grant whom) compare.
//
// When 1.8 split a coarse scope into actions (e.g. finance.write →
// finance.invoice.create / finance.invoice.lineItems / finance.payment.create),
// every rank bundle received all of the pieces it previously covered, so no
// existing member's access changed (pinned by src/test/permissions.test.ts).

export type PermissionScope =
  | 'academicYears.read'
  | 'admissions.decide'
  | 'admissions.manage'
  | 'admissions.read'
  | 'academicYears.write'
  | 'approvals.decide'
  | 'attendance.read'
  | 'attendance.write'
  | 'audit.export'
  | 'audit.read'
  | 'branches.manage'
  | 'branches.read'
  | 'classes.read'
  | 'classes.write'
  | 'dashboard.read'
  | 'datasets.read'
  | 'datasets.write'
  | 'documents.delete'
  | 'documents.upload'
  | 'documents.verify'
  | 'enrollments.assign'
  | 'enrollments.read'
  | 'enrollments.transfer'
  | 'enrollments.withdraw'
  | 'finance.discount.approve'
  | 'finance.feeStructure.manage'
  | 'finance.invoice.create'
  | 'finance.invoice.lineItems'
  | 'finance.invoice.void'
  | 'finance.payment.create'
  | 'finance.payment.void'
  | 'finance.read'
  | 'finance.refund.approve'
  | 'hr.employee.update'
  | 'hr.read'
  | 'memberships.manage'
  | 'notifications.manage'
  | 'notifications.run'
  | 'parents.manage'
  | 'parents.read'
  | 'parents.write'
  | 'reports.finance'
  | 'search.read'
  | 'settings.manage'
  | 'settings.read'
  | 'students.create'
  | 'students.custody'
  | 'students.delete'
  | 'students.read'
  | 'students.update'
  | 'transport.manage'
  | 'transport.read'
  | 'transport.write'

/** Every read-only scope, granted at every rank including `viewer`.
 * `audit.read` is deliberately not here — the audit feed is admin-only. */
const VIEWER_SCOPES: readonly PermissionScope[] = [
  'academicYears.read',
  'attendance.read',
  'branches.read',
  'classes.read',
  'dashboard.read',
  'datasets.read',
  'enrollments.read',
  'finance.read',
  'parents.read',
  'search.read',
  'settings.read',
  'students.read',
  'transport.read',
]

/** Routine day-to-day writes. */
const SCHEDULER_SCOPES: readonly PermissionScope[] = [
  ...VIEWER_SCOPES,
  'academicYears.write',
  // Applicant records are personal data: not in the viewer bundle.
  'admissions.manage',
  'admissions.read',
  'attendance.write',
  'datasets.write',
  'finance.invoice.create',
  'finance.invoice.lineItems',
  'finance.payment.create',
  'notifications.run',
  'parents.write',
  'students.create',
  'students.update',
  'transport.write',
]

/** Higher-trust actions, plus scopes reserved for routes later phases add
 * (refunds, reports, documents, approvals, HR). */
const ADMIN_SCOPES: readonly PermissionScope[] = [
  ...SCHEDULER_SCOPES,
  'admissions.decide',
  'approvals.decide',
  'audit.export',
  'audit.read',
  'branches.manage',
  'classes.write',
  'documents.delete',
  'documents.upload',
  'documents.verify',
  'enrollments.assign',
  'enrollments.transfer',
  'enrollments.withdraw',
  'finance.discount.approve',
  'finance.feeStructure.manage',
  'finance.invoice.void',
  'finance.payment.void',
  'finance.refund.approve',
  'hr.employee.update',
  'hr.read',
  'memberships.manage',
  'notifications.manage',
  'parents.manage',
  'reports.finance',
  'settings.manage',
  'students.custody',
  'students.delete',
  'transport.manage',
]

/** Owner's extra power ("only an owner grants owner") is a rank rule in the
 * memberships routes, not a scope. */
const OWNER_SCOPES: readonly PermissionScope[] = ADMIN_SCOPES

export const ROLE_SCOPES: Record<Role, ReadonlySet<PermissionScope>> = {
  viewer: new Set(VIEWER_SCOPES),
  scheduler: new Set(SCHEDULER_SCOPES),
  admin: new Set(ADMIN_SCOPES),
  owner: new Set(OWNER_SCOPES),
}

// ------------------------------------------------------------- presets --

export const ROLE_KEYS = [
  'school_admin',
  'branch_admin',
  'registrar',
  'finance_officer',
  'hr',
  'operations',
  'reception',
] as const
export type RoleKey = (typeof ROLE_KEYS)[number]

export interface RolePreset {
  /** Base rank: stored as `MembershipDoc.role`, carried in the JWT, and
   * compared by the rank rules (who may grant whom). */
  rank: Role
  scopes: ReadonlySet<PermissionScope>
  /** Must be confined to specific branches (`branchIds` non-null). */
  requiresBranches: boolean
}

/** Everything a viewer sees except finance — the shared base for the
 * non-finance office roles. */
const OFFICE_READ = VIEWER_SCOPES.filter((s) => s !== 'finance.read')

const preset = (
  rank: Role,
  scopes: readonly PermissionScope[],
  requiresBranches = false,
): RolePreset => ({ rank, scopes: new Set(scopes), requiresBranches })

export const PRESETS: Record<RoleKey, RolePreset> = {
  school_admin: preset('admin', ADMIN_SCOPES),
  branch_admin: preset(
    'admin',
    ADMIN_SCOPES.filter(
      (s) => !['memberships.manage', 'settings.manage', 'branches.manage', 'audit.export'].includes(s),
    ),
    true,
  ),
  registrar: preset('scheduler', [
    ...OFFICE_READ,
    'academicYears.write',
    'admissions.manage',
    'admissions.read',
    'classes.write',
    'documents.upload',
    'documents.verify',
    'enrollments.assign',
    'enrollments.transfer',
    'enrollments.withdraw',
    'parents.write',
    'students.create',
    'students.custody',
    'students.update',
  ]),
  finance_officer: preset('scheduler', [
    ...VIEWER_SCOPES,
    'finance.discount.approve',
    'finance.feeStructure.manage',
    'finance.invoice.create',
    'finance.invoice.lineItems',
    'finance.invoice.void',
    'finance.payment.create',
    'finance.payment.void',
    'finance.refund.approve',
    'reports.finance',
  ]),
  hr: preset('viewer', [...OFFICE_READ, 'hr.employee.update', 'hr.read']),
  operations: preset('scheduler', [
    ...OFFICE_READ,
    'attendance.write',
    'datasets.write',
    'notifications.run',
    'transport.manage',
    'transport.write',
  ]),
  reception: preset('viewer', [
    ...OFFICE_READ,
    'admissions.manage',
    'admissions.read',
    'attendance.write',
    'parents.write',
    'students.create',
  ]),
}

/** The scope set a member resolves to. */
export function scopesFor(role: Role | undefined, roleKey?: RoleKey | null): ReadonlySet<PermissionScope> {
  if (roleKey && PRESETS[roleKey]) return PRESETS[roleKey].scopes
  return (role && ROLE_SCOPES[role]) || new Set()
}
