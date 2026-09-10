/**
 * End-to-end check against a running API. Not a substitute for a test suite —
 * it exists so the multi-tenant guarantees are demonstrated rather than assumed.
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4000'

// A fresh key per run, so the checks never collide with data left by earlier
// runs. Both tenants are pointed at the SAME key on purpose — that is the
// isolation test: identical URL, different data, enforced by the database.
const KEY = `smoke-${Date.now().toString(36)}`

let failures = 0
const check = (name: string, pass: boolean, detail?: unknown) => {
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}`)
  if (!pass) {
    failures++
    if (detail !== undefined) console.log('        ->', JSON.stringify(detail))
  }
}

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
  return { status: response.status, body: body as Record<string, unknown> }
}

const login = (email: string, password: string) =>
  call('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })

async function main() {
  console.log('\n== auth ==')
  const bad = await login('admin@northgate.test', 'wrong-password')
  check('wrong password is rejected', bad.status === 401, bad.body)

  const unknown = await login('nobody@nowhere.test', 'whatever')
  check(
    'unknown email gives the same 401 (no user enumeration)',
    unknown.status === 401 && JSON.stringify(unknown.body) === JSON.stringify(bad.body),
    { unknown: unknown.body, bad: bad.body },
  )

  const north = await login('admin@northgate.test', 'admin123')
  check('northgate owner logs in', north.status === 200 && Boolean(north.body.accessToken))
  const northToken = north.body.accessToken as string

  const river = await login('admin@riverside.test', 'admin123')
  check('riverside owner logs in', river.status === 200 && Boolean(river.body.accessToken))
  const riverToken = river.body.accessToken as string

  const noAuth = await call(`/datasets/${KEY}`)
  check('dataset requires a token', noAuth.status === 401, noAuth.body)

  console.log('\n== sync: push, pull, history ==')
  const create = await call(
    `/datasets/${KEY}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        baseRevision: 0,
        problem: { lessons: ['NORTH-1'], timeslots: ['t1'] },
      }),
    },
    northToken,
  )
  check(
    'first push creates or updates',
    create.status === 201 || create.status === 200,
    create.body,
  )
  const revision = create.body.revision as number

  const pulled = await call(`/datasets/${KEY}`, {}, northToken)
  check('pull returns what was pushed', pulled.status === 200, pulled.body)
  check(
    'pulled document matches',
    JSON.stringify((pulled.body.problem as { lessons: string[] }).lessons) ===
      JSON.stringify(['NORTH-1']),
    pulled.body.problem,
  )

  console.log('\n== optimistic concurrency ==')
  const stale = await call(
    `/datasets/${KEY}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        baseRevision: revision - 1,
        problem: { lessons: ['STALE-WRITE'], timeslots: [] },
      }),
    },
    northToken,
  )
  check('stale write is refused with 409', stale.status === 409, stale.body)
  check('409 carries the server copy so the client can merge', Boolean(stale.body.problem))

  const fresh = await call(
    `/datasets/${KEY}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        baseRevision: revision,
        problem: { lessons: ['NORTH-2'], timeslots: [] },
      }),
    },
    northToken,
  )
  check('write at the current revision succeeds', fresh.status === 200, fresh.body)
  check('revision advances', (fresh.body.revision as number) === revision + 1, fresh.body)

  const history = await call(`/datasets/${KEY}/versions`, {}, northToken)
  check(
    'every accepted write is retained',
    ((history.body.versions as unknown[]) ?? []).length >= 2,
    history.body,
  )

  console.log('\n== tenant isolation (the one that matters) ==')
  const cross = await call(`/datasets/${KEY}`, {}, riverToken)
  const crossLessons =
    cross.status === 200 ? (cross.body.problem as { lessons: string[] }).lessons : []
  check(
    'riverside cannot see northgate data at the same key',
    cross.status === 404 || !JSON.stringify(crossLessons).includes('NORTH'),
    { status: cross.status, lessons: crossLessons },
  )

  await call(
    `/datasets/${KEY}`,
    {
      method: 'PUT',
      body: JSON.stringify({ baseRevision: 0, problem: { lessons: ['RIVER-1'], timeslots: [] } }),
    },
    riverToken,
  )
  const riverPull = await call(`/datasets/${KEY}`, {}, riverToken)
  const northPull = await call(`/datasets/${KEY}`, {}, northToken)
  check(
    'each tenant reads only its own document at the same key',
    JSON.stringify((riverPull.body.problem as { lessons: string[] }).lessons) ===
      JSON.stringify(['RIVER-1']) &&
      JSON.stringify((northPull.body.problem as { lessons: string[] }).lessons) ===
        JSON.stringify(['NORTH-2']),
    { river: riverPull.body.problem, north: northPull.body.problem },
  )

  console.log('\n== role enforcement ==')
  const viewerLogin = await login('planner@northgate.test', 'plan123')
  check('scheduler logs in', viewerLogin.status === 200)
  const schedulerWrite = await call(
    `/datasets/${KEY}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        baseRevision: (northPull.body.revision as number) ?? 1,
        problem: { lessons: ['BY-SCHEDULER'], timeslots: [] },
      }),
    },
    viewerLogin.body.accessToken as string,
  )
  check('scheduler may write', schedulerWrite.status === 200, schedulerWrite.body)

  console.log('\n== branches, classes, students, attendance ==')
  const branches = await call('/branches', {}, northToken)
  check('every tenant has at least one branch (backfilled)', branches.status === 200 && ((branches.body.branches as unknown[]) ?? []).length >= 1, branches.body)
  const branchId = ((branches.body.branches as Array<{ id: string }>) ?? [])[0]?.id

  const newClass = await call(
    '/classes',
    { method: 'POST', body: JSON.stringify({ branchId, gradeLevel: `G${KEY}`, name: 'A', capacity: 20 }) },
    northToken,
  )
  check('admin creates a class', newClass.status === 201, newClass.body)
  const classId = newClass.body.id as string

  const student = await call(
    '/students',
    {
      method: 'POST',
      body: JSON.stringify({
        studentNumber: `SN-${KEY}`,
        givenName: 'Smoke',
        familyName: 'Test',
        classId,
        guardians: [
          { name: 'Parent', relationship: 'mother', phone: '+962790000000', email: 'p@example.test', isPrimary: true },
        ],
      }),
    },
    northToken,
  )
  check('admin creates a student in that class', student.status === 201, student.body)
  const studentId = student.body.id as string

  const day = new Date().toISOString().slice(0, 10)
  const register = await call(`/attendance?date=${day}&classId=${classId}`, {}, northToken)
  const registerRows = (register.body.students as Array<{ studentId: string; status: string | null }>) ?? []
  check(
    'the register lists the enrolled student as not-yet-marked',
    register.status === 200 && registerRows.some((r) => r.studentId === studentId && r.status === null),
    register.body,
  )

  const mark = await call(
    '/attendance',
    { method: 'PUT', body: JSON.stringify({ date: day, records: [{ studentId, status: 'present' }] }) },
    northToken,
  )
  check('marking the register succeeds', mark.status === 200 && (mark.body.count as number) === 1, mark.body)

  const crossClasses = await call('/classes', {}, riverToken)
  const crossIds = ((crossClasses.body.classes as Array<{ id: string }>) ?? []).map((c) => c.id)
  check('another tenant cannot see this class', !crossIds.includes(classId), { crossIds, classId })

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
