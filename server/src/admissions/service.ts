import { randomUUID } from 'node:crypto'
import type { ApplicationDoc, ParentDoc, StudentDoc, TenantContext } from '../db.js'
import { recordAudit } from '../audit.js'
import { openEnrollment } from '../enrollments/service.js'
import { nextNumber } from '../numbering.js'

/**
 * Admissions (SAMS 2.5): an application moves
 *   draft → submitted → under_review → accepted | rejected | waitlisted
 *   accepted → converted
 * and may be withdrawn at any point before conversion. A decision goes
 * through the shared approval engine (./approvals.ts). Conversion turns an
 * accepted application into a student, their parents and a planned
 * (`pending`) enrollment in one transaction.
 */

/** New applications start with this checklist; staff can change it per
 * applicant. Codes are `documentCategory` settings-list codes. */
export const DEFAULT_REQUIRED_DOCUMENTS = ['birth_certificate', 'photo', 'previous_report']

/** States in which the application's details can still be edited. */
export const EDITABLE: ReadonlySet<ApplicationDoc['status']> = new Set([
  'draft',
  'submitted',
  'under_review',
  'waitlisted',
  'accepted',
])

export async function nextApplicationNumber(ctx: TenantContext, tenantId: string): Promise<string> {
  return nextNumber(ctx, tenantId, 'applicationNumber')
}

export interface ChecklistItem {
  category: string
  /** The current document in that category, if any (not archived). */
  documentId: string | null
  status: 'missing' | 'unverified' | 'verified' | 'rejected'
}

/** Required documents and where each stands. A rejected document counts
 * as missing for the decision (it has to be provided again). */
export async function checklist(ctx: TenantContext, app: ApplicationDoc): Promise<ChecklistItem[]> {
  const docs = await ctx.documents
    .find({ ownerType: 'application', ownerId: app._id, isCurrent: true, archivedAt: null })
    .sort({ createdAt: -1 })
    .toArray()
  return app.requiredDocuments.map((category) => {
    const inCategory = docs.filter((d) => d.categoryCode === category)
    // Prefer a usable document over a rejected one in the same category.
    const best = inCategory.find((d) => d.verification.status !== 'rejected') ?? inCategory[0]
    return {
      category,
      documentId: best?._id ?? null,
      status: best ? best.verification.status : 'missing',
    }
  })
}

export const checklistComplete = (items: ChecklistItem[]) =>
  items.every((i) => i.status === 'unverified' || i.status === 'verified')

const digits = (phone: string) => {
  const d = phone.replace(/[^\d]/g, '')
  return d.length > 9 ? d.slice(-9) : d.replace(/^0+/, '')
}

export type ConvertResult =
  | { ok: true; studentId: string; enrollmentId: string; parentIds: string[] }
  | { ok: false; error: string }

/**
 * Accepted application → student + parents + links + a pending enrollment,
 * in the caller's transaction. Nothing is retyped: the applicant's details,
 * the guardians and the documents all carry over.
 *  - Student: status `inquiry` until the planned enrollment is started
 *    (Enrollment tab), cached in the chosen class so branch isolation holds.
 *  - Parents: the one picked on the application (`existingParentId`), else
 *    an existing parent with the same phone, else a new parent.
 *  - Documents: re-pointed from the application to the student, every
 *    version, so the student record starts with them.
 */
export async function convertApplication(
  ctx: TenantContext,
  tenantId: string,
  params: { applicationId: string; classId: string; studentNumber: string | null; startDate: string; actorId: string },
): Promise<ConvertResult> {
  const app = await ctx.applications.findOne({ _id: params.applicationId })
  if (!app) return { ok: false, error: 'NOT_FOUND' }
  if (app.status !== 'accepted') return { ok: false, error: 'NOT_ACCEPTED' }
  const klass = await ctx.classes.findOne({ _id: params.classId })
  if (!klass) return { ok: false, error: 'UNKNOWN_CLASS' }
  if (klass.branchId !== app.branchId) return { ok: false, error: 'CLASS_WRONG_BRANCH' }
  if (klass.academicYearId && klass.academicYearId !== app.academicYearId) {
    return { ok: false, error: 'CLASS_WRONG_YEAR' }
  }
  if (params.studentNumber && (await ctx.students.findOne({ studentNumber: params.studentNumber }))) {
    return { ok: false, error: 'STUDENT_NUMBER_TAKEN' }
  }

  const now = new Date()
  const studentId = randomUUID()
  const a = app.applicant
  const phones = app.guardians.map((g) => g.phone)
  const student: StudentDoc = {
    _id: studentId,
    tenantId,
    studentNumber: params.studentNumber ?? (await nextNumber(ctx, tenantId, 'studentNumber')),
    givenName: a.givenName,
    familyName: a.familyName,
    givenNameAr: a.givenNameAr,
    familyNameAr: a.familyNameAr,
    dob: a.dob,
    gender: a.gender,
    branchId: klass.branchId,
    classId: klass._id,
    academicYearId: app.academicYearId,
    studentGroup: `${klass.gradeLevel} ${klass.name}`.trim(),
    // Not enrolled yet: the planned place starts on the Enrollment tab.
    status: 'inquiry',
    admissionDate: params.startDate,
    address: null,
    medicalNotes: null,
    nationality: a.nationality,
    nationalId: a.nationalId,
    previousSchool: a.previousSchool,
    admissionSource: app.source,
    preferredName: null,
    emergencyContacts: [],
    stopId: '',
    transportMode: 'NONE',
    lat: null,
    lng: null,
    primaryPhone: phones[0] ?? '',
    secondaryPhone: phones[1] ?? '',
    createdAt: now,
    updatedAt: now,
  }
  await ctx.students.insertOne(student)

  const enrolled = await openEnrollment(ctx, tenantId, {
    studentId,
    classId: klass._id,
    startDate: params.startDate,
    pending: true,
    actorId: params.actorId,
  })
  if (!enrolled.ok) throw new ConvertAbort(enrolled.error)

  const parentIds: string[] = []
  for (const g of app.guardians) {
    let parent: ParentDoc | null = null
    if (g.existingParentId) {
      parent = await ctx.parents.findOne({ _id: g.existingParentId })
      if (!parent) throw new ConvertAbort('UNKNOWN_PARENT')
    } else {
      const key = digits(g.phone)
      const candidates = key ? await ctx.parents.find({ status: { $ne: 'archived' } }).toArray() : []
      parent = candidates.find((p) => digits(p.primaryPhone) === key) ?? null
    }
    if (!parent) {
      parent = {
        _id: randomUUID(),
        tenantId,
        fullName: g.fullName,
        fullNameAr: null,
        nationalId: null,
        primaryPhone: g.phone,
        alternativePhone: null,
        email: g.email,
        address: null,
        city: null,
        preferredContactMethod: 'phone',
        preferredLanguage: g.preferredLanguage,
        status: 'active',
        occupation: null,
        employer: null,
        emergencyContactName: null,
        emergencyContactPhone: null,
        notes: `From application ${app.applicationNumber}.`,
        portalAccess: { enabled: false, userId: null },
        createdAt: now,
        updatedAt: now,
        createdBy: params.actorId,
        archivedAt: null,
        archivedBy: null,
      }
      await ctx.parents.insertOne(parent)
    }
    parentIds.push(parent._id)
    await ctx.parentStudentLinks.insertOne({
      _id: randomUUID(),
      parentId: parent._id,
      studentId,
      relationshipType: g.relationship,
      primaryContact: g.primaryContact,
      secondaryContact: false,
      emergencyContact: g.primaryContact,
      authorizedPickup: false,
      financialResponsibility: false,
      communicationPermissions: { email: Boolean(g.email ?? parent.email), sms: false },
      portalAccess: false,
      active: true,
      createdAt: now,
      updatedAt: now,
      createdBy: params.actorId,
    })
  }

  const moved = await ctx.documents.updateMany(
    { ownerType: 'application', ownerId: app._id },
    { $set: { ownerType: 'student', ownerId: studentId, branchId: klass.branchId } },
  )

  await ctx.applications.findOneAndUpdate(
    { _id: app._id, status: 'accepted' },
    { $set: { status: 'converted', convertedStudentId: studentId, convertedAt: now, updatedAt: now } },
  )

  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'application.convert',
    entity: 'application',
    entityId: app._id,
    branchId: app.branchId,
    before: { status: 'accepted' },
    after: {
      status: 'converted',
      studentId,
      enrollmentId: enrolled.enrollment._id,
      parentIds,
      documentsMoved: moved.modifiedCount,
    },
  })
  return { ok: true, studentId, enrollmentId: enrolled.enrollment._id, parentIds }
}

/** Thrown to roll the conversion transaction back with a typed error. */
export class ConvertAbort extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
