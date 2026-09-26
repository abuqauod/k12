// Backlog: bulk import from CSV — parsing, the row checks, and commit
// through the app's own create routes (as the caller).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { withTenant } from '../db.js'
import { parseCsv } from '../imports/csv.js'
import { parseDate } from '../imports/routes.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
})
after(async () => {
  await fx.close()
})

describe('csv', () => {
  test('quotes, commas, line breaks, BOM and semicolons', () => {
    assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n\n'), [
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
    ])
    assert.deepEqual(parseCsv('a;b\n1;"2\n3"'), [
      ['a', 'b'],
      ['1', '2\n3'],
    ])
  })
  test('dates in ISO or day-first form', () => {
    assert.equal(parseDate('2016-03-14'), '2016-03-14')
    assert.equal(parseDate('14/03/2016'), '2016-03-14')
    assert.equal(parseDate('31/02/2016'), null)
    assert.equal(parseDate('March 3'), null)
  })
})

describe('student import', () => {
  const csv = (rows: string[]) =>
    ['student_number,first_name,last_name,class,dob,gender,parent_name,parent_phone,parent_email', ...rows].join('\n')

  test('preview checks every row without writing', async () => {
    await fin.student(fx.branchA)
    await withTenant(fx.tenantId, (ctx) => ctx.students.findOneAndUpdate({}, { $set: { studentNumber: 'TAKEN-1' } }))
    const res = await call(fx.app, fx.tokens.admin, 'POST', '/imports/students/preview', {
      branchId: fx.branchA,
      csv: csv([
        'I-1,Sara,Nasser,Grade 5 A,14/03/2016,F,Omar Nasser,0791112233,omar@example.test',
        'I-1,Ali,Nasser,grade 5-a,,m,Omar Nasser,0791112233,',
        ',Noor,,Grade 9 Z,31/02/2016,x,,,',
        'TAKEN-1,Dana,Saleh,Grade 5 A,,,,,',
      ]),
    })
    assert.equal(res.status, 200, res.error)
    const body = res.body as unknown as { total: number; valid: number; rows: { line: number; errors: string[] }[] }
    assert.equal(body.total, 4)
    assert.equal(body.valid, 1)
    assert.deepEqual(body.rows[1]!.errors, ['DUPLICATE_IN_FILE'])
    assert.deepEqual(body.rows[2]!.errors.sort(), ['BAD_DOB', 'BAD_GENDER', 'FAMILY_NAME_REQUIRED', 'UNKNOWN_CLASS'])
    assert.deepEqual(body.rows[3]!.errors, ['STUDENT_NUMBER_TAKEN'])
    assert.equal(await withTenant(fx.tenantId, (ctx) => ctx.students.countDocuments({ studentNumber: 'I-1' })), 0)
    const missing = await call(fx.app, fx.tokens.admin, 'POST', '/imports/students/preview', { branchId: fx.branchA, csv: 'first_name\nX' })
    assert.equal(missing.error, 'MISSING_COLUMNS')
  })

  test('commit creates the valid rows, enrolls them, and links one family for siblings', async () => {
    const res = await call(fx.app, fx.tokens.admin, 'POST', '/imports/students/commit', {
      branchId: fx.branchA,
      csv: csv([
        'C-1,Sara,Nasser,Grade 5 A,14/03/2016,F,Omar Nasser,0791112233,omar@example.test',
        ',Ali,Nasser,Grade 5 A,,m,Omar Nasser,+962 79 111 2233,',
        'C-3,Bad,Row,Grade 9 Z,,,,,',
      ]),
    })
    assert.equal(res.status, 200, res.error)
    const out = res.body as unknown as {
      created: { line: number; id: string; number: string | null }[]
      failed: { line: number; errors: string[] }[]
      parentsCreated: number
      parentsLinked: number
    }
    assert.equal(out.created.length, 2)
    assert.deepEqual(out.failed, [{ line: 4, errors: ['UNKNOWN_CLASS'] }])
    assert.equal(out.created[0]!.number, 'C-1')
    assert.match(out.created[1]!.number ?? '', /^STU-\d{6}$/)
    assert.deepEqual([out.parentsCreated, out.parentsLinked], [1, 1])
    const links = await withTenant(fx.tenantId, (ctx) => ctx.parentStudentLinks.find({ studentId: { $in: out.created.map((c) => c.id) } }).toArray())
    assert.equal(new Set(links.map((l) => l.parentId)).size, 1)
    const enrolled = await withTenant(fx.tenantId, (ctx) => ctx.enrollments.countDocuments({ studentId: { $in: out.created.map((c) => c.id) }, status: 'active' }))
    assert.equal(enrolled, 2)
    const audit = await withTenant(fx.tenantId, (ctx) => ctx.auditLog.findOne({ action: 'import.commit' }))
    assert.equal((audit!.meta as { created: number }).created, 2)
  })

  test('needs the create permission and the branch', async () => {
    const body = { branchId: fx.branchB, csv: csv(['X-1,A,B,Grade 5 A,,,,,']) }
    assert.equal((await call(fx.app, fx.tokens.viewer, 'POST', '/imports/students/preview', body)).error, 'FORBIDDEN')
    assert.equal((await call(fx.app, fx.scopedToken, 'POST', '/imports/students/commit', body)).error, 'BRANCH_FORBIDDEN')
    assert.equal((await call(fx.app, fx.tokens.admin, 'GET', '/imports/nope/template')).error, 'NOT_FOUND')
    const tpl = await fx.app.inject({ method: 'GET', url: '/imports/students/template', headers: { authorization: `Bearer ${fx.tokens.admin}` } })
    assert.equal(tpl.statusCode, 200)
    assert.match(tpl.body, /^﻿student_number,given_name,family_name/)
  })
})

describe('employee import', () => {
  test('matches departments and branches by name, and creates through HR', async () => {
    const hr = (await member(fx.tenantId, 'viewer', null, 'hr')).token
    const csv = ['first_name,last_name,hire_date,branch,department,position,email', 'Rana,Khalil,15/08/2024,Branch B,teaching,,rana@example.test', 'Sami,Odeh,,,,,', 'Lina,Haddad,2024-01-10,,Rocket science,,'].join('\n')
    const res = await call(fx.app, hr, 'POST', '/imports/employees/commit', { branchId: fx.branchA, csv })
    assert.equal(res.status, 200, res.error)
    const out = res.body as unknown as { created: { number: string | null }[]; failed: { line: number; errors: string[] }[] }
    assert.equal(out.created.length, 1)
    assert.match(out.created[0]!.number ?? '', /^EMP-/)
    assert.deepEqual(out.failed, [
      { line: 3, errors: ['HIRE_DATE_REQUIRED'] },
      { line: 4, errors: ['UNKNOWN_DEPARTMENT'] },
    ])
    const emp = await withTenant(fx.tenantId, (ctx) => ctx.employees.findOne({ email: 'rana@example.test' }))
    assert.equal(emp!.branchId, fx.branchB)
    assert.equal(emp!.hireDate, '2024-08-15')
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', '/imports/employees/preview', { branchId: fx.branchA, csv })).error, 'FORBIDDEN')
  })
})
