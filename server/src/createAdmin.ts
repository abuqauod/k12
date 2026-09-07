import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { config } from './config.js'
import { hashPassword } from './auth/routes.js'
import type { UserDoc } from './db.js'

/**
 * Bootstraps (or promotes) the vendor's own operator account. Deliberately a
 * script, not an API endpoint — there is no legitimate way to grant
 * `platformAdmin` over the network, since that would mean the API could
 * mint its own superuser.
 *
 * Usage: npm run create-admin -- you@example.com 'a strong password' 'Your Name'
 */
async function main(): Promise<void> {
  const [email, password, displayName] = process.argv.slice(2)
  if (!email || !password) {
    console.error("Usage: npm run create-admin -- <email> <password> ['display name']")
    process.exit(1)
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.')
    process.exit(1)
  }

  const client = new MongoClient(config.databaseUrl)
  await client.connect()
  const users = client.db().collection<UserDoc>('users')

  const normalizedEmail = email.toLowerCase()
  const passwordHash = await hashPassword(password)
  const existing = await users.findOne({ email: normalizedEmail })

  if (existing) {
    await users.updateOne(
      { _id: existing._id },
      { $set: { passwordHash, platformAdmin: true, active: true } },
    )
    console.log(`Promoted existing user ${normalizedEmail} to platform admin.`)
  } else {
    await users.insertOne({
      _id: randomUUID(),
      email: normalizedEmail,
      passwordHash,
      displayName: displayName ?? normalizedEmail,
      displayNameAr: null,
      active: true,
      platformAdmin: true,
      createdAt: new Date(),
      lastLoginAt: null,
    })
    console.log(`Created platform admin ${normalizedEmail}.`)
  }

  await client.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
