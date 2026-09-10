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
