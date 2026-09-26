// SAMS Phase 7: the shared reporting queries (7.1), the report catalog and
// its filters (7.2), CSV / Excel / print output (7.3) and scheduled exports
// (7.4) — each inside the caller's scopes and branches.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { withoutTenant, withTenant } from '../db.js'
import { config } from '../config.js'
import { runDueSchedules, nextOccurrence } from '../reports/schedules.js'
import { resolveRange } from '../reports/common.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
let finance: { token: string; userId: string }
let financeB: { token: string; userId: string }
let hr: { token: string; userId: string }
let admin: { token: string; userId: string }

type Table = {
  title: string
  columns: { key: string; label: string; type: string }[]
  rows: Record<string, string | number | null>[]
  totals: Record<string, string | number | null> | null
  meta: { label: string; value: string }[]
}

const get = (token: string, path: string) => call(fx.app, token, 'GET', path)
const table = async (token: string, path: string) => {
  const res = await get(token, path)
  assert.equal(res.status, 200, `${path}: ${res.error}`)
  return res.body as unknown as Table
}
const raw = (token: string, path: string) =>
  fx.app.inject({ method: 'GET', url: config.routePrefix + path, headers: { authorization: `Bearer ${token}` } })

/** The entries of a zip written by reports/zip.ts. */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  let at = 0
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18)
    const nameLen = buf.readUInt16LE(at + 26)
    const extra = buf.readUInt16LE(at + 28)
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8')
    const start = at + 30 + nameLen + extra
    out.set(name, inflateRawSync(buf.subarray(start, start + size)).toString('utf8'))
    at = start + size
  }
  return out
}

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
  finance = await member(fx.tenantId, 'viewer', null, 'finance_officer')
  financeB = await member(fx.tenantId, 'viewer', [fx.branchB], 'finance_officer')
  hr = await member(fx.tenantId, 'viewer', null, 'hr')
  admin = await member(fx.tenantId, 'admin', null)
})
after(async () => {
  await fx.close()
})

describe('catalog', () => {
  test('lists only the reports the caller holds the scopes for', async () => {
    const keys = async (token: string) =>
      ((await get(token, '/reports/catalog')).body as unknown as { reports: { key: string }[] }).reports.map((r) => r.key)
    const all = await keys(fx.tokens.admin)
    assert.ok(all.includes('finance.outstanding') && all.includes('hr.staff') && all.includes('ops.loans'))
    const viewer = await keys(fx.tokens.viewer)
    assert.ok(viewer.includes('students.roster') && viewer.includes('attendance.byStudent'))
    assert.ok(!viewer.some((k) => k.startsWith('finance.') || k.startsWith('hr.') || k.startsWith('admissions.')))
    const fo = await keys(finance.token)
    assert.ok(fo.includes('finance.collections') && !fo.includes('hr.leave'))
    const h = await keys(hr.token)
    assert.ok(h.includes('hr.leave') && !h.includes('finance.outstanding') && !h.includes('ops.loans'))
    assert.equal((await get(hr.token, '/reports/finance.outstanding')).error, 'FORBIDDEN')
  })

  test('a parent portal login gets no reports at all', async () => {
    const parent = await member(fx.tenantId, 'viewer', null, 'parent')
    assert.equal((await get(parent.token, '/reports/catalog')).error, 'FORBIDDEN')
    assert.equal((await get(parent.token, '/reports/students.roster')).error, 'FORBIDDEN')
    assert.equal((await get(parent.token, '/reports/runs')).error, 'FORBIDDEN')
  })

  test('titles and labels come in the language asked for', async () => {
    const r = (await get(fx.tokens.admin, '/reports/catalog?lang=ar')).body as unknown as { reports: { key: string; title: string }[] }
    assert.equal(r.reports.find((x) => x.key === 'students.roster')?.title, 'قائمة الطلاب')
    const t = await table(fx.tokens.viewer, '/reports/students.roster?lang=ar')
    assert.equal(t.columns.find((c) => c.key === 'name')?.label, 'الاسم')
  })
})

describe('filters and branches', () => {
  let studentA = ''
  let studentB = ''
  before(async () => {
    studentA = await fin.student(fx.branchA)
    studentB = await fin.student(fx.branchB)
  })

  test('a branch-confined member sees only their branch, and cannot ask for another', async () => {
    const t = await table(fx.scopedToken, '/reports/students.roster')
    const numbers = new Set(t.rows.map((r) => r.studentNumber))
    const [a, b] = await withTenant(fx.tenantId, (ctx) =>
      Promise.all([ctx.students.findOne({ _id: studentA }), ctx.students.findOne({ _id: studentB })]),
    )
    assert.ok(numbers.has(a!.studentNumber))
    assert.ok(!numbers.has(b!.studentNumber))
    assert.equal((await get(fx.scopedToken, `/reports/students.roster?branchId=${fx.branchB}`)).error, 'BRANCH_FORBIDDEN')
    assert.equal((await get(fx.scopedToken, `/reports/students.roster/export?format=csv&branchId=${fx.branchB}`)).error, 'BRANCH_FORBIDDEN')
  })

  test('class, grade and status narrow the roster', async () => {
    const byClass = await table(fx.tokens.admin, `/reports/students.roster?classId=${fin.classOf[fx.branchB]}`)
    assert.ok(byClass.rows.length > 0 && byClass.rows.every((r) => r.branch === 'Branch B'))
    const none = await table(fx.tokens.admin, '/reports/students.roster?gradeLevel=Grade%2012')
    assert.equal(none.rows.length, 0)
    const graduated = await table(fx.tokens.admin, '/reports/students.roster?status=graduated')
    assert.equal(graduated.rows.length, 0)
    assert.equal((await get(fx.tokens.admin, '/reports/students.roster?status=sleeping')).error, 'INVALID_STATUS')
  })

  test('a report with a date range needs one, in order, and not too long', async () => {
    assert.equal((await get(fx.tokens.viewer, '/reports/attendance.byStudent')).error, 'DATES_REQUIRED')
    assert.equal((await get(fx.tokens.viewer, '/reports/attendance.byStudent?from=2026-09-10&to=2026-09-01')).error, 'DATES_OUT_OF_ORDER')
    assert.equal((await get(fx.tokens.viewer, '/reports/attendance.byStudent?from=2020-01-01&to=2026-09-01')).error, 'RANGE_TOO_LONG')
    assert.equal((await get(fx.tokens.viewer, '/reports/nope')).error, 'UNKNOWN_REPORT')
  })

  test('attendance rates count present, late and early departure as attending', async () => {
    const s = await withTenant(fx.tenantId, (ctx) => ctx.students.findOne({ _id: studentA }))
    const marks = ['present', 'late', 'absent', 'excused'] as const
    await withTenant(fx.tenantId, async (ctx) => {
      for (const [i, status] of marks.entries()) {
        const date = `2026-09-0${i + 1}`
        await ctx.attendance.insertOne({
          _id: `${fx.tenantId}:${studentA}:${date}`,
          studentId: studentA,
          branchId: s!.branchId,
          classId: s!.classId,
          academicYearId: s!.academicYearId,
          enrollmentId: 'e',
          date,
          status,
          note: null,
          markedBy: 'test',
          markedAt: new Date(),
          updatedBy: null,
          updatedAt: null,
        })
      }
    })
    const t = await table(fx.tokens.viewer, `/reports/attendance.byStudent?from=2026-09-01&to=2026-09-30&branchId=${fx.branchA}`)
    const row = t.rows.find((r) => r.studentNumber === s!.studentNumber)!
    assert.deepEqual([row.present, row.late, row.absent, row.excused, row.days], [1, 1, 1, 1, 4])
    assert.equal(row.rate, 0.5)
    const byClass = await table(fx.tokens.viewer, `/reports/attendance.byClass?from=2026-09-01&to=2026-09-30&branchId=${fx.branchA}`)
    assert.equal(byClass.totals?.days, 4)
  })
})

describe('shared finance figures', () => {
  test('the outstanding report, the finance summary and the dashboard agree', async () => {
    const inv = await fin.invoice({ branchId: fx.branchB, dueDate: '2026-01-15' })
    await fin.pay(inv.id, 5000, { paidAt: '2026-09-02' })
    await fin.pay(inv.id, 1000, { paidAt: '2026-09-03', method: 'cheque', awaitingConfirmation: true })
    const q = `branchId=${fx.branchB}`
    const t = await table(finance.token, `/reports/finance.outstanding?${q}`)
    const row = t.rows.find((r) => r.invoiceNumber === inv.invoiceNumber)!
    assert.deepEqual([row.total, row.paid, row.outstanding, row.overdue], [12000, 5000, 7000, 7000])

    const summary = (await get(finance.token, `/finance/reports/summary?${q}&from=2026-09-01&to=2026-09-30`)).body as unknown as {
      aging: { total: number }
      overdue: { total: number }
      collections: { total: number; awaitingConfirmation: number }
    }
    assert.equal(summary.aging.total, t.totals!.outstanding)
    assert.equal(summary.overdue.total, t.totals!.overdue)

    const dash = (await get(finance.token, `/dashboard/summary?${q}`)).body as unknown as {
      receivables: { outstanding: number; overdue: number; openInvoices: number }
    }
    assert.equal(dash.receivables.outstanding, t.totals!.outstanding)
    assert.equal(dash.receivables.overdue, t.totals!.overdue)
    assert.equal(dash.receivables.openInvoices, t.rows.length)

    const overdueOnly = await table(finance.token, `/reports/finance.outstanding?${q}&status=current`)
    assert.ok(!overdueOnly.rows.some((r) => r.invoiceNumber === inv.invoiceNumber))

    const paid = await table(finance.token, `/reports/finance.collections?${q}&from=2026-09-01&to=2026-09-30`)
    assert.equal(paid.totals!.amount, summary.collections.total + summary.collections.awaitingConfirmation)
    const confirmed = await table(finance.token, `/reports/finance.collections?${q}&from=2026-09-01&to=2026-09-30&status=confirmed`)
    assert.equal(confirmed.totals!.amount, summary.collections.total)

    const billing = await table(finance.token, `/reports/finance.billing?${q}&from=2026-01-01&to=2026-12-31`)
    const g5 = billing.rows.find((r) => r.grade === 'Grade 5')!
    assert.ok((g5.billed as number) >= 12000)
  })

  test('a branch-confined finance officer sees their branch only', async () => {
    const t = await table(financeB.token, '/reports/finance.outstanding')
    assert.ok(t.rows.every((r) => r.branch === 'Branch B'))
    assert.equal((await get(financeB.token, `/reports/finance.outstanding?branchId=${fx.branchA}`)).error, 'BRANCH_FORBIDDEN')
  })
})

describe('exports', () => {
  test('CSV has a BOM, the header, the rows and the totals, with money in major units', async () => {
    const res = await raw(finance.token, `/reports/finance.outstanding/export?format=csv&branchId=${fx.branchB}`)
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'] as string, /text\/csv/)
    assert.match(res.headers['content-disposition'] as string, /attachment; filename="finance-outstanding/)
    const text = res.body
    assert.equal(text.charCodeAt(0), 0xfeff)
    const lines = text.slice(1).trim().split('\r\n')
    assert.ok(lines[0]!.startsWith('Invoice,Student'))
    assert.ok(lines.some((l) => l.includes(',120.00,50.00,70.00,70.00,')))
    assert.ok(lines.at(-1)!.startsWith('Total,'))
  })

  test('CSV cells that would run as a formula are neutralised', async () => {
    const res = await call(fx.app, fx.tokens.admin, 'POST', '/students', {
      studentNumber: `X-${randomUUID().slice(0, 6)}`,
      givenName: '=HYPERLINK("x")',
      familyName: 'Test',
      classId: fin.classOf[fx.branchA],
    })
    assert.equal(res.status, 201, res.error)
    const csv = (await raw(fx.tokens.admin, `/reports/students.roster/export?format=csv&branchId=${fx.branchA}`)).body
    assert.ok(csv.includes(`"'=HYPERLINK(""x"") Test"`))
  })

  test('Excel is a real .xlsx: the sheet, numbers as numbers, right-to-left in Arabic', async () => {
    const res = await raw(finance.token, `/reports/finance.outstanding/export?format=xlsx&branchId=${fx.branchB}&lang=ar`)
    assert.equal(res.statusCode, 200)
    const files = unzip(res.rawPayload)
    assert.ok(files.has('[Content_Types].xml') && files.has('xl/workbook.xml') && files.has('xl/styles.xml'))
    const sheet = files.get('xl/worksheets/sheet1.xml')!
    assert.match(sheet, /rightToLeft="1"/)
    assert.match(sheet, /<v>120<\/v>/)
    assert.match(sheet, /الأرصدة المستحقة/)
  })

  test('print output is a page laid out for printing, and every export is audited', async () => {
    const res = await raw(fx.tokens.viewer, '/reports/students.roster/export?format=html&lang=ar&autoprint=1')
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'] as string, /text\/html/)
    assert.match(res.body, /<html lang="ar" dir="rtl">/)
    assert.match(res.body, /window\.print\(\)/)
    assert.match(res.body, /@page/)
    const audits = await withTenant(fx.tenantId, (ctx) => ctx.auditLog.find({ action: 'report.export' }).toArray())
    assert.ok(audits.some((a) => a.entityId === 'students.roster' && (a.meta as { format?: string }).format === 'html'))
    assert.ok(audits.some((a) => a.entityId === 'finance.outstanding' && (a.meta as { format?: string }).format === 'xlsx'))
  })
})

describe('scheduled exports', () => {
  const schedule = (token: string, body: Record<string, unknown> = {}) =>
    call(fx.app, token, 'POST', '/reports/schedules', {
      reportKey: 'finance.outstanding',
      filters: {},
      range: 'month_to_date',
      format: 'xlsx',
      language: 'en',
      frequency: 'weekly',
      weekday: 1,
      ...body,
    })

  test('recipients must be able to see the report over the same branches', async () => {
    assert.equal((await schedule(fx.tokens.viewer)).error, 'FORBIDDEN')
    assert.equal((await schedule(hr.token)).error, 'FORBIDDEN')
    assert.equal((await schedule(finance.token, { recipients: [hr.userId] })).error, 'RECIPIENT_NO_ACCESS')
    // Every branch: a finance officer confined to branch B may not receive it…
    assert.equal((await schedule(finance.token, { recipients: [financeB.userId] })).error, 'RECIPIENT_NO_ACCESS')
    // …but may for branch B alone.
    const ok = await schedule(finance.token, { filters: { branchId: fx.branchB }, recipients: [financeB.userId] })
    assert.equal(ok.status, 201, ok.error)
    const members = (await get(finance.token, '/reports/recipients?key=finance.outstanding')).body as unknown as {
      members: { userId: string }[]
    }
    const ids = members.members.map((m) => m.userId)
    assert.ok(ids.includes(admin.userId) && !ids.includes(hr.userId) && !ids.includes(financeB.userId))
    assert.equal((await schedule(finance.token, { frequency: 'weekly', weekday: null })).error, 'INVALID_BODY')
  })

  test('run now: a file for the owner and recipients, an inbox item and an email each', async () => {
    const s = (await schedule(finance.token, { filters: { branchId: fx.branchB }, recipients: [financeB.userId] })).body as unknown as {
      id: string
      nextRunDate: string
    }
    assert.ok(s.nextRunDate > new Date().toISOString().slice(0, 10))
    const run = await call(fx.app, finance.token, 'POST', `/reports/schedules/${s.id}/run`, {})
    assert.equal(run.status, 200, run.error)
    const { runId, notified } = run.body as unknown as { runId: string; notified: number }
    assert.equal(notified, 2)

    const inbox = (await get(financeB.token, '/inbox')).body as unknown as { items: { kind: string; link: string }[] }
    assert.ok(inbox.items.some((i) => i.kind === 'report_ready' && i.link.includes(encodeURIComponent(runId))))
    const jobs = await withTenant(fx.tenantId, (ctx) => ctx.notificationJobs.find({ kind: 'report_ready', sourceId: runId }).toArray())
    assert.equal(jobs.length, 2)
    assert.ok(jobs.every((j) => j.body.includes('/reports?tab=exports&run=')))

    const file = await raw(financeB.token, `/reports/runs/${encodeURIComponent(runId)}/file`)
    assert.equal(file.statusCode, 200)
    assert.ok(unzip(file.rawPayload).has('xl/worksheets/sheet1.xml'))
    // Not named on it: no file, even with the scopes.
    assert.equal((await raw(admin.token, `/reports/runs/${encodeURIComponent(runId)}/file`)).statusCode, 404)
    const mine = (await get(financeB.token, '/reports/runs')).body as unknown as { runs: { id: string }[] }
    assert.ok(mine.runs.some((r) => r.id === runId))
  })

  test('the sweep runs what is due once a day, as the owner as they are now', async () => {
    const owner = await member(fx.tenantId, 'viewer', null, 'finance_officer')
    const s = (await schedule(owner.token, { frequency: 'daily', format: 'csv' })).body as unknown as { id: string }
    const today = new Date().toISOString().slice(0, 10)
    await withTenant(fx.tenantId, (ctx) => ctx.reportSchedules.findOneAndUpdate({ _id: s.id }, { $set: { nextRunDate: today } }))
    await runDueSchedules(today)
    // Due again the same day (a second instance): still one file.
    await withTenant(fx.tenantId, (ctx) => ctx.reportSchedules.findOneAndUpdate({ _id: s.id }, { $set: { nextRunDate: today } }))
    await runDueSchedules(today)
    const runs = await withTenant(fx.tenantId, (ctx) => ctx.reportRuns.find({ scheduleId: s.id }).toArray())
    assert.equal(runs.length, 1)
    assert.equal(runs[0]!._id, `${s.id}:${today}`)
    const after = await withTenant(fx.tenantId, (ctx) => ctx.reportSchedules.findOne({ _id: s.id }))
    assert.ok(after!.nextRunDate > today)
    assert.equal(after!.lastError, null)

    // The owner leaves the school: the next run makes nothing.
    await withoutTenant((db) => db.memberships.deleteOne({ _id: `${fx.tenantId}:${owner.userId}` }))
    await withTenant(fx.tenantId, (ctx) => ctx.reportSchedules.findOneAndUpdate({ _id: s.id }, { $set: { nextRunDate: today } }))
    await runDueSchedules(today)
    const gone = await withTenant(fx.tenantId, (ctx) => ctx.reportSchedules.findOne({ _id: s.id }))
    assert.equal(gone!.lastError, 'OWNER_REMOVED')
    assert.equal((await withTenant(fx.tenantId, (ctx) => ctx.reportRuns.countDocuments({ scheduleId: s.id }))), 1)
  })

  test('only the owner (or a team admin) manages a schedule; deleting removes its files', async () => {
    const s = (await schedule(finance.token)).body as unknown as { id: string }
    const other = await member(fx.tenantId, 'viewer', null, 'finance_officer')
    assert.equal((await call(fx.app, other.token, 'PATCH', `/reports/schedules/${s.id}`, { active: false })).error, 'NOT_FOUND')
    const paused = await call(fx.app, fx.tokens.admin, 'PATCH', `/reports/schedules/${s.id}`, { active: false })
    assert.equal(paused.status, 200, paused.error)
    assert.equal((paused.body as unknown as { active: boolean }).active, false)
    await call(fx.app, finance.token, 'POST', `/reports/schedules/${s.id}/run`, {})
    assert.equal((await call(fx.app, finance.token, 'DELETE', `/reports/schedules/${s.id}`)).status, 200)
    assert.equal(await withTenant(fx.tenantId, (ctx) => ctx.reportRuns.countDocuments({ scheduleId: s.id })), 0)
  })
})

describe('dates', () => {
  test('relative ranges and the next run date', () => {
    const t = '2026-03-15'
    assert.deepEqual(resolveRange('yesterday', t, null), { from: '2026-03-14', to: '2026-03-14' })
    assert.deepEqual(resolveRange('last_7_days', t, null), { from: '2026-03-08', to: '2026-03-14' })
    assert.deepEqual(resolveRange('month_to_date', t, null), { from: '2026-03-01', to: t })
    assert.deepEqual(resolveRange('previous_month', t, null), { from: '2026-02-01', to: '2026-02-28' })
    assert.deepEqual(resolveRange('year_to_date', t, null), { from: '2026-01-01', to: t })
    // 2026-03-15 is a Sunday.
    assert.equal(nextOccurrence({ frequency: 'weekly', weekday: 1, monthDay: null }, t), '2026-03-16')
    assert.equal(nextOccurrence({ frequency: 'weekly', weekday: 0, monthDay: null }, t), t)
    assert.equal(nextOccurrence({ frequency: 'monthly', weekday: null, monthDay: 1 }, t), '2026-04-01')
    assert.equal(nextOccurrence({ frequency: 'daily', weekday: null, monthDay: null }, t), t)
  })
})
