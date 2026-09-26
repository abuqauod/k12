import type { AnnouncementDoc, TenantContext } from '../db.js'
import { notifyFamilies, schoolName, type Delivered } from '../notifications/messages.js'
import { DEFAULT_TEMPLATES } from '../notifications/templates.js'

/**
 * SAMS 6.2: announcements to families, by school, branch, grade, class or
 * bus. Publishing works out the audience once — the enrolled students it
 * covers — and keeps it on the announcement, so the portal shows it to
 * exactly the families it went to.
 */

/** The enrolled students an audience covers. */
export async function audienceStudents(ctx: TenantContext, audience: AnnouncementDoc['audience']): Promise<string[]> {
  const filter: Record<string, unknown> = { status: 'enrolled' }
  if (audience.type !== 'school') filter.branchId = audience.branchId
  if (audience.type === 'grade') {
    const classes = await ctx.classes
      .find({ branchId: audience.branchId!, gradeLevel: { $in: audience.gradeLevels } })
      .toArray()
    filter.classId = { $in: classes.map((c) => c._id) }
  }
  if (audience.type === 'class') filter.classId = { $in: audience.classIds }
  if (audience.type === 'bus') {
    const stops = await ctx.stops
      .find({ branchId: audience.branchId!, pinnedBusId: { $in: audience.busIds }, active: true })
      .toArray()
    filter.stopId = { $in: stops.map((s) => s._id) }
  }
  const students = await ctx.students.find(filter).toArray()
  return students.map((s) => s._id)
}

/** Checks an audience's references belong to its branch. Null when fine. */
export async function audienceError(ctx: TenantContext, audience: AnnouncementDoc['audience']): Promise<string | null> {
  if (audience.type === 'school') return null
  if (!audience.branchId) return 'BRANCH_REQUIRED'
  if (!(await ctx.branches.findOne({ _id: audience.branchId }))) return 'UNKNOWN_BRANCH'
  if (audience.type === 'grade' && audience.gradeLevels.length === 0) return 'AUDIENCE_EMPTY'
  if (audience.type === 'class') {
    if (audience.classIds.length === 0) return 'AUDIENCE_EMPTY'
    const found = await ctx.classes.countDocuments({ _id: { $in: audience.classIds }, branchId: audience.branchId })
    if (found !== new Set(audience.classIds).size) return 'UNKNOWN_CLASS'
  }
  if (audience.type === 'bus') {
    if (audience.busIds.length === 0) return 'AUDIENCE_EMPTY'
    const found = await ctx.buses.countDocuments({ _id: { $in: audience.busIds }, branchId: audience.branchId })
    if (found !== new Set(audience.busIds).size) return 'UNKNOWN_BUS'
  }
  return null
}

/** Sends a published announcement: in-app to portal parents, and email /
 * SMS on the channels it names to parents who opted in. */
export async function deliverAnnouncement(
  ctx: TenantContext,
  tenantId: string,
  doc: AnnouncementDoc,
  actorId: string,
): Promise<Delivered> {
  const school = await schoolName(tenantId)
  const base = DEFAULT_TEMPLATES.announcement
  return notifyFamilies(ctx, tenantId, {
    kind: 'announcement',
    sourceId: doc._id,
    studentIds: doc.studentIds,
    recipients: 'all',
    channels: doc.channels,
    perParent: true,
    // The school's own words: the saved template's wrapper doesn't apply.
    text: { ...base, enabled: true },
    tokens: (_student, parent) => {
      const ar = parent.preferredLanguage === 'ar'
      return {
        title: (ar && doc.titleAr) || doc.title,
        body: (ar && doc.bodyAr) || doc.body,
        schoolName: school,
      }
    },
    link: () => '/portal?tab=announcements',
    trigger: 'manual',
    actorId,
  })
}
