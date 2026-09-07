import { MongoClient } from 'mongodb'
import { config } from './config.js'
import { ensureIndexes } from './schema.js'

/**
 * Creates every index the app needs. There is no schema to migrate — Mongo
 * collections and fields exist the moment something is written to them — so
 * unlike the Postgres version, this is safe to run on every deploy.
 */
async function main(): Promise<void> {
  const client = new MongoClient(config.databaseUrl)
  await client.connect()
  const db = client.db()

  console.log(`Ensuring indexes on ${db.databaseName}...`)
  await ensureIndexes(db)
  console.log('  done')

  await client.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
