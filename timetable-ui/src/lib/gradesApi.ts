import type { TokenGetter } from './http'
import { api, enc, qs } from './apiClient'

/** SAMS 11.2: gradebook and report cards. */

type G = TokenGetter

export interface GradeBand {
  min: number
  code: string
  label: string
  labelAr: string
}
export interface PlanAssessment {
  id?: string
  name: string
  nameAr: string | null
  weight: number
  maxScore: number
}
export interface PlanTerm {
  termId: string
  weight: number
  assessments: PlanAssessment[]
}
export interface Plan {
  id?: string
  academicYearId: string
  gradeLevel: string
  subjects: string[]
  terms: PlanTerm[]
}
export interface Sheet {
  assessments: Required<PlanAssessment>[]
  released: boolean
  students: { id: string; name: string; studentNumber: string }[]
  marks: { studentId: string; assessmentId: string; score: number | null }[]
}
export interface SubjectResult {
  percent: number | null
  band: GradeBand | null
  passed: boolean | null
}
export interface ResultRow {
  id: string
  name: string
  studentNumber: string
  comment: string | null
  subjects: Record<string, SubjectResult>
  average: number | null
  band: GradeBand | null
  rank: number | null
  failed: number
}
export interface Results {
  subjects: string[]
  passMark: number
  released: boolean
  releasedTerms: string[]
  students: ResultRow[]
}

export const getGrading = (g: G) => api<{ bands: GradeBand[]; passMark: number }>(g, 'GET', '/grades/settings')
export const saveGrading = (g: G, body: { bands: GradeBand[]; passMark: number }) =>
  api<{ bands: GradeBand[]; passMark: number }>(g, 'PUT', '/grades/settings', body)
export const listPlans = (g: G, academicYearId: string) => api<{ plans: Plan[] }>(g, 'GET', `/grades/plans${qs({ academicYearId })}`)
export const savePlan = (g: G, plan: Plan) => api<Plan>(g, 'PUT', '/grades/plans', plan)
export const getSheet = (g: G, q: { classId: string; subjectCode: string; termId: string }) => api<Sheet>(g, 'GET', `/grades/sheet${qs(q)}`)
export const saveSheet = (
  g: G,
  body: {
    classId: string
    subjectCode: string
    termId: string
    entries: { studentId: string; assessmentId: string; score: number | null }[]
  },
) => api<{ saved: number }>(g, 'PUT', '/grades/sheet', body)
export const getResults = (g: G, q: { classId: string; termId: string }) => api<Results>(g, 'GET', `/grades/results${qs(q)}`)
export const saveComment = (g: G, body: { studentId: string; termId: string; comment: string }) =>
  api<{ ok: true }>(g, 'PUT', '/grades/comments', body)
export const release = (g: G, body: { classId: string; termId: string }) =>
  api<{ released: true; students: number }>(g, 'POST', '/grades/release', body)
export const unrelease = (g: G, body: { classId: string; termId: string }) => api<{ released: false }>(g, 'POST', '/grades/unrelease', body)
export const reportCardsPath = (q: { classId: string; termId: string; lang: 'en' | 'ar'; studentId?: string }) =>
  `/grades/report-cards${qs({ ...q, autoprint: '1' })}`

export const portalReportCards = (g: G, studentId: string, lang: 'en' | 'ar') =>
  api<{ cards: { termId: string; term: string; releasedAt: string }[] }>(
    g,
    'GET',
    `/portal/children/${enc(studentId)}/report-cards${qs({ lang })}`,
  )
export const portalReportCardPath = (studentId: string, termId: string, lang: 'en' | 'ar') =>
  `/portal/children/${enc(studentId)}/report-cards/${enc(termId)}${qs({ lang })}`
