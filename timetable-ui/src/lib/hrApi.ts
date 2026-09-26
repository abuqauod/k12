import type { TokenGetter } from './http'
import { api, enc, pick, qs } from './apiClient'

/** Client for `/hr/*` (SAMS Phase 4). */

export interface Employee {
  id: string
  employeeNumber: string
  branchId: string
  givenName: string
  familyName: string
  fullName: string
  fullNameAr: string | null
  gender: 'male' | 'female' | null
  dob: string | null
  nationality: string | null
  nationalId: string | null
  phone: string | null
  email: string | null
  address: string | null
  departmentCode: string | null
  positionCode: string | null
  hireDate: string
  status: 'active' | 'terminated'
  terminationDate: string | null
  terminationReason: string | null
  userId: string | null
  emergencyContactName: string | null
  emergencyContactPhone: string | null
  notes: string | null
  createdAt: string
  /** On list reads: the contract in force today. */
  contract?: Contract | null
  /** On detail reads. */
  linkedUser?: { id: string; email: string; displayName: string | null } | null
}

export type ContractStatus = 'upcoming' | 'active' | 'expiring' | 'expired' | 'renewed' | 'terminated' | 'ended'
export interface Contract {
  id: string
  employeeId: string
  typeCode: string
  startDate: string
  endDate: string | null
  salary: number | null
  salaryHidden: boolean
  hoursPerWeek: number | null
  notes: string | null
  status: ContractStatus
  employeeName?: string
  employeeNumber?: string
}

export interface EmploymentEvent {
  id: string
  type: string
  date: string
  from: string | null
  to: string | null
  note: string | null
}

export interface LeaveType {
  code: string
  name: string
  nameAr: string | null
  daysPerYear: number | null
  paid: boolean
  active: boolean
}

export interface LeaveBalance {
  typeCode: string
  name: string
  nameAr: string | null
  paid: boolean
  entitlement: number | null
  adjustments: number
  taken: number
  pending: number
  available: number | null
}

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'
export interface LeaveRequest {
  id: string
  employeeId: string
  employeeName: string | null
  branchId: string
  typeCode: string
  startDate: string
  endDate: string
  days: number
  reason: string | null
  status: LeaveStatus
  requestedBy: string
  createdAt: string
}

export interface LeaveOverview {
  year: number
  balances: LeaveBalance[]
  requests: LeaveRequest[]
  adjustments: { id: string; typeCode: string; days: number; reason: string; createdAt: string }[]
}

export type StaffMark = 'present' | 'absent' | 'late' | 'excused' | 'leave'
export interface AttendanceRow {
  employeeId: string
  employeeNumber: string
  name: string
  positionCode: string | null
  status: StaffMark | null
  recorded: boolean
  leaveTypeCode: string | null
  checkIn: string | null
  checkOut: string | null
  note: string | null
}

export interface HrSummary {
  asOf: string
  headcount: {
    active: number
    terminated: number
    byDepartment: { key: string; count: number }[]
    byPosition: { key: string; count: number }[]
    byBranch: { key: string; count: number }[]
    byGender: { key: string; count: number }[]
  }
  movement: { hires: number; terminations: number }
  contracts: {
    expiring: { employeeId: string; name: string; typeCode: string; endDate: string; status: ContractStatus }[]
    withoutContract: { employeeId: string; name: string }[]
  }
  documents: {
    documentId: string
    employeeId: string
    name: string
    categoryCode: string
    fileName: string
    expiresAt: string
    expired: boolean
  }[]
  leave: { pendingRequests: number; byType: { typeCode: string; days: number; requests: number }[] }
  attendance: { byStatus: { key: string; count: number }[]; mostAbsent: { employeeId: string; name: string; days: number }[] }
}

export type NewEmployee = Partial<
  Omit<Employee, 'id' | 'employeeNumber' | 'status' | 'fullName' | 'createdAt' | 'contract' | 'linkedUser'>
> & {
  branchId: string
  givenName: string
  familyName: string
  hireDate: string
  contract?: NewContract
}
export interface NewContract {
  typeCode: string
  startDate: string
  endDate: string | null
  salary: number | null
  hoursPerWeek?: number | null
  notes?: string | null
}

type G = TokenGetter

export const listEmployees = (g: G, p: { branchId?: string; status?: string; q?: string } = {}) =>
  pick(api<{ employees: Employee[] }>(g, 'GET', `/hr/employees${qs(p)}`), 'employees')
export const getEmployee = (g: G, id: string) => api<Employee>(g, 'GET', `/hr/employees/${enc(id)}`)
export const createEmployee = (g: G, body: NewEmployee) => api<Employee>(g, 'POST', '/hr/employees', body)
export const updateEmployee = (g: G, id: string, patch: Record<string, unknown>) =>
  api<Employee>(g, 'PATCH', `/hr/employees/${enc(id)}`, patch)
export const terminateEmployee = (g: G, id: string, date: string, reason: string) =>
  api<Employee>(g, 'POST', `/hr/employees/${enc(id)}/terminate`, { date, reason })
export const rehireEmployee = (g: G, id: string, date: string) => api<Employee>(g, 'POST', `/hr/employees/${enc(id)}/rehire`, { date })
export const linkUser = (g: G, id: string, userId: string | null) => api<Employee>(g, 'PUT', `/hr/employees/${enc(id)}/user`, { userId })
export const employeeHistory = (g: G, id: string) =>
  pick(api<{ events: EmploymentEvent[] }>(g, 'GET', `/hr/employees/${enc(id)}/history`), 'events')
export const employeeContracts = (g: G, id: string) =>
  pick(api<{ contracts: Contract[] }>(g, 'GET', `/hr/employees/${enc(id)}/contracts`), 'contracts')
export const addContract = (g: G, id: string, body: NewContract) => api<Contract>(g, 'POST', `/hr/employees/${enc(id)}/contracts`, body)
export const renewContract = (g: G, id: string, body: { endDate: string | null; salary?: number | null; typeCode?: string }) =>
  api<Contract>(g, 'POST', `/hr/contracts/${enc(id)}/renew`, body)
export const endContract = (g: G, id: string, date: string) => api<Contract>(g, 'POST', `/hr/contracts/${enc(id)}/end`, { date })
export const expiringContracts = (g: G, branchId?: string) =>
  pick(api<{ contracts: Contract[] }>(g, 'GET', `/hr/contracts/expiring${qs({ branchId })}`), 'contracts')

export const listLeaveTypes = (g: G) => pick(api<{ leaveTypes: LeaveType[] }>(g, 'GET', '/hr/leave-types'), 'leaveTypes')
export const createLeaveType = (g: G, body: Omit<LeaveType, 'active'>) => api<LeaveType>(g, 'POST', '/hr/leave-types', body)
export const updateLeaveType = (g: G, code: string, patch: Partial<LeaveType>) =>
  api<LeaveType>(g, 'PATCH', `/hr/leave-types/${enc(code)}`, patch)
export const employeeLeave = (g: G, id: string, year: number) =>
  api<LeaveOverview>(g, 'GET', `/hr/employees/${enc(id)}/leave${qs({ year })}`)
export const adjustLeave = (g: G, id: string, body: { typeCode: string; year: number; days: number; reason: string }) =>
  api<{ id: string }>(g, 'POST', `/hr/employees/${enc(id)}/leave-adjustments`, body)
export const myHr = (g: G, year?: number) => api<LeaveOverview & { employee: Employee }>(g, 'GET', `/hr/me${qs({ year })}`)
export const listLeaveRequests = (g: G, p: { branchId?: string; status?: string; employeeId?: string; from?: string; to?: string } = {}) =>
  pick(api<{ requests: LeaveRequest[] }>(g, 'GET', `/hr/leave-requests${qs(p)}`), 'requests')
export const requestLeave = (
  g: G,
  body: { employeeId: string; typeCode: string; startDate: string; endDate: string; reason: string | null },
) => api<LeaveRequest & { approvalId: string }>(g, 'POST', '/hr/leave-requests', body)
export const cancelLeave = (g: G, id: string) => api<LeaveRequest>(g, 'POST', `/hr/leave-requests/${enc(id)}/cancel`, {})

export const attendanceSheet = (g: G, branchId: string, date: string) =>
  api<{ date: string; sessionDay: boolean; rows: AttendanceRow[] }>(g, 'GET', `/hr/attendance${qs({ branchId, date })}`)
export const saveAttendance = (
  g: G,
  body: {
    branchId: string
    date: string
    records: { employeeId: string; status: StaffMark; checkIn: string | null; checkOut: string | null; note: string | null }[]
  },
) => api<{ saved: number }>(g, 'PUT', '/hr/attendance', body)
export const employeeAttendance = (g: G, id: string, from: string, to: string) =>
  api<{
    counts: Record<string, number>
    records: { date: string; status: StaffMark; checkIn: string | null; checkOut: string | null; note: string | null }[]
  }>(g, 'GET', `/hr/employees/${enc(id)}/attendance${qs({ from, to })}`)
export const hrSummary = (g: G, p: { branchId?: string; from: string; to: string }) =>
  api<HrSummary>(g, 'GET', `/hr/reports/summary${qs(p)}`)
