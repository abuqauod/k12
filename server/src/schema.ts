import type { Db } from 'mongodb'

/**
 * MongoDB has no schema to migrate — this creates the indexes the app
 * depends on. `createIndex` is idempotent (re-running is a no-op), so this
 * is safe to run every deploy, unlike the old .sql migrations it replaces.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection('tenants').createIndex({ slug: 1 }, { unique: true })

  await db.collection('users').createIndex({ email: 1 }, { unique: true })

  await db.collection('memberships').createIndex({ userId: 1 })
  await db.collection('memberships').createIndex({ tenantId: 1, userId: 1 }, { unique: true })

  await db.collection('refreshTokens').createIndex({ tokenHash: 1 }, { unique: true })
  await db.collection('refreshTokens').createIndex({ userId: 1 })
  // Atlas free tier caps storage, not TTL indexes — this lets expired,
  // already-useless refresh tokens age out on their own.
  await db.collection('refreshTokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })

  // `datasets` and `datasetVersions` are looked up by _id (which already
  // encodes tenantId+key, and tenantId+key+revision) for the hot paths, so
  // those don't need a secondary index. This one serves the version-history
  // listing, which sorts by revision within a (tenant, key).
  await db.collection('datasetVersions').createIndex({ tenantId: 1, key: 1, revision: -1 })

  await db.collection('auditLog').createIndex({ tenantId: 1, createdAt: -1 })

  await db.collection('apiKeys').createIndex({ keyHash: 1 }, { unique: true })
  await db.collection('apiKeys').createIndex({ tenantId: 1 })

  await db.collection('actionTokens').createIndex({ tokenHash: 1 }, { unique: true })
  await db.collection('actionTokens').createIndex({ userId: 1 })
  // Same self-cleaning reasoning as refreshTokens: an expired invite or
  // password-reset link is useless the moment it expires.
  await db.collection('actionTokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })

  // Rolling window for login rate limiting — expires whether or not the
  // account ever got locked, so a quiet account carries no history.
  await db.collection('loginAttempts').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })

  await db.collection('students').createIndex({ tenantId: 1, studentNumber: 1 }, { unique: true })
  await db.collection('students').createIndex({ tenantId: 1, studentGroup: 1 })
  await db.collection('students').createIndex({ tenantId: 1, status: 1 })

  await db.collection('academicYears').createIndex({ tenantId: 1, current: 1 })

  // The real query patterns: a class's whole register for one day, one
  // student's history over a range, and the required
  // tenant+branch+class+student+date access path. The unique index is
  // belt-and-braces on top of the deterministic `_id` — a second daily row
  // for a student is rejected by the database, not just by convention.
  await db.collection('attendance').createIndex({ tenantId: 1, date: 1 })
  await db.collection('attendance').createIndex({ tenantId: 1, studentId: 1, date: -1 })
  await db.collection('attendance').createIndex({ tenantId: 1, classId: 1, date: 1 })
  await db
    .collection('attendance')
    .createIndex({ tenantId: 1, branchId: 1, classId: 1, studentId: 1, date: 1 })
  await db
    .collection('attendance')
    .createIndex({ tenantId: 1, studentId: 1, date: 1 }, { unique: true })
  await db.collection('attendance').createIndex({ tenantId: 1, academicYearId: 1, date: 1 })
  await db.collection('attendanceCorrections').createIndex({ tenantId: 1, attendanceId: 1, changedAt: -1 })
  await db.collection('attendanceCorrections').createIndex({ tenantId: 1, studentId: 1, changedAt: -1 })

  await db.collection('branches').createIndex({ tenantId: 1, code: 1 }, { unique: true })
  await db.collection('branches').createIndex({ tenantId: 1 })

  await db
    .collection('classes')
    .createIndex({ tenantId: 1, branchId: 1, gradeLevel: 1, name: 1 }, { unique: true })
  await db.collection('classes').createIndex({ tenantId: 1, branchId: 1 })

  await db.collection('students').createIndex({ tenantId: 1, branchId: 1, classId: 1 })

  // Enrollment: at most one ACTIVE row per (tenant, student) — a partial
  // unique index makes a second concurrent transfer impossible rather than
  // merely unlikely. Plus the history and roster read paths.
  await db
    .collection('enrollments')
    .createIndex(
      { tenantId: 1, studentId: 1 },
      { unique: true, partialFilterExpression: { status: 'active' } },
    )
  await db.collection('enrollments').createIndex({ tenantId: 1, studentId: 1, startDate: -1 })
  await db.collection('enrollments').createIndex({ tenantId: 1, classId: 1, status: 1 })
  await db.collection('enrollments').createIndex({ tenantId: 1, branchId: 1, academicYearId: 1, status: 1 })

  // The sweep scans this cross-tenant for "enabled and not yet swept today".
  await db.collection('notificationSettings').createIndex({ absenceNotifyEnabled: 1 })
  await db.collection('notificationJobs').createIndex({ tenantId: 1, branchId: 1, date: -1 })
  await db.collection('notificationJobs').createIndex({ tenantId: 1, studentId: 1, date: -1 })
  // The worker claims by this: due, not yet terminal, oldest first.
  await db.collection('notificationJobs').createIndex({ status: 1, nextAttemptAt: 1 })
  await db.collection('notificationAttempts').createIndex({ tenantId: 1, jobId: 1, attemptNo: 1 })
  // Advisory locks self-heal: an abandoned row ages out on its own.
  await db.collection('locks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
}
