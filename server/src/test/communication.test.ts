// SAMS Phase 6: the notification service (6.1), announcements (6.2), fee
// reminders and family notices (6.3), and the parent portal (6.4).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { withTenant, withoutTenant } from '../db.js'
import { signAccessToken } from '../auth/tokens.js'
import { runDailyNotices } from '../communication/notices.js'
import { call, createFixture, member, type Fixture } from './harness.js'
import { financeFixture, type FinanceFixture } from './finance-fixture.js'

let fx: Fixture
let fin: FinanceFixture
let registrar: string

const PDF = Buffer.from('%PDF-1.7\n% test document\n')
const admin = () => fx.tokens.admin
const post = (path: string, body: unknown, token = admin()) => call(fx.app, token, 'POST', path, body)
const get = (path: string, token = admin()) => call(fx.app, token, 'GET', path)
const idOf = (res: { body: unknown }) => (res.body as { id: string }).id
const jobs = (filter: Record<string, unknown>) =>
  withTenant(fx.tenantId, (ctx) => ctx.notificationJobs.find(filter).toArray())

/** A parent on file, linked to `studentId`. */
async function family(
  studentId: string,
  opts: { email?: string | null; financial?: boolean; portal?: boolean; language?: 'en' | 'ar' } = {},
): Promise<string> {
  const email = opts.email === undefined ? `p-${studentId.slice(0, 8)}@family.test` : opts.email
  const parent = await post('/parents', {
    fullName: 'Huda Parent',
    primaryPhone: '0791234567',
    email,
    preferredLanguage: opts.language ?? 'en',
  })
  assert.equal(parent.status, 201, parent.error)
  const parentId = (parent.body as { parent: { id: string } }).parent.id
  const link = await post(`/parents/${parentId}/links`, {
    studentId,
    relationshipType: 'Mother',
    primaryContact: true,
    financialResponsibility: opts.financial ?? true,
    portalAccess: opts.portal ?? true,
    communicationPermissions: { email: true, sms: false },
  })
  assert.equal(link.status, 201, link.error)
  return parentId
}

/** Enables a parent's portal and returns a session token for that login. */
async function portalLogin(parentId: string): Promise<string> {
  const res = await post(`/parents/${parentId}/portal/enable`, {}, registrar)
  assert.equal(res.status, 200, res.error)
  const parent = await withTenant(fx.tenantId, (ctx) => ctx.parents.findOne({ _id: parentId }))
  const userId = parent!.portalAccess.userId!
  return signAccessToken({ sub: userId, email: parent!.email!, tenantId: fx.tenantId, role: 'viewer' })
}

before(async () => {
  fx = await createFixture()
  fin = await financeFixture(fx)
  registrar = (await member(fx.tenantId, 'viewer', null, 'registrar')).token
})
after(async () => {
  await fx.close()
})

describe('announcements', () => {
  test('reach the families of their audience, in-app and by email, once', async () => {
    const studentA = await fin.student(fx.branchA)
    const studentB = await fin.student(fx.branchB)
    const parentA = await family(studentA)
    await family(studentB)
    const portal = await portalLogin(parentA)

    const draft = await post('/announcements', {
      title: 'Sports day',
      body: 'Sports day is on Thursday.',
      titleAr: 'اليوم الرياضي',
      bodyAr: 'اليوم الرياضي يوم الخميس.',
      audience: { type: 'grade', branchId: fx.branchA, gradeLevels: ['Grade 5'] },
      channels: ['email'],
    })
    assert.equal(draft.status, 201, draft.error)
    const id = idOf(draft)
    assert.ok(((await get(`/announcements/${id}`)).body as { reach: number }).reach >= 1)

    const published = await post(`/announcements/${id}/publish`, {})
    assert.equal(published.status, 200, published.error)
    const sent = (published.body as { sent: { inApp: number; email: number } }).sent
    assert.ok(sent.inApp >= 1 && sent.email >= 1)
    assert.equal((await post(`/announcements/${id}/publish`, {})).error, 'NOT_DRAFT')
    assert.equal((await call(fx.app, admin(), 'PATCH', `/announcements/${id}`, { title: 'x' })).error, 'NOT_DRAFT')

    const mail = await jobs({ kind: 'announcement', sourceId: id })
    assert.ok(mail.every((j) => j.branchId === fx.branchA), 'branch B families are not in a branch A audience')

    const feed = (await get('/portal/announcements', portal)).body as { announcements: { id: string }[] }
    assert.ok(feed.announcements.some((a) => a.id === id))
    const inbox = (await get('/inbox', portal)).body as { items: { kind: string }[]; unread: number }
    assert.ok(inbox.items.some((i) => i.kind === 'announcement'))
    assert.ok(inbox.unread >= 1)

    await post(`/announcements/${id}/archive`, {})
    const after = (await get('/portal/announcements', portal)).body as { announcements: { id: string }[] }
    assert.ok(!after.announcements.some((a) => a.id === id), 'archived announcements leave the portal')
  })

  test('school-wide needs a tenant-wide caller; references must be in the branch', async () => {
    const schoolWide = { title: 'Holiday', body: 'Closed Monday.', audience: { type: 'school' } }
    assert.equal((await post('/announcements', schoolWide, fx.scopedToken)).error, 'FORBIDDEN')
    const branchAdmin = (await member(fx.tenantId, 'viewer', [fx.branchA], 'branch_admin')).token
    assert.equal((await post('/announcements', schoolWide, branchAdmin)).error, 'BRANCH_FORBIDDEN')
    const wrongClass = await post('/announcements', {
      ...schoolWide,
      audience: { type: 'class', branchId: fx.branchA, classIds: [fin.classOf[fx.branchB]] },
    })
    assert.equal(wrongClass.error, 'UNKNOWN_CLASS')
    const empty = await post('/announcements', { ...schoolWide, audience: { type: 'bus', branchId: fx.branchA, busIds: [] } })
    assert.equal(empty.error, 'AUDIENCE_EMPTY')
  })
})

describe('templates', () => {
  test('can be edited, switched off and reset', async () => {
    const list = (await get('/communication/templates')).body as { templates: { kind: string; customised: boolean }[] }
    assert.ok(list.templates.some((t) => t.kind === 'fee_reminder' && !t.customised))
    const off = await call(fx.app, admin(), 'PUT', '/communication/templates/payment_received', {
      enabled: false,
      subject: 'Paid',
      body: 'Paid {amount}',
      smsBody: 'Paid',
      subjectAr: '',
      bodyAr: '',
      smsBodyAr: '',
    })
    assert.equal(off.status, 200, off.error)

    const inv = await fin.invoice()
    await family(inv.studentId)
    await fin.pay(inv.id, 1000)
    assert.equal((await jobs({ kind: 'payment_received', studentId: inv.studentId })).length, 0, 'a switched-off kind sends nothing')

    const reset = await call(fx.app, admin(), 'DELETE', '/communication/templates/payment_received')
    assert.equal((reset.body as { enabled: boolean }).enabled, true)
    await fin.pay(inv.id, 1000)
    const sent = await jobs({ kind: 'payment_received', studentId: inv.studentId })
    assert.equal(sent.length, 1)
    assert.match(sent[0]!.body, /RCT-\d{6}/)
  })
})

describe('fee reminders', () => {
  test('go to the responsible parent for money falling due, not twice in a row', async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    const inv = await fin.invoice({ dueDate: soon })
    const parent = await family(inv.studentId, { financial: true })
    await family(inv.studentId, { financial: false, email: `other-${inv.id.slice(0, 6)}@family.test` })

    const preview = (await get(`/finance/reminders?branchId=${fx.branchA}`)).body as {
      invoices: { invoiceId: string; amountDue: number; recent: boolean }[]
    }
    const row = preview.invoices.find((r) => r.invoiceId === inv.id)
    assert.ok(row, 'due in two days is within the default three')
    assert.equal(row.amountDue, inv.total)

    const sent = await post('/finance/reminders/send', { invoiceIds: [inv.id] })
    assert.equal(sent.status, 200, sent.error)
    assert.equal((sent.body as { invoices: number }).invoices, 1)
    const mail = await jobs({ kind: 'fee_reminder', sourceId: inv.id })
    assert.deepEqual(
      mail.map((j) => j.guardianId),
      [parent],
      'only the parent responsible for fees',
    )

    const again = await post('/finance/reminders/send', { invoiceIds: [inv.id] })
    assert.equal((again.body as { skippedRecent: number }).skippedRecent, 1)
    assert.equal((await post('/finance/reminders/send', {}, fx.tokens.scheduler)).error, 'FORBIDDEN')
  })

  test('the daily run sends them when switched on, once a day', async () => {
    const soon = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const inv = await fin.invoice({ dueDate: soon })
    await family(inv.studentId)
    await call(fx.app, admin(), 'PUT', '/communication/settings', {
      feeReminders: { auto: true, daysBefore: 3, repeatDays: 7 },
    })
    const today = new Date().toISOString().slice(0, 10)
    assert.equal(await runDailyNotices(fx.tenantId, today), true)
    assert.equal((await jobs({ kind: 'fee_reminder', sourceId: inv.id })).length, 1)
    assert.equal(await runDailyNotices(fx.tenantId, today), false, 'once per day')
    await call(fx.app, admin(), 'PUT', '/communication/settings', {
      feeReminders: { auto: false, daysBefore: 3, repeatDays: 7 },
    })
  })
})

describe('notices', () => {
  test('a rejected student document asks the family for a new copy', async () => {
    const studentId = await fin.student()
    await family(studentId)
    const res = await fx.app.inject({
      method: 'POST',
      url: `${config.routePrefix}/documents?${new URLSearchParams({ ownerType: 'student', ownerId: studentId, category: 'medical', fileName: 'm.pdf' })}`,
      headers: { authorization: `Bearer ${admin()}`, 'content-type': 'application/octet-stream' },
      payload: PDF,
    })
    assert.equal(res.statusCode, 201)
    const docId = (res.json() as { id: string }).id
    await post(`/documents/${docId}/verify`, { status: 'rejected', note: 'Unreadable scan' })
    const mail = await jobs({ kind: 'document_rejected', sourceId: docId })
    assert.equal(mail.length, 1)
    assert.match(mail[0]!.body, /Unreadable scan/)
  })

  test('a decided approval lands in the requester inbox', async () => {
    const inv = await fin.invoice()
    const req = await post(
      '/approvals',
      {
        type: 'finance.lineDiscount',
        entityId: inv.id,
        payload: { lineItemId: inv.lineItems[0]!.id, discount: { type: 'percent', value: 10 }, expectedAmount: inv.lineItems[0]!.amount },
        comment: 'Sibling',
      },
      fx.tokens.scheduler,
    )
    assert.equal(req.status, 201, req.error)
    await post(`/approvals/${idOf(req)}/approve`, {})
    const inbox = (await get('/inbox?unread=true', fx.tokens.scheduler)).body as { items: { id: string; kind: string; title: string }[] }
    const item = inbox.items.find((i) => i.kind === 'approval_decided')
    assert.ok(item)
    assert.match(item.title, /approved/)
    await post(`/inbox/${encodeURIComponent(item.id)}/read`, {}, fx.tokens.scheduler)
    const unread = (await get('/inbox?unread=true', fx.tokens.scheduler)).body as { items: { id: string }[] }
    assert.ok(!unread.items.some((i) => i.id === item.id))
  })
})

describe('delivery log', () => {
  test('lists failures and retries one', async () => {
    const [job] = await jobs({ kind: 'payment_received' })
    assert.ok(job)
    await withTenant(fx.tenantId, (ctx) =>
      ctx.notificationJobs.findOneAndUpdate({ _id: job._id }, { $set: { status: 'dead', attempts: 3, lastError: 'EMAIL_NOT_CONFIGURED' } }),
    )
    const log = (await get('/communication/log?status=dead')).body as { entries: { id: string }[]; counts: { dead: number } }
    assert.ok(log.entries.some((e) => e.id === job._id))
    assert.ok(log.counts.dead >= 1)
    const retried = await post(`/communication/log/${encodeURIComponent(job._id)}/retry`, {})
    assert.equal(retried.status, 200, retried.error)
    assert.equal((retried.body as { status: string }).status, 'pending')
    assert.equal((await post(`/communication/log/${encodeURIComponent(job._id)}/retry`, {})).error, 'NOT_FAILED')
  })
})

describe('parent portal', () => {
  test('shows a parent only their own portal children, and finance only where responsible', async () => {
    const mine = await fin.invoice()
    const hidden = await fin.student()
    const notMine = await fin.student()
    const parentId = await family(mine.studentId, { financial: true, portal: true })
    // Linked, but the link doesn't grant the portal.
    await post(`/parents/${parentId}/links`, { studentId: hidden, relationshipType: 'Mother', portalAccess: false })
    const token = await portalLogin(parentId)

    const me = (await get('/portal/me', token)).body as { children: { id: string }[] }
    assert.deepEqual(
      me.children.map((c) => c.id),
      [mine.studentId],
    )
    assert.equal((await get(`/portal/children/${hidden}`, token)).error, 'NOT_FOUND')
    assert.equal((await get(`/portal/children/${notMine}`, token)).error, 'NOT_FOUND')

    await fin.pay(mine.id, 2000)
    const finance = (await get(`/portal/children/${mine.studentId}/finance`, token)).body as {
      balance: number
      receipts: { amount: number }[]
    }
    assert.equal(finance.balance, mine.total - 2000)
    assert.equal(finance.receipts[0]?.amount, 2000)

    // Staff pages stay closed to a parent.
    assert.equal((await get('/students', token)).error, 'FORBIDDEN')
    assert.equal((await get('/finance/invoices', token)).error, 'FORBIDDEN')
  })

  test('finance is hidden from a parent not responsible for fees', async () => {
    const studentId = await fin.student()
    const parentId = await family(studentId, { financial: false })
    const token = await portalLogin(parentId)
    assert.equal((await get(`/portal/children/${studentId}/finance`, token)).error, 'FINANCE_NOT_SHARED')
    assert.equal((await get(`/portal/children/${studentId}`, token)).status, 200)
  })

  test('documents: verified ones in shared categories only', async () => {
    const studentId = await fin.student()
    const parentId = await family(studentId)
    const token = await portalLogin(parentId)
    const upload = async (category: string) => {
      const res = await fx.app.inject({
        method: 'POST',
        url: `${config.routePrefix}/documents?${new URLSearchParams({ ownerType: 'student', ownerId: studentId, category, fileName: `${category}.pdf` })}`,
        headers: { authorization: `Bearer ${admin()}`, 'content-type': 'application/octet-stream' },
        payload: PDF,
      })
      return (res.json() as { id: string }).id
    }
    const birth = await upload('birth_certificate')
    const medical = await upload('medical')
    await post(`/documents/${medical}/verify`, { status: 'verified' })
    let docs = (await get(`/portal/children/${studentId}/documents`, token)).body as { documents: { id: string }[] }
    assert.equal(docs.documents.length, 0, 'unverified birth certificate and non-shared medical record')
    await post(`/documents/${birth}/verify`, { status: 'verified' })
    docs = (await get(`/portal/children/${studentId}/documents`, token)).body as { documents: { id: string }[] }
    assert.deepEqual(
      docs.documents.map((d) => d.id),
      [birth],
    )
    const link = await post(`/portal/documents/${birth}/link`, {}, token)
    assert.equal(link.status, 200, link.error)
    assert.equal((await post(`/portal/documents/${medical}/link`, {}, token)).error, 'NOT_FOUND')
  })

  test('enabling needs an email, refuses staff addresses, and disabling locks the login out', async () => {
    const studentId = await fin.student()
    const noEmail = await family(studentId, { email: null })
    assert.equal((await post(`/parents/${noEmail}/portal/enable`, {}, registrar)).error, 'EMAIL_REQUIRED')

    const staff = await withoutTenant(async (db) => {
      const m = await db.memberships.findOne({ tenantId: fx.tenantId, role: 'admin', roleKey: null })
      return db.users.findOne({ _id: m!.userId })
    })
    const clash = await family(studentId, { email: staff!.email })
    assert.equal((await post(`/parents/${clash}/portal/enable`, {}, registrar)).error, 'EMAIL_IS_STAFF')

    const parentId = await family(studentId)
    const enabled = await post(`/parents/${parentId}/portal/enable`, {}, registrar)
    const body = enabled.body as { account: string; emailSent: boolean; emailError: string | null }
    assert.equal(body.account, 'invited')
    assert.equal(body.emailSent, false)
    assert.equal(body.emailError, 'EMAIL_NOT_CONFIGURED')
    const token = await portalLogin(parentId)
    assert.equal((await get('/portal/me', token)).status, 200)

    // Parent logins aren't staff: not in Team settings, not editable there.
    const userId = (await withTenant(fx.tenantId, (ctx) => ctx.parents.findOne({ _id: parentId })))!.portalAccess.userId!
    const team = (await get('/memberships', fx.tokens.owner)).body as { members: { userId: string }[] }
    assert.ok(!team.members.some((m) => m.userId === userId))
    assert.equal((await call(fx.app, fx.tokens.owner, 'PATCH', `/memberships/${userId}`, { role: 'admin' })).error, 'PORTAL_ACCOUNT')
    assert.equal((await call(fx.app, fx.tokens.owner, 'DELETE', `/memberships/${userId}`)).error, 'PORTAL_ACCOUNT')

    const off = await post(`/parents/${parentId}/portal/disable`, {}, registrar)
    assert.equal((off.body as { account: string }).account, 'disabled')
    assert.equal((await get('/portal/me', token)).error, 'FORBIDDEN', 'the old token no longer works')
    assert.equal((await get('/inbox', token)).error, 'FORBIDDEN')
  })
})
