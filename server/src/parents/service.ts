import { randomUUID } from 'node:crypto'
import type { ParentStudentLinkDoc, TenantContext } from '../db.js'
import { recordAudit } from '../audit.js'
import { computeStudentBalances } from '../finance/service.js'

/**
 * Parent/guardian records and their many-to-many relationship to students.
 * `ParentDoc` and `ParentStudentLinkDoc` are the real, normalized Parent
 * Management model — distinct from the embedded `Guardian[]` on
 * `StudentDoc`, which continues to drive absence notifications unchanged
 * (see db.ts's parents section for the full reasoning).
 *
 * Every function takes a live `TenantContext` (a `withTenant` transaction),
 * matching the convention in enrollments/service.ts.
 */

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, '')
}

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
  /** Minor units — see finance/service.ts's `computeStudentBalances`, the
   * one place this is computed. Zero for a student with no invoices, not
   * an absence of data. */
  invoicedTotal: number
  paidTotal: number
  outstandingBalance: number
}

/** Age in whole years as of today, from an ISO yyyy-mm-dd dob. */
function ageFrom(dob: string | null): number | null {
  if (!dob) return null
  const birth = new Date(dob)
  if (Number.isNaN(birth.getTime())) return null
  const now = new Date()
  let age = now.getUTCFullYear() - birth.getUTCFullYear()
  const monthDiff = now.getUTCMonth() - birth.getUTCMonth()
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birth.getUTCDate())) age--
  return age
}

/**
 * The "no duplication, always live" guarantee: this reads students,
 * enrollments, classes, branches and academic years fresh on every call and
 * never writes any of it back to `parents`/`parentStudentLinks`. Composed
 * server-side (manual multi-query, matching classes/routes.ts's style —
 * this codebase's TenantScope has no aggregate()) rather than trusting every
 * frontend caller to join correctly.
 */
export async function composeLinkedStudents(
  ctx: TenantContext,
  parentId: string,
): Promise<LinkedStudentSummary[]> {
  const links = await ctx.parentStudentLinks.find({ parentId }).toArray()
  if (links.length === 0) return []

  const studentIds = links.map((l) => l.studentId)
  const students = await ctx.students.find({ _id: { $in: studentIds } }).toArray()
  const studentById = new Map(students.map((s) => [s._id, s]))

  const enrollments = await ctx.enrollments
    .find({ studentId: { $in: studentIds }, status: 'active' })
    .toArray()
  const activeEnrollmentByStudent = new Map(enrollments.map((e) => [e.studentId, e]))

  const branchIds = [...new Set(students.map((s) => s.branchId).filter(Boolean))]
  const classIds = [...new Set(students.map((s) => s.classId).filter(Boolean))]
  const yearIds = [...new Set(students.map((s) => s.academicYearId).filter(Boolean))]

  const [branches, classes, years] = await Promise.all([
    branchIds.length > 0 ? ctx.branches.find({ _id: { $in: branchIds } }).toArray() : [],
    classIds.length > 0 ? ctx.classes.find({ _id: { $in: classIds } }).toArray() : [],
    yearIds.length > 0 ? ctx.academicYears.find({ _id: { $in: yearIds } }).toArray() : [],
  ])
  const branchById = new Map(branches.map((b) => [b._id, b]))
  const classById = new Map(classes.map((c) => [c._id, c]))
  const yearById = new Map(years.map((y) => [y._id, y]))
  const balances = await computeStudentBalances(ctx, studentIds)

  const rows: LinkedStudentSummary[] = []
  for (const link of links) {
    const student = studentById.get(link.studentId)
    if (!student) continue // a link may outlive a deleted student; skip rather than 500
    const activeEnrollment = activeEnrollmentByStudent.get(student._id) ?? null
    const klass = student.classId ? classById.get(student.classId) : undefined
    const balance = balances.get(student._id)

    rows.push({
      linkId: link._id,
      studentId: student._id,
      studentNumber: student.studentNumber,
      givenName: student.givenName,
      familyName: student.familyName,
      dob: student.dob,
      age: ageFrom(student.dob),
      gender: student.gender,
      branchId: student.branchId || null,
      branchName: student.branchId ? (branchById.get(student.branchId)?.name ?? null) : null,
      academicYearId: student.academicYearId || null,
      academicYearName: student.academicYearId
        ? (yearById.get(student.academicYearId)?.name ?? null)
        : null,
      classId: student.classId || null,
      classLabel: klass ? `${klass.gradeLevel} ${klass.name}`.trim() : (student.studentGroup || null),
      enrollmentStatus: activeEnrollment?.status ?? null,
      enrollmentStartDate: activeEnrollment?.startDate ?? null,
      studentStatus: student.status,
      stopId: student.stopId,
      transportMode: student.transportMode,
      lat: student.lat,
      lng: student.lng,
      relationshipType: link.relationshipType,
      primaryContact: link.primaryContact,
      secondaryContact: link.secondaryContact,
      emergencyContact: link.emergencyContact,
      authorizedPickup: link.authorizedPickup,
      financialResponsibility: link.financialResponsibility,
      communicationPermissions: link.communicationPermissions,
      portalAccess: link.portalAccess,
      linkActive: link.active,
      invoicedTotal: balance?.invoicedTotal ?? 0,
      paidTotal: balance?.paidTotal ?? 0,
      outstandingBalance: balance?.outstandingBalance ?? 0,
    })
  }
  return rows
}

/** How many active students each parent in `parentIds` is linked to — one
 * grouped query, same idiom as classes/routes.ts's enrolled-count map. */
export async function linkedStudentCounts(
  ctx: TenantContext,
  parentIds: string[],
  /** Count only children in these branches (SAMS 1.9); null = all. */
  allowedBranchIds: string[] | null = null,
): Promise<Map<string, number>> {
  if (parentIds.length === 0) return new Map()
  let links = await ctx.parentStudentLinks
    .find({ parentId: { $in: parentIds }, active: true })
    .toArray()
  if (allowedBranchIds !== null && links.length > 0) {
    const inBranch = new Set(
      (
        await ctx.students
          .find({ _id: { $in: links.map((l) => l.studentId) }, branchId: { $in: allowedBranchIds } })
          .toArray()
      ).map((s) => s._id),
    )
    links = links.filter((l) => inBranch.has(l.studentId))
  }
  const counts = new Map<string, number>()
  for (const link of links) counts.set(link.parentId, (counts.get(link.parentId) ?? 0) + 1)
  return counts
}

export interface DuplicateCandidate {
  id: string
  fullName: string
  primaryPhone: string
  email: string | null
  nationalId: string | null
  matchedOn: Array<'nationalId' | 'primaryPhone' | 'alternativePhone' | 'email'>
  /** Set when the match belongs to another branch's family (SAMS 1.9):
   * personal fields are blanked, only the fact of a match is shown. */
  restricted?: boolean
}

/**
 * Soft duplicate detection for requirement 7 — used by both create and
 * update to produce a WARNING (never a block). Matches on national ID,
 * either phone field (digits-only comparison), or email.
 */
export async function findDuplicateCandidates(
  ctx: TenantContext,
  probe: { nationalId?: string | null; primaryPhone?: string | null; email?: string | null },
  excludeId?: string,
): Promise<DuplicateCandidate[]> {
  const clauses: Record<string, unknown>[] = []
  if (probe.nationalId) clauses.push({ nationalId: probe.nationalId })
  if (probe.primaryPhone) {
    const digits = normalizePhone(probe.primaryPhone)
    if (digits) {
      clauses.push({ primaryPhone: { $regex: `${digits}$` } })
      clauses.push({ alternativePhone: { $regex: `${digits}$` } })
    }
  }
  if (probe.email) clauses.push({ email: probe.email.toLowerCase() })
  if (clauses.length === 0) return []

  const candidates = await ctx.parents.find({ $or: clauses }).toArray()
  const digits = probe.primaryPhone ? normalizePhone(probe.primaryPhone) : ''

  return candidates
    .filter((c) => c._id !== excludeId)
    .map((c) => {
      const matchedOn: DuplicateCandidate['matchedOn'] = []
      if (probe.nationalId && c.nationalId === probe.nationalId) matchedOn.push('nationalId')
      if (digits && normalizePhone(c.primaryPhone) === digits) matchedOn.push('primaryPhone')
      if (digits && c.alternativePhone && normalizePhone(c.alternativePhone) === digits) {
        matchedOn.push('alternativePhone')
      }
      if (probe.email && c.email === probe.email.toLowerCase()) matchedOn.push('email')
      return {
        id: c._id,
        fullName: c.fullName,
        primaryPhone: c.primaryPhone,
        email: c.email,
        nationalId: c.nationalId,
        matchedOn,
      }
    })
    .filter((c) => c.matchedOn.length > 0)
}

export type CreateLinkResult =
  | { ok: true; link: ParentStudentLinkDoc; reactivated: boolean }
  | { ok: false; error: 'UNKNOWN_PARENT' | 'UNKNOWN_STUDENT' | 'LINK_EXISTS' }

/**
 * Creates the parent<->student relationship — or, if one already exists but
 * was previously deactivated (see deactivateLink below), reactivates it with
 * the newly submitted field values instead of erroring. A removed
 * relationship being re-added is the same relationship coming back, not a
 * new one, and the unique (tenantId, parentId, studentId) index means there
 * is only ever one row for the pair to reactivate — restoring it, rather
 * than requiring a separate "find the old inactive link and reactivate it"
 * step the UI has no surface for. Only a genuinely still-active duplicate
 * (`LINK_EXISTS`) is rejected — that is the real duplicate-relationship
 * prevention requirement 7 asks for.
 */
export async function createLink(
  ctx: TenantContext,
  tenantId: string,
  params: {
    parentId: string
    studentId: string
    relationshipType: string
    primaryContact: boolean
    secondaryContact: boolean
    emergencyContact: boolean
    authorizedPickup: boolean
    financialResponsibility: boolean
    communicationPermissions: { email: boolean; sms: boolean }
    portalAccess: boolean
    actorId: string | null
  },
): Promise<CreateLinkResult> {
  const parent = await ctx.parents.findOne({ _id: params.parentId })
  if (!parent) return { ok: false, error: 'UNKNOWN_PARENT' }
  const student = await ctx.students.findOne({ _id: params.studentId })
  if (!student) return { ok: false, error: 'UNKNOWN_STUDENT' }

  const now = new Date()
  const existing = await ctx.parentStudentLinks.findOne({
    parentId: params.parentId,
    studentId: params.studentId,
  })

  if (existing) {
    if (existing.active) return { ok: false, error: 'LINK_EXISTS' }
    const reactivated = await ctx.parentStudentLinks.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          relationshipType: params.relationshipType,
          primaryContact: params.primaryContact,
          secondaryContact: params.secondaryContact,
          emergencyContact: params.emergencyContact,
          authorizedPickup: params.authorizedPickup,
          financialResponsibility: params.financialResponsibility,
          communicationPermissions: params.communicationPermissions,
          portalAccess: params.portalAccess,
          active: true,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    )
    await recordAudit(ctx.auditLog, {
      actorId: params.actorId,
      action: 'parentStudentLink.reactivate',
      entity: 'parentStudentLink',
      entityId: existing._id,
      branchId: student.branchId,
      before: existing,
      after: reactivated,
    })
    return { ok: true, link: reactivated!, reactivated: true }
  }

  const link: ParentStudentLinkDoc = {
    _id: randomUUID(),
    tenantId,
    parentId: params.parentId,
    studentId: params.studentId,
    relationshipType: params.relationshipType,
    primaryContact: params.primaryContact,
    secondaryContact: params.secondaryContact,
    emergencyContact: params.emergencyContact,
    authorizedPickup: params.authorizedPickup,
    financialResponsibility: params.financialResponsibility,
    communicationPermissions: params.communicationPermissions,
    portalAccess: params.portalAccess,
    active: true,
    createdAt: now,
    updatedAt: now,
    createdBy: params.actorId,
  }
  try {
    await ctx.parentStudentLinks.insertOne(link)
  } catch (error) {
    // The findOne above is not atomic with this insert — two concurrent
    // createLink calls for the same (parentId, studentId) can both pass it
    // and race for the unique index. The loser gets this, not a 500.
    if (isDuplicateKeyError(error)) return { ok: false, error: 'LINK_EXISTS' }
    throw error
  }
  await recordAudit(ctx.auditLog, {
    actorId: params.actorId,
    action: 'parentStudentLink.create',
    entity: 'parentStudentLink',
    entityId: link._id,
    branchId: student.branchId,
    before: null,
    after: link,
  })
  return { ok: true, link, reactivated: false }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000
}

// ------------------------------------------------------ branch visibility --
//
// SAMS 1.9. `ParentDoc` has no branch of its own — a family belongs to
// branches only through its children. A caller confined to some branches
// therefore sees a parent when:
//  - the parent is linked (now or formerly) to a student in one of those
//    branches, or
//  - the parent has never been linked at all — an intake record not yet
//    attached to any family (otherwise the receptionist who just created it
//    could not find it to link the child).
// Derived from links every time, never copied onto the parent.

/** Parent ids a branch-confined caller must not see. */
export async function parentsHiddenFromBranches(
  ctx: TenantContext,
  allowedBranchIds: string[],
): Promise<Set<string>> {
  // Deactivated links count too: a family whose child left must not turn
  // into an unlinked intake record visible to every branch.
  const links = await ctx.parentStudentLinks.find({}).toArray()
  if (links.length === 0) return new Set()
  const studentIds = [...new Set(links.map((l) => l.studentId))]
  const inBranch = new Set(
    (await ctx.students.find({ _id: { $in: studentIds }, branchId: { $in: allowedBranchIds } }).toArray()).map(
      (s) => s._id,
    ),
  )
  const visible = new Set(links.filter((l) => inBranch.has(l.studentId)).map((l) => l.parentId))
  return new Set(links.map((l) => l.parentId).filter((id) => !visible.has(id)))
}

/** Single-parent form of `parentsHiddenFromBranches`. */
export async function parentHiddenFromBranches(
  ctx: TenantContext,
  parentId: string,
  allowedBranchIds: string[],
): Promise<boolean> {
  const links = await ctx.parentStudentLinks.find({ parentId }).toArray()
  if (links.length === 0) return false
  const inBranch = await ctx.students.countDocuments({
    _id: { $in: links.map((l) => l.studentId) },
    branchId: { $in: allowedBranchIds },
  })
  return inBranch === 0
}
