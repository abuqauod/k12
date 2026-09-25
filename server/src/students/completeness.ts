import type { StudentDoc, TenantContext } from '../db.js'

/**
 * Record completeness (SAMS 2.2): which parts of a student's record are
 * still missing. Computed on read from the student, their family links and
 * their documents, never stored, so it can't go stale. Drives the "missing"
 * list on the student page, the roster filter and the dashboard's
 * incomplete-records count.
 *
 * Only enrolled students are checked: a withdrawn or graduated record is
 * history, not a task.
 */
export const COMPLETENESS_ITEMS = [
  'dob',
  'gender',
  'nationality',
  'nationalId',
  'address',
  'primaryPhone',
  'guardian',
  'emergencyContact',
  'birthCertificate',
  'photo',
] as const
export type CompletenessItem = (typeof COMPLETENESS_ITEMS)[number]

export interface Completeness {
  complete: boolean
  missing: CompletenessItem[]
}

const blank = (value: string | null | undefined) => !value || value.trim() === ''

/** Completeness for many students with two queries, not two per student. */
export async function computeCompleteness(
  ctx: TenantContext,
  students: StudentDoc[],
): Promise<Map<string, Completeness>> {
  const ids = students.map((s) => s._id)
  const result = new Map<string, Completeness>()
  if (ids.length === 0) return result

  const linked = new Set(
    (await ctx.parentStudentLinks.find({ studentId: { $in: ids }, active: true }).toArray()).map((l) => l.studentId),
  )
  // A rejected document doesn't count: it has to be uploaded again.
  const docs = await ctx.documents
    .find({
      ownerType: 'student',
      ownerId: { $in: ids },
      isCurrent: true,
      archivedAt: null,
      categoryCode: { $in: ['birth_certificate', 'photo'] },
      'verification.status': { $ne: 'rejected' },
    })
    .toArray()
  const has = new Set(docs.map((d) => `${d.ownerId}:${d.categoryCode}`))

  for (const s of students) {
    const missing: CompletenessItem[] = []
    if (blank(s.dob)) missing.push('dob')
    if (!s.gender) missing.push('gender')
    if (blank(s.nationality)) missing.push('nationality')
    if (blank(s.nationalId)) missing.push('nationalId')
    if (blank(s.address)) missing.push('address')
    if (blank(s.primaryPhone)) missing.push('primaryPhone')
    // An active parent link (SAMS 2.3 moved every guardian onto one).
    if (!linked.has(s._id)) missing.push('guardian')
    if ((s.emergencyContacts ?? []).length === 0) missing.push('emergencyContact')
    if (!has.has(`${s._id}:birth_certificate`)) missing.push('birthCertificate')
    if (!has.has(`${s._id}:photo`)) missing.push('photo')
    result.set(s._id, { complete: missing.length === 0, missing })
  }
  return result
}
