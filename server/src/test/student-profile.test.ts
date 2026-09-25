// SAMS 2.2: student profile — new fields, emergency contacts, admission
// source from the settings list, custody notes behind their own scope,
// record completeness (student, roster filter, dashboard) and the family
// endpoint.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { withTenant } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'

let fx: Fixture
let registrar: string

type Profile = {
  id: string
  preferredName: string | null
  nationality: string | null
  nationalId: string | null
  admissionSource: string | null
  emergencyContacts: { id: string; name: string }[]
  custodyNotes?: string | null
  completeness: { complete: boolean; missing: string[] }
  photoDocumentId: string | null
}

async function student(branchId = fx.branchA): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await withTenant(fx.tenantId, (ctx) =>
    ctx.students.insertOne({
      _id: id,
      studentNumber: `P-${id.slice(0, 8)}`,
      givenName: 'Profile',
      familyName: 'Student',
      branchId,
      classId: '',
      status: 'enrolled',
      guardians: [],
      primaryPhone: '',
      createdAt: now,
      updatedAt: now,
    } as never),
  )
  return id
}

const get = async (token: string, id: string) => (await call(fx.app, token, 'GET', `/students/${id}`)).body as Profile

async function upload(id: string, category: string) {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
  const res = await fx.app.inject({
    method: 'POST',
    url: `${config.routePrefix}/documents?ownerType=student&ownerId=${id}&category=${category}&fileName=f.png`,
    headers: { authorization: `Bearer ${fx.tokens.admin}`, 'content-type': 'application/octet-stream' },
    payload: png,
  })
  assert.equal(res.statusCode, 201)
  return (res.json() as { id: string }).id
}

const complete = {
  dob: '2015-03-02',
  gender: 'female',
  nationality: 'Jordanian',
  nationalId: '9981234567',
  address: 'Amman, Abdoun',
  primaryPhone: '0791234567',
  emergencyContacts: [{ name: 'Grandma Huda', relationship: 'grandmother', phone: '0797654321' }],
}

before(async () => {
  fx = await createFixture()
  registrar = (await member(fx.tenantId, 'viewer', null, 'registrar')).token
})
after(async () => {
  await fx.close()
})

describe('profile fields', () => {
  test('saves the new fields and gives emergency contacts stable ids', async () => {
    const id = await student()
    const res = await call(fx.app, fx.tokens.scheduler, 'PATCH', `/students/${id}`, {
      preferredName: 'Lulu',
      nationality: 'Jordanian',
      nationalId: '9981234567',
      previousSchool: 'Hill Primary',
      admissionSource: 'referral',
      emergencyContacts: [{ name: 'Grandma Huda', relationship: 'grandmother', phone: '0797654321' }],
    })
    assert.equal(res.status, 200, res.error)
    const saved = await get(fx.tokens.viewer, id)
    assert.equal(saved.preferredName, 'Lulu')
    assert.equal(saved.admissionSource, 'referral')
    const contactId = saved.emergencyContacts[0]!.id
    assert.ok(contactId)
    // Round-tripping keeps the id.
    await call(fx.app, fx.tokens.scheduler, 'PATCH', `/students/${id}`, { emergencyContacts: saved.emergencyContacts })
    assert.equal((await get(fx.tokens.viewer, id)).emergencyContacts[0]!.id, contactId)
    const audit = await withTenant(fx.tenantId, (ctx) =>
      ctx.auditLog.findOne({ action: 'emergencyContacts.update', entityId: id }),
    )
    assert.ok(audit)
  })

  test('the admission source must be an active code from the settings list', async () => {
    const id = await student()
    const res = await call(fx.app, fx.tokens.scheduler, 'PATCH', `/students/${id}`, { admissionSource: 'carrier_pigeon' })
    assert.equal(res.error, 'INVALID_ADMISSION_SOURCE')
    const list = await call(fx.app, fx.tokens.viewer, 'GET', '/settings/lookups/admissionSource')
    assert.ok((list.body as { items: { code: string }[] }).items.some((i) => i.code === 'sibling'))
  })

  test('search finds a student by national ID or preferred name', async () => {
    const id = await student()
    await call(fx.app, fx.tokens.scheduler, 'PATCH', `/students/${id}`, { nationalId: '5550001112', preferredName: 'Zizou' })
    for (const q of ['5550001112', 'zizou']) {
      const res = (await call(fx.app, fx.tokens.viewer, 'GET', `/students?search=${q}`)).body as { students: Profile[] }
      assert.deepEqual(
        res.students.map((s) => s.id),
        [id],
      )
    }
  })
})

describe('custody notes', () => {
  test('only students.custody sees or edits them, and the audit log never holds the text', async () => {
    const id = await student()
    const notes = 'Father may not collect — court order 2026/114'
    assert.equal(
      (await call(fx.app, fx.tokens.scheduler, 'PATCH', `/students/${id}`, { custodyNotes: notes })).error,
      'FORBIDDEN',
    )
    assert.equal((await call(fx.app, registrar, 'PATCH', `/students/${id}`, { custodyNotes: notes })).status, 200)

    assert.equal((await get(fx.tokens.admin, id)).custodyNotes, notes)
    assert.equal((await get(registrar, id)).custodyNotes, notes)
    const hidden = await get(fx.tokens.scheduler, id)
    assert.ok(!('custodyNotes' in hidden), 'absent, not null, without the scope')
    const listed = (await call(fx.app, fx.tokens.viewer, 'GET', '/students')).body as { students: Profile[] }
    assert.ok(listed.students.every((s) => !('custodyNotes' in s)))

    const audit = await withTenant(fx.tenantId, (ctx) =>
      ctx.auditLog.find({ action: 'student.update', entityId: id }).toArray(),
    )
    assert.ok(audit.length > 0)
    assert.ok(!JSON.stringify(audit).includes('court order'))
    assert.equal((audit[0]!.meta.after as { custodyNotes: string }).custodyNotes, '[redacted]')
  })
})

describe('record completeness', () => {
  test('lists what is missing until the record is complete', async () => {
    const id = await student()
    const empty = await get(fx.tokens.viewer, id)
    assert.equal(empty.completeness.complete, false)
    assert.deepEqual(empty.completeness.missing, [
      'dob',
      'gender',
      'nationality',
      'nationalId',
      'address',
      'primaryPhone',
      'guardian',
      'emergencyContact',
      'birthCertificate',
      'photo',
    ])

    await call(fx.app, fx.tokens.scheduler, 'PATCH', `/students/${id}`, complete)
    const parent = await call(fx.app, fx.tokens.admin, 'POST', '/parents', { fullName: 'Mum', primaryPhone: '0790001111' })
    const parentId = (parent.body as { parent: { id: string } }).parent.id
    await call(fx.app, fx.tokens.admin, 'POST', `/parents/${parentId}/links`, { studentId: id, relationshipType: 'mother' })
    const birth = await upload(id, 'birth_certificate')
    const photo = await upload(id, 'photo')

    const done = await get(fx.tokens.viewer, id)
    assert.deepEqual(done.completeness, { complete: true, missing: [] })
    assert.equal(done.photoDocumentId, photo)

    // A rejected birth certificate has to be provided again.
    await call(fx.app, fx.tokens.admin, 'POST', `/documents/${birth}/verify`, { status: 'rejected', note: 'Unreadable' })
    assert.deepEqual((await get(fx.tokens.viewer, id)).completeness.missing, ['birthCertificate'])
  })

  test('the roster filter and the dashboard count incomplete enrolled students, per branch', async () => {
    const a = await student(fx.branchA)
    const b = await student(fx.branchB)
    const inList = async (token: string, id: string) =>
      ((await call(fx.app, token, 'GET', '/students?incomplete=1')).body as { students: Profile[] }).students.some(
        (s) => s.id === id,
      )
    assert.ok(await inList(fx.tokens.viewer, a))
    assert.ok(!(await inList(fx.scopedToken, b)), 'another branch stays out')

    const dash = async (branchId: string) =>
      ((await call(fx.app, fx.tokens.admin, 'GET', `/dashboard/summary?branchId=${branchId}`)).body as {
        students: { enrolled: number; incomplete: number }
      }).students
    const before = await dash(fx.branchB)
    // Withdrawn records are history, not a task.
    await withTenant(fx.tenantId, (ctx) => ctx.students.findOneAndUpdate({ _id: b }, { $set: { status: 'withdrawn' } }))
    const afterWithdraw = await dash(fx.branchB)
    assert.equal(afterWithdraw.incomplete, before.incomplete - 1)
    assert.equal(afterWithdraw.enrolled, before.enrolled - 1)
  })
})

describe('family', () => {
  test('lists the linked parents with the link flags, inside the caller\'s branches', async () => {
    const id = await student(fx.branchB)
    const parent = await call(fx.app, fx.tokens.admin, 'POST', '/parents', { fullName: 'Dad', primaryPhone: '0790002222' })
    const parentId = (parent.body as { parent: { id: string } }).parent.id
    await call(fx.app, fx.tokens.admin, 'POST', `/parents/${parentId}/links`, {
      studentId: id,
      relationshipType: 'father',
      authorizedPickup: true,
    })
    const res = await call(fx.app, fx.tokens.viewer, 'GET', `/students/${id}/family`)
    const family = (res.body as { family: { parentId: string; relationshipType: string; authorizedPickup: boolean }[] })
      .family
    assert.equal(family.length, 1)
    assert.equal(family[0]!.parentId, parentId)
    assert.equal(family[0]!.relationshipType, 'father')
    assert.equal(family[0]!.authorizedPickup, true)
    assert.equal((await call(fx.app, fx.scopedToken, 'GET', `/students/${id}/family`)).error, 'BRANCH_FORBIDDEN')
  })
})
