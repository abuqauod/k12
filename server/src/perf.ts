/**
 * SAMS 10.3 — builds a large school in a scratch tenant and times the
 * heavy reads. Two branches, 12 grades × 4 sections each, ~3,000 students
 * with families, a year's invoices, most of them part-paid, and 40 school
 * days of attendance — all through the real routes.
 *
 *   DATABASE_URL=mongodb://localhost:27017/sams_perf?replicaSet=rs0 \
 *     JWT_SECRET=... npx tsx src/perf.ts [students]
 *
 * Use a scratch database. Prints the median of five calls per route,
 * slowest first. `PERF_TENANT=<id>` times a school built earlier again.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withoutTenant, withTenant } from './db.js'
import { createFixture, member, type Fixture } from './test/harness.js'

const TARGET = Number(process.argv[2] ?? 3000)
const GRADES = Array.from({ length: 12 }, (_, i) => `Grade ${i + 1}`)
const SECTIONS = ['A', 'B', 'C', 'D']
const GIVEN = ['Layan', 'Yousef', 'Hala', 'Ahmad', 'Dana', 'Karim', 'Lina', 'Rami', 'Nour', 'Zaid', 'Rand', 'Adam']
const FAMILY = ['Haddad', 'Khoury', 'Saleh', 'Barakat', 'Odeh', 'Qasim', 'Nasser', 'Habash', 'Zaidan', 'Ayyash']

async function main() {
  const fx = await createFixture()
  let token = fx.tokens.owner
  // PERF_TENANT=<id>: time an already built school again, skip the build.
  const existing = process.env.PERF_TENANT
  if (existing) {
    token = (await member(existing, 'owner', null)).token
    const branches = await withoutTenant((db) => db.branches.find({ tenantId: existing }).toArray())
    const [s] = await withTenant(existing, (ctx) => ctx.students.find({}).limit(1).toArray())
    const api = async (method: 'GET', url: string) => {
      const res = await fx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } })
      return { status: res.statusCode, size: res.body.length }
    }
    await time({ ...fx, branchA: branches[0]!._id }, api, s!._id, s!.classId)
    await fx.close()
    return
  }
  const api = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) => {
    const res = await fx.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { payload: body as object }) })
    return { status: res.statusCode, json: () => res.json() as Record<string, unknown>, size: res.body.length }
  }
  const must = async (method: 'POST' | 'PUT' | 'PATCH', url: string, body: unknown) => {
    const res = await api(method, url, body)
    assert.ok(res.status < 300, `${method} ${url} → ${res.status} ${JSON.stringify(res.json()).slice(0, 200)}`)
    return res.json()
  }

  const t0 = Date.now()
  const yearId = randomUUID()
  await withTenant(fx.tenantId, (ctx) =>
    ctx.academicYears.insertOne({ _id: yearId, name: '2026–2027', startDate: '2026-08-01', endDate: '2027-06-30', terms: [], current: true, createdAt: new Date() }),
  )
  const classes: { id: string; branchId: string; grade: string }[] = []
  const fees = new Map<string, string>()
  for (const branchId of [fx.branchA, fx.branchB]) {
    for (const grade of GRADES) {
      const bulk = await must('POST', '/classes/bulk', { branchId, gradeLevel: grade, capacity: 40, academicYearId: yearId, sections: SECTIONS })
      for (const c of bulk.created as { id: string }[]) classes.push({ id: c.id, branchId, grade })
      const fee = await must('POST', '/finance/fee-structures', {
        branchId,
        academicYearId: yearId,
        gradeLevel: grade,
        name: `${grade} fees`,
        lineItems: [
          { label: 'Tuition', amount: 250000 },
          { label: 'Books', amount: 30000 },
        ],
      })
      fees.set(`${branchId}:${grade}`, fee.id as string)
    }
  }
  console.log(`classes ${classes.length}, fee structures ${fees.size} (${Date.now() - t0} ms)`)

  const students: { id: string; classId: string; branchId: string; grade: string }[] = []
  let parentId = ''
  for (let i = 0; i < TARGET; i++) {
    const c = classes[i % classes.length]!
    const s = await must('POST', '/students', {
      studentNumber: '',
      givenName: GIVEN[i % GIVEN.length],
      familyName: `${FAMILY[(i * 7) % FAMILY.length]} ${i}`,
      classId: c.id,
      dob: `201${i % 10}-0${(i % 9) + 1}-1${i % 9}`,
      gender: i % 2 ? 'male' : 'female',
    })
    const id = (s.id ?? (s.student as { id: string }).id) as string
    students.push({ id, classId: c.id, branchId: c.branchId, grade: c.grade })
    // Two children per family on average.
    if (i % 2 === 0) {
      const p = await must('POST', '/parents', { fullName: `Parent ${i}`, primaryPhone: `079${String(1000000 + i).slice(-7)}`, email: `parent${i}@family.test` })
      parentId = (p.parent as { id: string }).id
    }
    await must('POST', `/parents/${parentId}/links`, { studentId: id, relationshipType: 'father', primaryContact: true, financialResponsibility: true })
    if (i % 500 === 0) console.log(`students ${i} (${Date.now() - t0} ms)`)
  }

  for (const [i, s] of students.entries()) {
    const inv = await must('POST', '/finance/invoices', { studentId: s.id, feeStructureId: fees.get(`${s.branchId}:${s.grade}`), dueDate: '2026-10-01' })
    if (i % 3 !== 0) {
      await must('POST', `/finance/invoices/${inv.id as string}/payments`, { amount: 100000 + (i % 5) * 20000, method: 'cash', paidAt: '2026-09-15', payerName: 'Parent' })
    }
    if (i % 500 === 0) console.log(`invoices ${i} (${Date.now() - t0} ms)`)
  }

  const byClass = new Map<string, string[]>()
  for (const s of students) {
    const list = byClass.get(s.classId) ?? []
    list.push(s.id)
    byClass.set(s.classId, list)
  }
  const days: string[] = []
  for (let d = new Date('2026-09-01'); days.length < 40; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 5 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10))
  }
  for (const date of days) {
    for (const [, ids] of byClass) {
      await must('PUT', '/attendance', {
        date,
        records: ids.map((studentId, k) => ({ studentId, status: (k + date.length) % 17 === 0 ? 'absent' : 'present' })),
      })
    }
  }
  console.log(`built ${students.length} students in ${Math.round((Date.now() - t0) / 1000)} s; tenant ${fx.tenantId}`)
  await time(fx, api, students[0]!.id, classes[0]!.id)
  await fx.close()
}

async function time(
  fx: Fixture,
  api: (m: 'GET', url: string) => Promise<{ status: number; size: number }>,
  studentId: string,
  classId: string,
) {
  const b = fx.branchA
  const routes = [
    '/students',
    `/students?branchId=${b}`,
    '/students?search=Haddad',
    `/students/${studentId}`,
    '/parents',
    '/parents?search=Parent 1',
    '/finance/invoices',
    `/finance/invoices?branchId=${b}&status=partially_paid`,
    `/finance/payments?branchId=${b}`,
    `/finance/receipts?branchId=${b}`,
    '/dashboard/summary',
    `/attendance?date=2026-09-15&classId=${classId}`,
    `/attendance/student/${studentId}`,
    '/search?q=Haddad',
    '/reports/students.roster',
    '/reports/attendance.byStudent?from=2026-09-01&to=2026-10-31',
    '/reports/attendance.byClass?from=2026-09-01&to=2026-10-31',
    '/reports/finance.outstanding',
    '/reports/finance.collections?from=2026-09-01&to=2026-10-31',
    `/reports/finance.billing?academicYearId=${''}`,
    '/reports/students.roster/export?format=xlsx',
    '/reports/finance.outstanding/export?format=csv',
    `/id-cards/students?branchId=${b}`,
    '/audit-log',
  ]
  const rows: [string, number, number, number][] = []
  for (const url of routes) {
    const ms: number[] = []
    let status = 0
    let size = 0
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      const res = await api('GET', url)
      ms.push(performance.now() - start)
      status = res.status
      size = res.size
    }
    ms.sort((a, b) => a - b)
    rows.push([url, Math.round(ms[2]!), status, size])
  }
  rows.sort((a, b) => b[1] - a[1])
  console.log('\nmedian ms  status  KB  route')
  for (const [url, ms, status, size] of rows) console.log(`${String(ms).padStart(8)}  ${status}  ${String(Math.round(size / 1024)).padStart(5)}  ${url}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
