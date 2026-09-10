import { MongoClient } from 'mongodb'
import { config } from './config.js'
import { ensureIndexes } from './schema.js'
import { backfillBranchesAndClasses, backfillEnrollmentModel } from './backfill.js'

/**
 * Creates every index the app needs, then runs the one-time data backfills
 * that new structural features need on existing tenants. Mongo has no schema
 * to migrate, so index creation is safe every deploy; the backfills are each
 * idempotent (they only touch documents still missing the new shape), so
 * re-running this is a no-op once it has caught up.
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

  console.log('Backfilling academic years, enrollments, guardians, calendars...')
  await backfillEnrollmentModel(db)
  console.log('  done')

  await client.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
