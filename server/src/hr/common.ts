import { randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { ContractDoc, EmployeeDoc, EmploymentEventType, TenantContext } from '../db.js'
import { callerCanUseBranch } from '../auth/guard.js'
import { withTenant } from '../db.js'
import { activeCodes, ensureDefaults } from '../settings/lookups.js'

/** Shared by the HR modules (SAMS Phase 4). */

export const EXPIRING_DAYS = 60

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const fullName = (e: Pick<EmployeeDoc, 'givenName' | 'familyName'>) => `${e.givenName} ${e.familyName}`.trim()

export function employeeResponse(doc: EmployeeDoc) {
  return {
    id: doc._id,
    employeeNumber: doc.employeeNumber,
    branchId: doc.branchId,
    givenName: doc.givenName,
    familyName: doc.familyName,
    fullName: fullName(doc),
    fullNameAr: doc.fullNameAr,
    gender: doc.gender,
    dob: doc.dob,
    nationality: doc.nationality,
    nationalId: doc.nationalId,
    phone: doc.phone,
    email: doc.email,
    address: doc.address,
    departmentCode: doc.departmentCode,
    positionCode: doc.positionCode,
    hireDate: doc.hireDate,
    status: doc.status,
    terminationDate: doc.terminationDate,
    terminationReason: doc.terminationReason,
    userId: doc.userId,
    emergencyContactName: doc.emergencyContactName,
    emergencyContactPhone: doc.emergencyContactPhone,
    notes: doc.notes,
    createdAt: doc.createdAt.toISOString(),
  }
}

export type ContractStatus = 'upcoming' | 'active' | 'expiring' | 'expired' | 'renewed' | 'terminated' | 'ended'

/** A contract's standing on `today`: closed ones by how they closed, else
 * by their dates (expiring = ends within `EXPIRING_DAYS`). */
export function contractStatus(c: ContractDoc, today: string): ContractStatus {
  if (c.closedReason) return c.closedReason
  if (c.startDate > today) return 'upcoming'
  if (c.endDate && c.endDate < today) return 'expired'
  if (c.endDate && c.endDate <= addDays(today, EXPIRING_DAYS)) return 'expiring'
  return 'active'
}

export function contractResponse(c: ContractDoc, today: string, showSalary: boolean) {
  return {
    id: c._id,
    employeeId: c.employeeId,
    branchId: c.branchId,
    typeCode: c.typeCode,
    startDate: c.startDate,
    endDate: c.endDate,
    salary: showSalary ? c.salary : null,
    salaryHidden: !showSalary && c.salary !== null,
    hoursPerWeek: c.hoursPerWeek,
    notes: c.notes,
    status: contractStatus(c, today),
    closedReason: c.closedReason,
    renewedFromId: c.renewedFromId,
    createdAt: c.createdAt.toISOString(),
  }
}

/** The contract covering `date`, if any (not one closed before it). */
export function coveringContract(contracts: ContractDoc[], date: string): ContractDoc | undefined {
  return contracts.find((c) => c.startDate <= date && (c.endDate === null || c.endDate >= date))
}

/** Checks a settings-list code is active; null passes. */
export async function checkCode(tenantId: string, kind: string, code: string | null | undefined): Promise<boolean> {
  if (code === null || code === undefined) return true
  await ensureDefaults(tenantId, kind)
  return withTenant(tenantId, async (ctx) => (await activeCodes(ctx, kind)).has(code))
}

/** Loads an employee and checks the caller may use its branch. */
export async function employeeAccess(request: FastifyRequest, tenantId: string, id: string) {
  const doc = await withTenant(tenantId, (ctx) => ctx.employees.findOne({ _id: id }))
  if (!doc) return { ok: false as const, status: 404, error: 'UNKNOWN_EMPLOYEE' }
  if (!(await callerCanUseBranch(request, doc.branchId))) return { ok: false as const, status: 403, error: 'BRANCH_FORBIDDEN' }
  return { ok: true as const, doc }
}

export async function recordEvent(
  ctx: TenantContext,
  tenantId: string,
  event: {
    employeeId: string
    branchId: string
    type: EmploymentEventType
    date: string
    from?: string | null
    to?: string | null
    note?: string | null
    actorId: string | null
  },
): Promise<void> {
  await ctx.employmentEvents.insertOne({
    _id: randomUUID(),
    tenantId,
    employeeId: event.employeeId,
    branchId: event.branchId,
    type: event.type,
    date: event.date,
    from: event.from ?? null,
    to: event.to ?? null,
    note: event.note ?? null,
    actorId: event.actorId,
    createdAt: new Date(),
  })
}
