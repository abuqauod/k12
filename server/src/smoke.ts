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

  const schedulerToken = viewerLogin.body.accessToken as string

  console.log('\n== academic structure ==')
  const years = await call('/academic-years', {}, northToken)
  const currentYears = ((years.body.years as Array<{ current: boolean }>) ?? []).filter((y) => y.current)
  check('migration left exactly one current academic year', years.status === 200 && currentYears.length === 1, years.body)

  console.log('\n== branches & classes ==')
  const branches = await call('/branches', {}, northToken)
  check('every tenant has at least one branch (backfilled)', branches.status === 200 && ((branches.body.branches as unknown[]) ?? []).length >= 1, branches.body)
  const branchA = ((branches.body.branches as Array<{ id: string }>) ?? [])[0]?.id

  const branchBRes = await call('/branches', { method: 'POST', body: JSON.stringify({ name: `West ${KEY}`, code: `west-${KEY.replace(/[^a-z0-9-]/gi, '').toLowerCase()}` }) }, northToken)
  check('admin creates a second branch', branchBRes.status === 201, branchBRes.body)
  const branchB = branchBRes.body.id as string

  const classA = await call('/classes', { method: 'POST', body: JSON.stringify({ branchId: branchA, gradeLevel: `G${KEY}`, name: 'A', capacity: 20 }) }, northToken)
  const classB = await call('/classes', { method: 'POST', body: JSON.stringify({ branchId: branchB, gradeLevel: `G${KEY}`, name: 'B', capacity: 20 }) }, northToken)
  check('admin creates a class in each branch', classA.status === 201 && classB.status === 201, { a: classA.body, b: classB.body })
  const classAId = classA.body.id as string
  const classBId = classB.body.id as string

  console.log('\n== enrollment, transfer, multiple guardians ==')
  const student = await call('/students', {
    method: 'POST',
    body: JSON.stringify({
      studentNumber: `SN-${KEY}`,
      givenName: 'Smoke',
      familyName: 'Test',
      classId: classAId,
      guardians: [
        { name: 'Parent One', relationship: 'mother', phone: '+962790000001', email: 'p1@example.test', isPrimary: true, notifyByEmail: true, preferredLanguage: 'en' },
        { name: 'Parent Two', relationship: 'father', phone: '+962790000002', email: 'p2@example.test', notifyByEmail: true, preferredLanguage: 'ar' },
      ],
    }),
  }, northToken)
  check('creating a student opens an enrollment', student.status === 201, student.body)
  const studentId = student.body.id as string

  const detail = await call(`/students/${studentId}`, {}, northToken)
  const gs = (detail.body.guardians as Array<{ id?: string; preferredLanguage?: string }>) ?? []
  check('both guardians are stored with ids and languages', gs.length === 2 && gs.every((g) => typeof g.id === 'string' && g.id.length > 0) && gs.some((g) => g.preferredLanguage === 'ar'), gs)

  const enr1 = await call(`/students/${studentId}/enrollments`, {}, northToken)
  const rows1 = (enr1.body.enrollments as Array<{ status: string; academicYearId: string }>) ?? []
  check('exactly one active enrollment, tied to the current year', rows1.filter((r) => r.status === 'active').length === 1 && Boolean(rows1[0]?.academicYearId), enr1.body)

  const transfer = await call(`/students/${studentId}/transfer`, { method: 'POST', body: JSON.stringify({ toClassId: classBId, reason: 'smoke transfer' }) }, northToken)
  const tBody = transfer.body as { from?: { status?: string }; to?: { status?: string } }
  check('transfer closes the old enrollment and opens a new one', transfer.status === 200 && tBody.from?.status === 'transferred' && tBody.to?.status === 'active', transfer.body)

  const enr2 = await call(`/students/${studentId}/enrollments`, {}, northToken)
  const rows2 = (enr2.body.enrollments as Array<{ status: string; classId: string }>) ?? []
  check('history has 2 rows, still only one active, now in branch B class', rows2.length === 2 && rows2.filter((r) => r.status === 'active').length === 1 && rows2.find((r) => r.status === 'active')?.classId === classBId, enr2.body)

  const afterTransfer = await call(`/students/${studentId}`, {}, northToken)
  check('the student cache followed the transfer', afterTransfer.body.branchId === branchB && afterTransfer.body.classId === classBId, { branchId: afterTransfer.body.branchId, classId: afterTransfer.body.classId })

  console.log('\n== attendance states & corrections, duplicate prevention ==')
  const day = new Date().toISOString().slice(0, 10)
  const m1 = await call('/attendance', { method: 'PUT', body: JSON.stringify({ date: day, records: [{ studentId, status: 'early_departure', note: 'left at noon' }] }) }, northToken)
  check('a new mark with the new "early_departure" state inserts', m1.status === 200 && (m1.body.inserted as number) === 1, m1.body)

  const m2 = await call('/attendance', { method: 'PUT', body: JSON.stringify({ date: day, reason: 'was actually present', records: [{ studentId, status: 'present' }] }) }, northToken)
  check('re-marking the same day is a correction, not a second row', m2.status === 200 && (m2.body.corrected as number) === 1 && (m2.body.inserted as number) === 0, m2.body)

  const hist = await call(`/attendance/student/${studentId}?from=${day}&to=${day}`, {}, northToken)
  check('the student has exactly one attendance record for that day', ((hist.body.records as unknown[]) ?? []).length === 1, hist.body)

  const corr = await call(`/attendance/student/${studentId}/corrections`, {}, northToken)
  const corrRows = (corr.body.corrections as Array<{ from: { status: string }; to: { status: string } }>) ?? []
  check('the correction trail records the before and after', corrRows.length === 1 && corrRows[0]?.from.status === 'early_departure' && corrRows[0]?.to.status === 'present', corr.body)

  console.log('\n== notification queue: idempotency & multi-instance ==')
  await call(`/branches/${branchB}/notification-settings`, {
    method: 'PUT',
    body: JSON.stringify({
      absenceNotifyEnabled: true,
      cutoffTime: '00:00',
      channels: ['email'],
      notifyOnUnmarked: false,
      emailSubject: 'Absent: {studentName}',
      emailBody: '{studentName} was absent on {date}.',
      smsBody: '{studentName} absent {date}',
    }),
  }, northToken)
  await call('/attendance', { method: 'PUT', body: JSON.stringify({ date: day, records: [{ studentId, status: 'absent' }] }) }, northToken)

  // Two "instances" enqueue the same branch/day at once.
  const [runA, runB] = await Promise.all([
    call('/notifications/run', { method: 'POST', body: JSON.stringify({ branchId: branchB, date: day }) }, northToken),
    call('/notifications/run', { method: 'POST', body: JSON.stringify({ branchId: branchB, date: day }) }, northToken),
  ])
  const totalEnqueued = (runA.body.enqueued as number ?? 0) + (runB.body.enqueued as number ?? 0)
  check('concurrent runs enqueue each (student,guardian,channel) job exactly once', runA.status === 200 && runB.status === 200 && totalEnqueued === 2, { a: runA.body, b: runB.body })

  const run3 = await call('/notifications/run', { method: 'POST', body: JSON.stringify({ branchId: branchB, date: day }) }, northToken)
  check('a third run enqueues nothing new', (run3.body.enqueued as number) === 0 && (run3.body.alreadyQueued as number) === 2, run3.body)

  const notifs = await call(`/notifications?branchId=${branchB}&date=${day}`, {}, northToken)
  check('the log holds two jobs (two opted-in guardians, one channel)', ((notifs.body.entries as unknown[]) ?? []).length === 2, notifs.body)

  console.log('\n== permission + branch authorization ==')
  const schedBranch = await call('/branches', { method: 'POST', body: JSON.stringify({ name: 'Nope', code: `nope-${KEY.replace(/[^a-z0-9-]/gi, '').toLowerCase()}` }) }, schedulerToken)
  check('a scheduler cannot create a branch (admin only)', schedBranch.status === 403, schedBranch.body)

  const schedTransfer = await call(`/students/${studentId}/transfer`, { method: 'POST', body: JSON.stringify({ toClassId: classAId }) }, schedulerToken)
  check('a scheduler cannot transfer a student (admin only)', schedTransfer.status === 403, schedTransfer.body)

  const crossClasses = await call('/classes', {}, riverToken)
  const crossIds = ((crossClasses.body.classes as Array<{ id: string }>) ?? []).map((c) => c.id)
  check('another tenant cannot see these classes', !crossIds.includes(classAId) && !crossIds.includes(classBId), { crossIds })

  const crossEnr = await call(`/students/${studentId}/enrollments`, {}, riverToken)
  check('another tenant cannot read this student\'s enrollments', ((crossEnr.body.enrollments as unknown[]) ?? []).length === 0, crossEnr.body)

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
