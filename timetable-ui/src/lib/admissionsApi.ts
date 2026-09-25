import { settingsRequest, type SettingsResult } from './settingsApi'
import type { TokenGetter } from './http'

/** Client for admissions (SAMS 2.5, server/src/admissions). */

export type ApplicationStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'accepted'
  | 'rejected'
  | 'waitlisted'
  | 'converted'
  | 'withdrawn'

/** Chip tone per status. */
export const STATUS_TONE: Record<ApplicationStatus, string> = {
  draft: '',
  submitted: 'chip--warn',
  under_review: 'chip--warn',
  waitlisted: 'chip--warn',
  accepted: 'chip--ok',
  converted: 'chip--ok',
  rejected: 'chip--bad',
  withdrawn: '',
}

export interface ApplicationGuardian {
  id?: string
  fullName: string
  relationship: string
  phone: string
  email: string | null
  preferredLanguage: 'en' | 'ar'
  primaryContact: boolean
  existingParentId: string | null
}

export interface Applicant {
  givenName: string
  familyName: string
  givenNameAr: string | null
  familyNameAr: string | null
  dob: string | null
  gender: 'male' | 'female' | null
  nationality: string | null
  nationalId: string | null
  previousSchool: string | null
}

export interface ChecklistItem {
  category: string
  documentId: string | null
  status: 'missing' | 'unverified' | 'verified' | 'rejected'
}

export interface Application {
  id: string
  applicationNumber: string
  branchId: string
  academicYearId: string
  gradeLevel: string
  applicant: Applicant
  guardians: ApplicationGuardian[]
  source: string | null
  notes: string | null
  requiredDocuments: string[]
  status: ApplicationStatus
  decision: { outcome: string; note: string | null; decidedBy: string; decidedAt: string } | null
  submittedAt: string | null
  convertedStudentId: string | null
  convertedAt: string | null
  withdrawnReason: string | null
  createdAt: string
  updatedAt: string
  /** Detail only. */
  checklist?: ChecklistItem[]
}

export type ApplicationInput = Pick<
  Application,
  'academicYearId' | 'gradeLevel' | 'applicant' | 'guardians' | 'source' | 'notes' | 'requiredDocuments'
> & { branchId: string }

const base = '/admissions/applications'

export async function listApplications(
  getToken: TokenGetter,
  filters: { status?: ApplicationStatus; branchId?: string; search?: string } = {},
): Promise<SettingsResult<Application[]>> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v)
  const res = await settingsRequest<{ applications: Application[] }>(`${base}?${params}`, { method: 'GET' }, getToken)
  return res.kind === 'ok' ? { kind: 'ok', data: res.data.applications } : res
}

export const getApplication = (getToken: TokenGetter, id: string) =>
  settingsRequest<Application>(`${base}/${encodeURIComponent(id)}`, { method: 'GET' }, getToken)

export const createApplication = (getToken: TokenGetter, body: ApplicationInput) =>
  settingsRequest<Application>(base, { method: 'POST', body: JSON.stringify(body) }, getToken)

export const updateApplication = (getToken: TokenGetter, id: string, body: Partial<ApplicationInput>) =>
  settingsRequest<Application>(`${base}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }, getToken)

export const stepApplication = (
  getToken: TokenGetter,
  id: string,
  action: 'submit' | 'review' | 'withdraw',
  body: Record<string, unknown> = {},
) =>
  settingsRequest<Application>(`${base}/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body) }, getToken)

export const convertApplication = (
  getToken: TokenGetter,
  id: string,
  body: { classId: string; studentNumber: string; startDate: string },
) =>
  settingsRequest<{ studentId: string; enrollmentId: string; parentIds: string[] }>(
    `${base}/${encodeURIComponent(id)}/convert`,
    { method: 'POST', body: JSON.stringify(body) },
    getToken,
  )
