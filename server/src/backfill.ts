import { randomUUID } from 'node:crypto'
import type { Db } from 'mongodb'
import { DEFAULT_WORKING_DAYS } from './calendar.js'
import type {
  AcademicYearDoc,
  AttendanceRecordDoc,
  BranchDoc,
  EnrollmentDoc,
  Guardian,
  MembershipDoc,
  NotificationJobDoc,
  NotificationSettingsDoc,
  ParentDoc,
  ParentStudentLinkDoc,
  SchoolCalendarDoc,
  SchoolClassDoc,
  StudentDoc,
  TenantDoc,
} from './db.js'

/**
 * The one-time data backfills that new structural features need on existing
 * tenants. Each is idempotent — it only touches documents still missing the
 * new shape — so `migrate.ts` runs them every deploy and `seed.ts` runs
 * them after inserting its demo tenants, and neither double-applies.
 */

/** "Grade 4-A" -> { gradeLevel: "Grade 4", name: "A" }; a label with no
 * dash becomes its own grade with a placeholder section. */
function splitGroup(group: string): { gradeLevel: string; name: string } {
  const cut = group.lastIndexOf('-')
  if (cut > 0 && cut < group.length - 1) {
    return { gradeLevel: group.slice(0, cut).trim(), name: group.slice(cut + 1).trim() }
  }
  return { gradeLevel: group.trim(), name: '—' }
}

export async function backfillBranchesAndClasses(db: Db): Promise<void> {
  const now = new Date()
  const tenantsCol = db.collection<TenantDoc>('tenants')
  const branchesCol = db.collection<BranchDoc>('branches')
  const classesCol = db.collection<SchoolClassDoc>('classes')
  const studentsCol = db.collection<StudentDoc>('students')
  const attendanceCol = db.collection<AttendanceRecordDoc>('attendance')
  const membershipsCol = db.collection<MembershipDoc>('memberships')

  const tenants = await tenantsCol.find({}, { projection: { _id: 1 } }).toArray()

  // Memberships created before branches existed: an absent branchIds means
  // "all branches", same as an explicit null.
  await membershipsCol.updateMany(
    { branchIds: { $exists: false } },
    { $set: { branchIds: null } },
  )

  for (const tenant of tenants) {
    const tenantId = tenant._id

    let branch = await branchesCol.findOne({ tenantId })
    if (!branch) {
      branch = {
        _id: randomUUID(),
        tenantId,
        name: 'Main',
        code: 'main',
        address: null,
        timezone: 'Asia/Amman',
        active: true,
        createdAt: now,
        updatedAt: now,
      }
      await branchesCol.insertOne(branch)
    }
    const branchId = branch._id

    await studentsCol.updateMany(
      { tenantId, $or: [{ branchId: { $exists: false } }, { branchId: '' }] },
      { $set: { branchId } },
    )

    const groups = await studentsCol.distinct('studentGroup', { tenantId })
    for (const group of groups) {
      if (!group || typeof group !== 'string') continue
      const { gradeLevel, name } = splitGroup(group)

      let klass = await classesCol.findOne({ tenantId, branchId, gradeLevel, name })
      if (!klass) {
        klass = {
          _id: randomUUID(),
          tenantId,
          branchId,
          gradeLevel,
          name,
          capacity: 30,
          homeroomTeacherId: null,
          academicYearId: null,
          active: true,
          createdAt: now,
          updatedAt: now,
        }
        await classesCol.insertOne(klass)
      }

      await studentsCol.updateMany(
        { tenantId, studentGroup: group, $or: [{ classId: { $exists: false } }, { classId: '' }] },
        { $set: { classId: klass._id } },
      )
    }

    const orphaned = await attendanceCol
      .find({ tenantId, $or: [{ branchId: { $exists: false } }, { classId: { $exists: false } }] })
      .toArray()
    if (orphaned.length > 0) {
      const studentIds = [...new Set(orphaned.map((a) => a.studentId))]
      const students = await studentsCol
        .find({ tenantId, _id: { $in: studentIds } }, { projection: { branchId: 1, classId: 1 } })
        .toArray()
      const byId = new Map(students.map((s) => [s._id, s]))
      for (const row of orphaned) {
        const student = byId.get(row.studentId)
        if (!student) continue
        await attendanceCol.updateOne(
          { _id: row._id },
          { $set: { branchId: student.branchId ?? branchId, classId: student.classId ?? '' } },
        )
      }
    }
  }
}

/** The school year that contains today, Aug 1 – Jul 31. */
function currentSchoolYear(now: Date): { name: string; startDate: string; endDate: string } {
  const y = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
  return { name: `${y}–${y + 1}`, startDate: `${y}-08-01`, endDate: `${y + 1}-07-31` }
}

function guardianDefaults(g: Partial<Guardian> & { name: string }): Guardian {
  return {
    id: g.id ?? randomUUID(),
    name: g.name,
    relationship: g.relationship ?? 'guardian',
    phone: g.phone ?? '',
    secondaryPhone: g.secondaryPhone ?? null,
    email: g.email ?? null,
    isPrimary: g.isPrimary ?? false,
    preferredLanguage: g.preferredLanguage ?? 'en',
    notifyByEmail: g.notifyByEmail ?? true,
    notifyBySms: g.notifyBySms ?? false,
    active: g.active ?? true,
  }
}

export async function backfillEnrollmentModel(db: Db): Promise<void> {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const tenantsCol = db.collection<TenantDoc>('tenants')
  const yearsCol = db.collection<AcademicYearDoc>('academicYears')
  const studentsCol = db.collection<StudentDoc>('students')
  const enrollmentsCol = db.collection<EnrollmentDoc>('enrollments')
  const branchesCol = db.collection<BranchDoc>('branches')
  const calendarsCol = db.collection<SchoolCalendarDoc>('schoolCalendars')
  const settingsCol = db.collection<NotificationSettingsDoc>('notificationSettings')
  const attendanceCol = db.collection<AttendanceRecordDoc>('attendance')
  const jobsCol = db.collection<NotificationJobDoc>('notificationJobs')
  const legacyLog = db.collection('notificationLog')

  const tenants = await tenantsCol.find({}, { projection: { _id: 1 } }).toArray()

  for (const tenant of tenants) {
    const tenantId = tenant._id

    // 1. A current academic year — attendance and enrollments file against it.
    let currentYear = await yearsCol.findOne({ tenantId, current: true })
    if (!currentYear) {
      const sy = currentSchoolYear(now)
      currentYear = {
        _id: randomUUID(),
        tenantId,
        name: sy.name,
        startDate: sy.startDate,
        endDate: sy.endDate,
        terms: [],
        current: true,
        createdAt: now,
      }
      await yearsCol.insertOne(currentYear)
    }
    const yearId = currentYear._id

    // 2. Students carry the year as a cache field.
    await studentsCol.updateMany(
      { tenantId, $or: [{ academicYearId: { $exists: false } }, { academicYearId: '' }] },
      { $set: { academicYearId: yearId } },
    )

    // 3. One enrollment per student with no enrollment row yet. Enrolled ->
    //    ACTIVE; withdrawn/graduated -> a closed row so history is not empty;
    //    inquiry / class-less -> skipped.
    const students = await studentsCol.find({ tenantId }).toArray()
    for (const student of students) {
      const classId = (student as { classId?: string }).classId
      if (!classId) continue
      const has = await enrollmentsCol.findOne({ tenantId, studentId: student._id })
      if (has) continue

      const status = (student as { status?: string }).status ?? 'enrolled'
      if (status === 'inquiry') continue
      const enrollment: EnrollmentDoc = {
        _id: randomUUID(),
        tenantId,
        studentId: student._id,
        branchId: (student as { branchId?: string }).branchId ?? '',
        classId,
        academicYearId: (student as { academicYearId?: string }).academicYearId ?? yearId,
        startDate:
          (student as { admissionDate?: string | null }).admissionDate ??
          currentYear.startDate ??
          today,
        endDate: status === 'enrolled' ? null : today,
        status: status === 'graduated' ? 'graduated' : status === 'withdrawn' ? 'withdrawn' : 'active',
        supersededBy: null,
        reason: null,
        createdAt: now,
        createdBy: null,
        updatedAt: now,
      }
      await enrollmentsCol.insertOne(enrollment)
    }

    // 4. Guardian shape.
    const needGuardians = await studentsCol
      .find({ tenantId, guardians: { $elemMatch: { id: { $exists: false } } } })
      .toArray()
    for (const student of needGuardians) {
      const guardians = (student.guardians ?? []).map((g) => guardianDefaults(g as Guardian))
      await studentsCol.updateOne({ _id: student._id }, { $set: { guardians } })
    }

    // 5. A school calendar per branch, seeded from the deprecated
    //    notificationSettings.schoolDays where one exists.
    const branches = await branchesCol.find({ tenantId }).toArray()
    for (const branch of branches) {
      const calId = `${tenantId}:${branch._id}`
      if (await calendarsCol.findOne({ _id: calId })) continue
      const settings = await settingsCol.findOne({ _id: calId })
      const workingDays =
        (settings as { schoolDays?: number[] } | null)?.schoolDays ?? DEFAULT_WORKING_DAYS
      await calendarsCol.insertOne({
        _id: calId,
        tenantId,
        branchId: branch._id,
        workingDays,
        holidays: [],
        updatedAt: now,
      })
    }

    // 6. Attendance rows get the academic year, active enrollment id and the
    //    correction stamps.
    const activeByStudent = new Map(
      (await enrollmentsCol.find({ tenantId, status: 'active' }).toArray()).map((e) => [
        e.studentId,
        e,
      ]),
    )
    const attendanceToFix = await attendanceCol
      .find({
        tenantId,
        $or: [{ academicYearId: { $exists: false } }, { enrollmentId: { $exists: false } }],
      })
      .toArray()
    for (const row of attendanceToFix) {
      const enrollment = activeByStudent.get(row.studentId)
      await attendanceCol.updateOne(
        { _id: row._id },
        {
          $set: {
            academicYearId: (row as { academicYearId?: string }).academicYearId ?? yearId,
            enrollmentId: enrollment?._id ?? '',
            updatedBy: null,
            updatedAt: null,
          },
        },
      )
    }

    // 7. Move legacy notificationLog rows into the job queue as terminal
    //    history (nothing reads notificationLog any more).
    const legacyRows = await legacyLog.find({ tenantId }).toArray()
    for (const row of legacyRows) {
      const legacyId = `${String(row._id)}:legacy`
      if (await jobsCol.findOne({ _id: legacyId })) continue
      const status = row.status === 'sent' ? 'sent' : row.status === 'skipped' ? 'skipped' : 'dead'
      await jobsCol.insertOne({
        _id: legacyId,
        tenantId,
        branchId: String(row.branchId ?? ''),
        studentId: String(row.studentId ?? ''),
        guardianId: 'legacy',
        date: String(row.date ?? ''),
        channel: row.channel === 'sms' ? 'sms' : 'email',
        to: String(row.to ?? ''),
        guardianName: String(row.guardianName ?? ''),
        language: 'en',
        subject: '',
        body: '',
        status,
        attempts: 1,
        maxAttempts: 3,
        nextAttemptAt: null,
        lastError: row.error ? String(row.error) : null,
        providerMessageId: null,
        trigger: row.trigger === 'manual' ? 'manual' : 'auto',
        actorId: row.actorId ? String(row.actorId) : null,
        createdAt: row.createdAt instanceof Date ? row.createdAt : now,
        updatedAt: now,
      })
    }
  }
}

/** A phone's matching key: its last nine digits, so "+962 79 555 6666",
 * "00962795556666" and "0795556666" are the same number (a Jordanian
 * mobile is nine digits after the country code or trunk 0). Shorter
 * numbers compare on all their digits. */
function normalizePhoneDigits(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '')
  return digits.length > 9 ? digits.slice(-9) : digits.replace(/^0+/, '')
}

/**
 * SAMS 2.3: moves every student's embedded `guardians[]` onto the Parent
 * Management model (ParentDoc + ParentStudentLinkDoc, see db.ts) and
 * retires the embedded list. Runs from migrate.ts on every deploy and is
 * idempotent: a student is handled once, then its list is renamed to
 * `legacyGuardians` (kept as history, never read), so a rerun finds nothing.
 *
 * For each guardian:
 *  - Parent: the one an earlier run of this backfill linked it to (link id
 *    `…:bf:<student>:<guardian>`), else a match on normalized phone, else
 *    on exact name, else a new parent. The guardian's language is copied to
 *    a parent that has none yet.
 *  - Link: a link this backfill created before is brought up to date with
 *    the guardian's current flags. Until now the guardian was what absence
 *    notifications read, so its opt-ins are the live ones. A link a person
 *    created or edited by hand in Parents is left exactly as it is. With no
 *    link for the pair, one is created.
 *
 * Dedup is a best-effort heuristic, not a guarantee: `Guardian` carries no
 * national ID to key on. Two different people sharing a household phone
 * are merged into one parent; spot-check real tenant data after the
 * migration and split any by hand. An over-merged parent is easier to
 * notice and fix than a silently duplicated one.
 */
export async function retireEmbeddedGuardians(db: Db): Promise<{ students: number; links: number; parents: number }> {
  const now = new Date()
  const tenantsCol = db.collection<TenantDoc>('tenants')
  const studentsCol = db.collection<StudentDoc>('students')
  const parentsCol = db.collection<ParentDoc>('parents')
  const linksCol = db.collection<ParentStudentLinkDoc>('parentStudentLinks')
  const counts = { students: 0, links: 0, parents: 0 }

  const tenants = await tenantsCol.find({}, { projection: { _id: 1 } }).toArray()

  for (const tenant of tenants) {
    const tenantId = tenant._id
    const students = await studentsCol.find({ tenantId, guardians: { $exists: true } }).toArray()
    if (students.length === 0) continue

    const existingParents = await parentsCol.find({ tenantId }).toArray()
    const byId = new Map(existingParents.map((p) => [p._id, p]))
    const byPhone = new Map<string, ParentDoc>()
    const byName = new Map<string, ParentDoc>()
    for (const p of existingParents) {
      const digits = normalizePhoneDigits(p.primaryPhone)
      if (digits) byPhone.set(digits, p)
      byName.set(p.fullName.trim().toLowerCase(), p)
    }

    for (const student of students) {
      for (const guardian of student.guardians ?? []) {
        if (!guardian?.name) continue
        const backfillId = `${tenantId}:bf:${student._id}:${guardian.id}`
        const earlier = await linksCol.findOne({ _id: backfillId })

        const digits = normalizePhoneDigits(guardian.phone ?? '')
        let parent =
          (earlier && byId.get(earlier.parentId)) ||
          (digits && byPhone.get(digits)) ||
          byName.get(guardian.name.trim().toLowerCase())

        if (!parent) {
          parent = {
            _id: randomUUID(),
            tenantId,
            fullName: guardian.name,
            fullNameAr: null,
            nationalId: null,
            primaryPhone: guardian.phone ?? '',
            alternativePhone: guardian.secondaryPhone ?? null,
            email: guardian.email ?? null,
            address: null,
            city: null,
            preferredContactMethod: 'phone',
            preferredLanguage: guardian.preferredLanguage ?? 'en',
            status: guardian.active === false ? 'inactive' : 'active',
            occupation: null,
            employer: null,
            emergencyContactName: null,
            emergencyContactPhone: null,
            notes: 'Created from a student guardian record.',
            portalAccess: { enabled: false, userId: null },
            createdAt: now,
            updatedAt: now,
            createdBy: null,
            archivedAt: null,
            archivedBy: null,
          }
          await parentsCol.insertOne(parent)
          counts.parents++
          byId.set(parent._id, parent)
          if (digits) byPhone.set(digits, parent)
          byName.set(parent.fullName.trim().toLowerCase(), parent)
        } else if (!parent.preferredLanguage && guardian.preferredLanguage) {
          await parentsCol.updateOne({ _id: parent._id }, { $set: { preferredLanguage: guardian.preferredLanguage } })
          parent.preferredLanguage = guardian.preferredLanguage
        }

        const fromGuardian = {
          relationshipType: guardian.relationship || 'guardian',
          primaryContact: guardian.isPrimary ?? false,
          communicationPermissions: { email: guardian.notifyByEmail ?? true, sms: guardian.notifyBySms ?? false },
          active: guardian.active !== false,
        }
        const pair = await linksCol.findOne({ tenantId, parentId: parent._id, studentId: student._id })
        if (pair) {
          // Only a link this backfill made follows the guardian; a
          // hand-made one is the school's own record and wins.
          if (pair._id === backfillId) {
            await linksCol.updateOne({ _id: pair._id }, { $set: { ...fromGuardian, updatedAt: now } })
          }
          continue
        }
        await linksCol.insertOne({
          _id: backfillId,
          tenantId,
          parentId: parent._id,
          studentId: student._id,
          ...fromGuardian,
          secondaryContact: false,
          emergencyContact: false,
          authorizedPickup: false,
          financialResponsibility: false,
          portalAccess: false,
          createdAt: now,
          updatedAt: now,
          createdBy: null,
        })
        counts.links++
      }
      // Done with this student: freeze the list as history.
      await studentsCol.updateOne({ _id: student._id }, { $rename: { guardians: 'legacyGuardians' } })
      counts.students++
    }
  }
  return counts
}
