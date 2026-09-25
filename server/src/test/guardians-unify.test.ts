// SAMS 2.3: the embedded student guardian list is retired. The migration
// moves every guardian onto a parent link (without touching hand-made
// links), absence notifications go to linked parents, and the student API
// no longer takes or returns guardians.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import { config } from '../config.js'
import { withTenant } from '../db.js'
import type { Guardian } from '../db.js'
import { retireEmbeddedGuardians } from '../backfill.js'
import { isSessionDay } from '../calendar.js'
import { call, createFixture, type Fixture } from './harness.js'

let fx: Fixture
let mongo: MongoClient

const guardian = (over: Partial<Guardian> & { name: string }): Guardian => ({
  id: randomUUID(),
  relationship: 'mother',
  phone: '',
  secondaryPhone: null,
  email: null,
  isPrimary: false,
  preferredLanguage: 'en',
  notifyByEmail: true,
  notifyBySms: false,
  active: true,
  ...over,
})

async function student(extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await withTenant(fx.tenantId, (ctx) =>
    ctx.students.insertOne({
      _id: id,
      studentNumber: `G-${id.slice(0, 8)}`,
      givenName: 'Guard',
      familyName: 'Ian',
      branchId: fx.branchA,
      classId: '',
      status: 'enrolled',
      createdAt: now,
      updatedAt: now,
      ...extra,
    } as never),
  )
  return id
}

async function parent(fields: Record<string, unknown>): Promise<string> {
  const res = await call(fx.app, fx.tokens.admin, 'POST', '/parents', { primaryPhone: '0790000000', ...fields })
  assert.equal(res.status, 201, res.error)
  return (res.body as { parent: { id: string } }).parent.id
}

async function link(parentId: string, studentId: string, fields: Record<string, unknown> = {}) {
  const res = await call(fx.app, fx.tokens.admin, 'POST', `/parents/${parentId}/links`, {
    studentId,
    relationshipType: 'mother',
    ...fields,
  })
  assert.equal(res.status, 201, res.error)
  const id = (res.body as { id: string }).id
  assert.ok(id)
  return id
}

before(async () => {
  fx = await createFixture()
  mongo = new MongoClient(config.databaseUrl)
  await mongo.connect()
})
after(async () => {
  await mongo.close()
  await fx.close()
})

describe('migration', () => {
  test('moves guardians onto parent links and freezes the old list', async () => {
    const mum = guardian({ name: 'Mona Migrate', phone: '+962 79 111 2222', email: 'mona@example.test', isPrimary: true, preferredLanguage: 'ar' })
    const dad = guardian({ name: 'Omar Migrate', relationship: 'father', phone: '0793334444', notifyByEmail: false, notifyBySms: true, active: false })
    const s = await student({ guardians: [mum, dad] })

    await retireEmbeddedGuardians(mongo.db())

    const state = await withTenant(fx.tenantId, async (ctx) => ({
      student: await ctx.students.findOne({ _id: s }),
      links: await ctx.parentStudentLinks.find({ studentId: s }).toArray(),
      parents: await ctx.parents.find({ fullName: { $in: ['Mona Migrate', 'Omar Migrate'] } }).toArray(),
    }))
    assert.equal(state.student?.guardians, undefined)
    assert.equal(state.student?.legacyGuardians?.length, 2)
    assert.equal(state.links.length, 2)
    const mona = state.parents.find((p) => p.fullName === 'Mona Migrate')!
    assert.equal(mona.preferredLanguage, 'ar')
    const monaLink = state.links.find((l) => l.parentId === mona._id)!
    assert.deepEqual(monaLink.communicationPermissions, { email: true, sms: false })
    assert.equal(monaLink.primaryContact, true)
    const omarLink = state.links.find((l) => l.parentId !== mona._id)!
    assert.deepEqual(omarLink.communicationPermissions, { email: false, sms: true })
    assert.equal(omarLink.active, false)
    assert.equal(omarLink.relationshipType, 'father')
  })

  test('matches an existing parent by phone and leaves a hand-made link as it is', async () => {
    const existing = await parent({ fullName: 'Hand Made', primaryPhone: '0795556666' })
    const s = await student()
    await link(existing, s, { communicationPermissions: { email: false, sms: false }, relationshipType: 'aunt' })
    await withTenant(fx.tenantId, (ctx) =>
      ctx.students.findOneAndUpdate(
        { _id: s },
        { $set: { guardians: [guardian({ name: 'Different Spelling', phone: '+962 79 555 6666', notifyBySms: true })] } },
      ),
    )

    await retireEmbeddedGuardians(mongo.db())

    const links = await withTenant(fx.tenantId, (ctx) => ctx.parentStudentLinks.find({ studentId: s }).toArray())
    assert.equal(links.length, 1, 'no duplicate parent or link')
    assert.equal(links[0]!.parentId, existing)
    assert.deepEqual(links[0]!.communicationPermissions, { email: false, sms: false })
    assert.equal(links[0]!.relationshipType, 'aunt')
  })

  test('brings an earlier backfill link up to date, and a rerun changes nothing', async () => {
    const g = guardian({ name: 'Earlier Backfill', phone: '0797778888', notifyByEmail: false, notifyBySms: true })
    const s = await student({ guardians: [g] })
    const p = await parent({ fullName: 'Earlier Backfill', primaryPhone: '0797778888' })
    const bfId = `${fx.tenantId}:bf:${s}:${g.id}`
    await mongo.db().collection('parentStudentLinks').insertOne({
      _id: bfId as never,
      tenantId: fx.tenantId,
      parentId: p,
      studentId: s,
      relationshipType: 'mother',
      primaryContact: false,
      secondaryContact: false,
      emergencyContact: false,
      authorizedPickup: false,
      financialResponsibility: false,
      communicationPermissions: { email: true, sms: false },
      portalAccess: false,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
    })

    await retireEmbeddedGuardians(mongo.db())
    const updated = await withTenant(fx.tenantId, (ctx) => ctx.parentStudentLinks.findOne({ _id: bfId }))
    assert.deepEqual(updated?.communicationPermissions, { email: false, sms: true })

    const again = await retireEmbeddedGuardians(mongo.db())
    assert.equal(again.students, 0)
    assert.equal(again.links, 0)
  })
})

describe('absence notifications', () => {
  test('go to active linked parents by their channel permissions and language', async () => {
    let date = '2026-09-01'
    while (!isSessionDay(null, date)) {
      date = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10)
    }
    const s = await student()
    const emailAr = await parent({ fullName: 'Email Arabic', email: 'ar@example.test', preferredLanguage: 'ar' })
    const smsOnly = await parent({ fullName: 'Sms Only', primaryPhone: '0791112233' })
    const archived = await parent({ fullName: 'Archived', email: 'gone@example.test' })
    const unlinked = await parent({ fullName: 'Unlinked', email: 'old@example.test' })
    await link(emailAr, s, { communicationPermissions: { email: true, sms: false } })
    await link(smsOnly, s, { communicationPermissions: { email: false, sms: true } })
    await link(archived, s)
    const oldLink = await link(unlinked, s)
    await call(fx.app, fx.tokens.admin, 'POST', `/parents/${archived}/archive`, { reason: 'Moved away' })
    const removed = await call(fx.app, fx.tokens.admin, 'POST', `/parents/${unlinked}/links/${oldLink}/deactivate`, { reason: 'Custody change' })
    assert.equal(removed.status, 200, removed.error)

    const settings = await call(fx.app, fx.tokens.admin, 'PUT', `/branches/${fx.branchA}/notification-settings`, {
      absenceNotifyEnabled: true,
      cutoffTime: '00:00',
      channels: ['email', 'sms'],
      notifyOnUnmarked: false,
      emailSubject: 'Absent: {studentName}',
      emailBody: '{studentName} was absent on {date}.',
      smsBody: '{studentName} absent {date}',
    })
    assert.equal(settings.status, 200, settings.error)
    await withTenant(fx.tenantId, (ctx) =>
      ctx.attendance.insertOne({ _id: randomUUID(), studentId: s, branchId: fx.branchA, classId: '', date, status: 'absent' } as never),
    )

    const run = await call(fx.app, fx.tokens.admin, 'POST', '/notifications/run', { branchId: fx.branchA, date, studentId: s })
    assert.equal(run.status, 200, run.error)

    const jobs = await withTenant(fx.tenantId, (ctx) => ctx.notificationJobs.find({ studentId: s }).toArray())
    const got = jobs.map((j) => [j.guardianName, j.channel, j.to, j.language]).sort()
    assert.deepEqual(got, [
      ['Email Arabic', 'email', 'ar@example.test', 'ar'],
      ['Sms Only', 'sms', '0791112233', 'en'],
    ])
  })
})

describe('student API', () => {
  test('refuses a guardian list, accepts an empty one, and returns none', async () => {
    const s = await student()
    const refused = await call(fx.app, fx.tokens.scheduler, 'PATCH', `/students/${s}`, {
      guardians: [{ name: 'X', relationship: 'mother', phone: '0790000000' }],
    })
    assert.equal(refused.error, 'GUARDIANS_MOVED')
    const empty = await call(fx.app, fx.tokens.scheduler, 'PATCH', `/students/${s}`, { guardians: [], address: 'Amman' })
    assert.equal(empty.status, 200, empty.error)
    assert.ok(!('guardians' in (empty.body as object)))
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'PATCH', `/students/${s}`, { guardians: [] })).error, 'EMPTY_UPDATE')
  })

  test('a parent keeps a preferred language', async () => {
    const id = await parent({ fullName: 'Lang Pref', preferredLanguage: 'ar' })
    const got = await call(fx.app, fx.tokens.viewer, 'GET', `/parents/${id}`)
    assert.equal((got.body as { preferredLanguage: string }).preferredLanguage, 'ar')
  })
})
