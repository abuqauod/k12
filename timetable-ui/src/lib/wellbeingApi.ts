import type { TokenGetter } from './http'
import { api, enc, pick, qs } from './apiClient'

/** Client for health/clinic and behaviour incidents (backlog). */

// ---------------------------------------------------------------- health --

export type Severity = 'mild' | 'moderate' | 'severe'
export interface HealthItem {
  id?: string
  name: string
  notes: string | null
  alert: boolean
}
export interface Allergy extends HealthItem {
  severity: Severity
  reaction: string | null
}
export interface Medication {
  id?: string
  name: string
  dose: string | null
  schedule: string | null
  atSchool: boolean
}
export interface HealthProfile {
  bloodType: string | null
  allergies: Allergy[]
  conditions: HealthItem[]
  medications: Medication[]
  doctorName: string | null
  doctorPhone: string | null
  notes: string | null
  updatedAt?: string
}
export type Outcome = 'returned_to_class' | 'rested' | 'sent_home' | 'referred' | 'emergency'
export const OUTCOMES: Outcome[] = ['returned_to_class', 'rested', 'sent_home', 'referred', 'emergency']
export interface ClinicVisit {
  id: string
  studentId: string
  studentName: string
  studentNumber: string
  branchId: string
  visitedAt: string
  complaint: string
  temperature: number | null
  treatment: string | null
  medicationGiven: string | null
  outcome: Outcome
  notes: string | null
  parentsNotifiedAt: string | null
}
export interface VisitInput {
  studentId: string
  complaint: string
  temperature: number | null
  treatment: string | null
  medicationGiven: string | null
  outcome: Outcome
  notes: string | null
  notifyParents: boolean
}
export interface HealthAlert {
  kind: 'allergy' | 'condition'
  name: string
  severity: Severity | null
  notes: string | null
}

export const getAlerts = (getToken: TokenGetter, studentId: string) =>
  pick(api<{ alerts: HealthAlert[] }>(getToken, 'GET', `/students/${enc(studentId)}/alerts`), 'alerts')
export const getHealth = (getToken: TokenGetter, studentId: string) =>
  api<{ profile: HealthProfile | null; visits: ClinicVisit[] }>(getToken, 'GET', `/students/${enc(studentId)}/health`)
export const saveHealth = (getToken: TokenGetter, studentId: string, body: HealthProfile) =>
  api<{ profile: HealthProfile }>(getToken, 'PUT', `/students/${enc(studentId)}/health`, body)
export const listVisits = (getToken: TokenGetter, params: { branchId?: string; studentId?: string; from?: string; to?: string }) =>
  pick(api<{ visits: ClinicVisit[] }>(getToken, 'GET', `/clinic/visits${qs(params)}`), 'visits')
export const recordVisit = (getToken: TokenGetter, body: VisitInput) =>
  api<ClinicVisit & { delivered: { families: number } | null }>(getToken, 'POST', '/clinic/visits', body)
export interface AlertRow {
  studentId: string
  studentName: string
  studentNumber: string
  studentGroup: string
  alerts: HealthAlert[]
  medicationsAtSchool: { name: string; dose: string | null; schedule: string | null }[]
}
export const listClinicAlerts = (getToken: TokenGetter, branchId?: string) =>
  pick(api<{ students: AlertRow[] }>(getToken, 'GET', `/clinic/alerts${qs({ branchId })}`), 'students')

// ------------------------------------------------------------ discipline --

export type IncidentSeverity = 'minor' | 'moderate' | 'major'
export type IncidentStatus = 'open' | 'resolved' | 'dismissed'
export interface IncidentAction {
  id: string
  studentId: string
  code: string
  note: string | null
  startDate: string | null
  endDate: string | null
  decidedAt: string
}
export interface Incident {
  id: string
  incidentNumber: string
  branchId: string
  students: { id: string; name: string; studentNumber: string; studentGroup: string }[]
  occurredAt: string
  location: string | null
  typeCode: string
  severity: IncidentSeverity
  description: string
  witnesses: string | null
  status: IncidentStatus
  actions: IncidentAction[]
  parentsNotifiedAt: string | null
  resolution: string | null
  reportedBy: string
  createdAt: string
}
export interface IncidentInput {
  studentIds: string[]
  occurredAt?: string
  location: string | null
  typeCode: string
  severity: IncidentSeverity
  description: string
  witnesses: string | null
}

export const listIncidents = (getToken: TokenGetter, params: { branchId?: string; studentId?: string; status?: string }) =>
  api<{ incidents: Incident[]; canManage: boolean }>(getToken, 'GET', `/discipline/incidents${qs(params)}`)
export const reportIncident = (getToken: TokenGetter, body: IncidentInput) => api<Incident>(getToken, 'POST', '/discipline/incidents', body)
export const addIncidentAction = (
  getToken: TokenGetter,
  id: string,
  body: { studentId: string; code: string; note: string | null; startDate: string | null; endDate: string | null },
) => api<Incident>(getToken, 'POST', `/discipline/incidents/${enc(id)}/actions`, body)
export const setIncidentStatus = (getToken: TokenGetter, id: string, status: IncidentStatus, resolution: string | null) =>
  api<Incident>(getToken, 'POST', `/discipline/incidents/${enc(id)}/status`, { status, resolution })
export const notifyIncident = (getToken: TokenGetter, id: string, studentIds?: string[]) =>
  api<{ families: number; inApp: number; email: number; sms: number }>(getToken, 'POST', `/discipline/incidents/${enc(id)}/notify`, {
    studentIds,
  })
