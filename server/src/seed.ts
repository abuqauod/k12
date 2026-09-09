import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { config } from './config.js'
import { ensureIndexes } from './schema.js'
import { hashPassword } from './auth/routes.js'
import type { MembershipDoc, TenantDoc, UserDoc } from './db.js'

/**
 * Creates two schools with separate staff, so tenant isolation can be
 * exercised for real rather than assumed.
 */
const TENANTS = [
  {
    slug: 'northgate',
    name: 'Northgate International School',
    users: [
      { email: 'admin@northgate.test', password: 'admin123', name: 'Layla Hassan', nameAr: 'ليلى حسن', role: 'owner' as const },
      { email: 'planner@northgate.test', password: 'plan123', name: 'Omar Nasser', nameAr: 'عمر ناصر', role: 'scheduler' as const },
    ],
  },
  {
    slug: 'riverside',
    name: 'Riverside Academy',
    users: [
      { email: 'admin@riverside.test', password: 'admin123', name: 'Sara Malik', nameAr: 'سارة مالك', role: 'owner' as const },
    ],
  },
]

async function main(): Promise<void> {
  const client = new MongoClient(config.databaseUrl)
  await client.connect()
  const db = client.db()
  await ensureIndexes(db)

  const tenants = db.collection<TenantDoc>('tenants')
  const users = db.collection<UserDoc>('users')
  const memberships = db.collection<MembershipDoc>('memberships')

  for (const tenant of TENANTS) {
    const now = new Date()
    const validUntil = new Date(now.getTime() + 365 * 86_400_000).toISOString().slice(0, 10)

    const existingTenant = await tenants.findOne({ slug: tenant.slug })
    const tenantId = existingTenant?._id ?? randomUUID()
    await tenants.updateOne(
      { _id: tenantId },
      {
        $set: { slug: tenant.slug, name: tenant.name, updatedAt: now },
        $setOnInsert: {
          plan: 'standard',
          status: 'active',
          seats: 25,
          validUntil,
          graceDays: 21,
          createdAt: now,
        },
      },
      { upsert: true },
    )

    for (const user of tenant.users) {
      const email = user.email.toLowerCase()
      const hash = await hashPassword(user.password)
      const existingUser = await users.findOne({ email })
      const userId = existingUser?._id ?? randomUUID()
      await users.updateOne(
        { _id: userId },
        {
          $set: {
            email,
            passwordHash: hash,
            displayName: user.name,
            displayNameAr: user.nameAr,
          },
          $setOnInsert: {
            active: true,
            platformAdmin: false,
            emailVerified: true,
            createdAt: now,
            lastLoginAt: null,
          },
        },
        { upsert: true },
      )

      await memberships.updateOne(
        { _id: `${tenantId}:${userId}` },
        {
          $set: { tenantId, userId, role: user.role },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      )
      console.log(`  ${tenant.slug}: ${user.email} (${user.role})`)
    }
  }

  await client.close()
  console.log('seed complete')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
