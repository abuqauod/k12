import { MongoClient } from 'mongodb'
import { config } from './config.js'
import { backfillParentsFromGuardians } from './backfill.js'

/**
 * Fills the two base tenants (created by `npm run seed`) with realistic
 * classes / students / attendance / finance data, so every screen has
 * something to show instead of an empty state. Goes through the real HTTP
 * API (same idiom as smoke.ts) rather than writing documents directly —
 * `classes` and `students` have no extracted service layer to call
 * out-of-request, and going through the API exercises the same validation,
 * derived fields (student.branchId/classId cache, enrollment) and audit
 * trail a real admin action would.
 *
 * Requires the API server already running (`npm run dev` in another
 * terminal) — override its address with SEED_BASE if it's not on the
 * default port.
 *
 * Meant to run once against a freshly seeded database. Classes and fee
 * structures 409 cleanly on a name/slot clash (so a second run fails fast,
 * on the very first one, rather than corrupting data), but student numbers
 * are generated from a counter starting at 1 every run and duplicate — wipe
 * and re-seed rather than re-running this against data it already created.
 */

const BASE = process.env.SEED_BASE ?? 'http://localhost:4000'

const GIVEN_NAMES = ['Layan', 'Yousef', 'Hala', 'Ahmad', 'Dana', 'Karim', 'Lina', 'Rami', 'Nour', 'Zaid', 'Rand', 'Adam']
const FAMILY_NAMES = ['Haddad', 'Khoury', 'Saleh', 'Barakat', 'Odeh', 'Qasim', 'Nasser', 'Habash', 'Zaidan', 'Ayyash']
const METHODS = ['cash', 'bank_transfer', 'card', 'cheque'] as const

/** Deterministic so re-runs produce the same demo picture. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(0x5eed)
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(random() * arr.length)]!
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

async function call(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* keep raw text */
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${JSON.stringify(body)}`)
  }
  return body as Record<string, unknown>
}

async function login(email: string, password: string): Promise<string> {
  const body = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  return body.accessToken as string
}

interface SeedPlan {
  tenantLabel: string
  email: string
  password: string
  /** Sections per branch — keeps the smaller tenant smaller. */
  sectionsPerBranch: string[]
  studentsPerClass: number
}

const PLANS: SeedPlan[] = [
  { tenantLabel: 'northgate', email: 'admin@northgate.test', password: 'admin123', sectionsPerBranch: ['A', 'B'], studentsPerClass: 8 },
  { tenantLabel: 'riverside', email: 'admin@riverside.test', password: 'admin123', sectionsPerBranch: ['A'], studentsPerClass: 6 },
]

async function seedTenant(plan: SeedPlan): Promise<void> {
  console.log(`\n== ${plan.tenantLabel} ==`)
  const token = await login(plan.email, plan.password)

  const branchesBody = await call('/branches', {}, token)
  const branches = (branchesBody.branches as Array<{ id: string; code: string; name: string }>) ?? []
  if (branches.length === 0) throw new Error(`${plan.tenantLabel}: no branches — run 'npm run seed' first`)

  const yearsBody = await call('/academic-years', {}, token)
  const currentYear = ((yearsBody.years as Array<{ id: string; current: boolean }>) ?? []).find((y) => y.current)
  if (!currentYear) throw new Error(`${plan.tenantLabel}: no current academic year — run 'npm run seed' first`)

  const gradeLevels = ['Grade 1', 'Grade 2', 'Grade 3']
  let studentSeq = 1
  let invoiceCount = 0
  let paidCount = 0

  for (const branch of branches) {
    console.log(`  branch ${branch.name} (${branch.code})`)

    // A notification-settings row so the absence-notify screen isn't empty.
    await call(`/branches/${branch.id}/notification-settings`, {
      method: 'PUT',
      body: JSON.stringify({
        absenceNotifyEnabled: true,
        cutoffTime: '10:00',
        channels: ['email'],
        notifyOnUnmarked: false,
        emailSubject: 'Absence: {studentName}',
        emailBody: '{studentName} was marked absent on {date}.',
        smsBody: '{studentName} absent {date}',
      }),
    }, token)

    for (const gradeLevel of gradeLevels) {
      const feeStructure = await call('/finance/fee-structures', {
        method: 'POST',
        body: JSON.stringify({
          branchId: branch.id,
          academicYearId: currentYear.id,
          gradeLevel,
          name: `${gradeLevel} Tuition ${new Date().getFullYear()}`,
          lineItems: [
            { label: 'Tuition', amount: 250_000 },
            { label: 'Books & materials', amount: 15_000 },
            { label: 'Activities', amount: 8_000 },
          ],
        }),
      }, token)
      const feeStructureId = feeStructure.id as string

      for (const section of plan.sectionsPerBranch) {
        const klass = await call('/classes', {
          method: 'POST',
          body: JSON.stringify({ branchId: branch.id, gradeLevel, name: section, capacity: 25, academicYearId: currentYear.id }),
        }, token)
        const classId = klass.id as string

        const studentIds: string[] = []
        for (let i = 0; i < plan.studentsPerClass; i++) {
          const given = pick(GIVEN_NAMES)
          const family = pick(FAMILY_NAMES)
          const parentName = `${pick(GIVEN_NAMES)} ${family}`
          const num = `${plan.tenantLabel.slice(0, 2).toUpperCase()}-${String(studentSeq++).padStart(4, '0')}`
          const student = await call('/students', {
            method: 'POST',
            body: JSON.stringify({
              studentNumber: num,
              givenName: given,
              familyName: family,
              classId,
              gender: random() > 0.5 ? 'male' : 'female',
              admissionDate: isoDaysAgo(300),
              guardians: [
                {
                  name: parentName,
                  relationship: random() > 0.5 ? 'father' : 'mother',
                  phone: `+9627${String(90000000 + Math.floor(random() * 9_000_000))}`,
                  email: `${parentName.toLowerCase().replace(/\s+/g, '.')}@example.test`,
                  isPrimary: true,
                  notifyByEmail: true,
                  notifyBySms: false,
                  preferredLanguage: random() > 0.5 ? 'ar' : 'en',
                },
              ],
            }),
          }, token)
          studentIds.push(student.id as string)
        }

        // Attendance for the last 4 school days — mostly present, a few
        // absences/lates so the log and the absence-notify queue have
        // something real to show.
        for (let d = 1; d <= 4; d++) {
          const date = isoDaysAgo(d)
          const records = studentIds.map((studentId) => {
            const roll = random()
            const status = roll < 0.08 ? 'absent' : roll < 0.14 ? 'late' : 'present'
            return { studentId, status }
          })
          await call('/attendance', { method: 'PUT', body: JSON.stringify({ date, records }) }, token)
        }
        await call('/notifications/run', { method: 'POST', body: JSON.stringify({ branchId: branch.id, date: isoDaysAgo(1) }) }, token)

        // Finance: an invoice per student, most with a payment (some full,
        // some partial, a few untouched) — a realistic mix of statuses.
        for (const studentId of studentIds) {
          const invoice = await call('/finance/invoices', {
            method: 'POST',
            body: JSON.stringify({ studentId, feeStructureId, dueDate: isoDaysAgo(-30) }),
          }, token)
          invoiceCount++
          if (random() < 0.85) {
            const total = invoice.total as number
            const amount = random() < 0.55 ? total : Math.round(total * (0.4 + random() * 0.4))
            await call(`/finance/invoices/${invoice.id}/payments`, {
              method: 'POST',
              body: JSON.stringify({
                amount,
                method: pick(METHODS),
                paidAt: isoDaysAgo(Math.floor(random() * 20)),
                payerName: 'Parent Payment',
              }),
            }, token)
            paidCount++
          }
        }
      }
    }
  }
  console.log(`  ${invoiceCount} invoices generated, ${paidCount} with a payment`)
}

async function main(): Promise<void> {
  const reachable = await fetch(BASE).then(() => true).catch(() => false)
  if (!reachable) {
    console.error(
      `Cannot reach the API at ${BASE}. Start it first (npm run dev in another terminal), or set SEED_BASE.`,
    )
    process.exit(1)
  }

  for (const plan of PLANS) {
    await seedTenant(plan)
  }

  // The routes above only write the per-student embedded `guardians[]` —
  // the normalized `parents` / `parentStudentLinks` collections that the
  // Parents screen reads are a backfill, same as `migrate.ts` runs for a
  // real tenant's existing data.
  console.log('\nbackfilling normalized parent records...')
  const client = new MongoClient(config.databaseUrl)
  await client.connect()
  await backfillParentsFromGuardians(client.db())
  await client.close()
  console.log('  done')

  console.log('\ndemo data complete')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
