import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import type { Db } from 'mongodb'
import { config } from './config.js'
import { ensureIndexes } from './schema.js'
import type {
  AttendanceRecordDoc,
  BranchDoc,
  MembershipDoc,
  SchoolClassDoc,
  StudentDoc,
  TenantDoc,
} from './db.js'

/**
 * Creates every index the app needs, then runs the one-time data backfills
 * that new structural features need on existing tenants. Mongo has no schema
 * to migrate, so index creation is safe every deploy; the backfills below
 * are each written to be idempotent (they only touch documents still
 * missing the new shape), so re-running this is a no-op once it has caught
 * up.
 */
async function main(): Promise<void> {
  const client = new MongoClient(config.databaseUrl)
  await client.connect()
  const db = client.db()

  console.log(`Ensuring indexes on ${db.databaseName}...`)
  await ensureIndexes(db)
  console.log('  done')

  console.log('Backfilling branches and classes...')
  await backfillBranchesAndClasses(db)
  console.log('  done')

  await client.close()
}

/** "Grade 4-A" -> { gradeLevel: "Grade 4", name: "A" }; a label with no
 * dash becomes its own grade with a placeholder section. */
function splitGroup(group: string): { gradeLevel: string; name: string } {
  const cut = group.lastIndexOf('-')
  if (cut > 0 && cut < group.length - 1) {
    return { gradeLevel: group.slice(0, cut).trim(), name: group.slice(cut + 1).trim() }
  }
  return { gradeLevel: group.trim(), name: '—' }
}

async function backfillBranchesAndClasses(db: Db): Promise<void> {
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

    // 1. Ensure a branch. The first one created is the tenant's "Main".
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

    // 2. Every student in this tenant gets a branch.
    await studentsCol.updateMany(
      { tenantId, $or: [{ branchId: { $exists: false } }, { branchId: '' }] },
      { $set: { branchId } },
    )

    // 3. One class per distinct studentGroup, then point students at it.
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

    // 4. Attendance rows from before the denormalised branchId/classId
    //    existed: fill them from their student.
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

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
