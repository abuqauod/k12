export type ParentStatus = 'active' | 'inactive' | 'archived'
export type PreferredContactMethod = 'phone' | 'email' | 'sms' | 'whatsapp'

export interface Parent {
  id: string
  fullName: string
  fullNameAr: string | null
  nationalId: string | null
  primaryPhone: string
  alternativePhone: string | null
  email: string | null
  address: string | null
  city: string | null
  preferredContactMethod: PreferredContactMethod
  status: ParentStatus
  occupation: string | null
  employer: string | null
  emergencyContactName: string | null
  emergencyContactPhone: string | null
  notes: string | null
  portalAccess: { enabled: boolean; userId: string | null }
  linkedStudentCount: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

/** The relationship between one parent and one student — many-to-many at
 * the database level (server/src/db.ts's ParentStudentLinkDoc), never a
 * duplicated copy of student data. */
export interface ParentStudentLink {
  id: string
  parentId: string
  studentId: string
  relationshipType: string
  primaryContact: boolean
  secondaryContact: boolean
  emergencyContact: boolean
  authorizedPickup: boolean
  /** Forward-hook for the future Payments/Finance module. */
  financialResponsibility: boolean
  communicationPermissions: { email: boolean; sms: boolean }
  /** Forward-hook for a future parent portal. */
  portalAccess: boolean
  active: boolean
}

/** A student's live data, composed server-side from Student/Enrollment/
 * Class/Branch/AcademicYear on every read — never stored on the parent or
 * the link, so it can never drift from the source of truth. */
export interface LinkedStudentSummary {
  linkId: string
  studentId: string
  studentNumber: string
  givenName: string
  familyName: string
  dob: string | null
  age: number | null
  gender: 'male' | 'female' | null
  branchId: string | null
  branchName: string | null
  academicYearId: string | null
  academicYearName: string | null
  classId: string | null
  classLabel: string | null
  enrollmentStatus: string | null
  enrollmentStartDate: string | null
  studentStatus: string
  stopId: string
  transportMode: string
  lat: number | null
  lng: number | null
  relationshipType: string
  primaryContact: boolean
  secondaryContact: boolean
  emergencyContact: boolean
  authorizedPickup: boolean
  financialResponsibility: boolean
  communicationPermissions: { email: boolean; sms: boolean }
  portalAccess: boolean
  linkActive: boolean
  /** Minor units (fils/cents) — see `domain/finance.ts`'s `formatMinorUnits`
   * to display. Composed server-side from real invoices/payments, never
   * stored here — zero for a student with no invoices, not missing data. */
  invoicedTotal: number
  paidTotal: number
  outstandingBalance: number
}

export interface ParentDetail extends Parent {
  students: LinkedStudentSummary[]
}

/** A possible existing match surfaced as a warning — never blocks the save. */
export interface DuplicateCandidate {
  id: string
  fullName: string
  primaryPhone: string
  email: string | null
  nationalId: string | null
  matchedOn: Array<'nationalId' | 'primaryPhone' | 'alternativePhone' | 'email'>
  /** Another branch's family — no personal details are returned. */
  restricted?: boolean
}

export const PREFERRED_CONTACT_METHODS: PreferredContactMethod[] = ['phone', 'email', 'sms', 'whatsapp']

/** A blank parent for the "add" form. */
export function emptyParent(): Omit<Parent, 'id' | 'linkedStudentCount' | 'createdAt' | 'updatedAt' | 'archivedAt'> {
  return {
    fullName: '',
    fullNameAr: null,
    nationalId: null,
    primaryPhone: '',
    alternativePhone: null,
    email: null,
    address: null,
    city: null,
    preferredContactMethod: 'phone',
    status: 'active',
    occupation: null,
    employer: null,
    emergencyContactName: null,
    emergencyContactPhone: null,
    notes: null,
    portalAccess: { enabled: false, userId: null },
  }
}

/** A blank relationship for the "link a student" form. */
export function emptyLink(): Omit<ParentStudentLink, 'id' | 'parentId' | 'studentId' | 'active'> {
  return {
    relationshipType: 'Guardian',
    primaryContact: false,
    secondaryContact: false,
    emergencyContact: false,
    authorizedPickup: false,
    financialResponsibility: false,
    communicationPermissions: { email: true, sms: false },
    portalAccess: false,
  }
}
