// SAMS 2.1: documents — upload with type sniffing, owner-based access and
// branch isolation, versions, verification, archive, and signed file links.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { withTenant } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'

let fx: Fixture
let other: Fixture
let registrar: string
let branchAdminA: string
const ids = { studentA: '', studentB: '', parentB: '' }

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rest of a png')])
const PDF = Buffer.from('%PDF-1.7\n% test document\n')

type Doc = {
  id: string
  version: number
  isCurrent: boolean
  mime: string
  fileName: string
  verification: { status: string; byName: string | null; note: string | null }
  uploadedByName: string | null
  archivedAt: string | null
}

async function upload(
  token: string,
  query: Record<string, string>,
  body: Buffer = PNG,
  path = '/documents',
): Promise<{ status: number; error?: string; doc: Doc }> {
  const res = await fx.app.inject({
    method: 'POST',
    url: `${config.routePrefix}${path}?${new URLSearchParams(query)}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    payload: body,
  })
  const json = res.json() as Doc & { error?: string }
  return { status: res.statusCode, error: json.error, doc: json }
}

const forStudent = (studentId: string, extra: Record<string, string> = {}) => ({
  ownerType: 'student',
  ownerId: studentId,
  category: 'birth_certificate',
  fileName: 'birth.png',
  ...extra,
})

const list = async (token: string, ownerId: string, ownerType = 'student', archived = false) =>
  call(
    fx.app,
    token,
    'GET',
    `/documents?ownerType=${ownerType}&ownerId=${ownerId}${archived ? '&includeArchived=1' : ''}`,
  )

async function fetchFile(token: string) {
  return fx.app.inject({ method: 'GET', url: `${config.routePrefix}/documents/file?token=${encodeURIComponent(token)}` })
}

before(async () => {
  fx = await createFixture()
  other = await createFixture()
  registrar = (await member(fx.tenantId, 'viewer', null, 'registrar')).token
  branchAdminA = (await member(fx.tenantId, 'viewer', [fx.branchA], 'branch_admin')).token
  ids.studentA = randomUUID()
  ids.studentB = randomUUID()
  const now = new Date()
  await withTenant(fx.tenantId, async (ctx) => {
    for (const [id, branchId] of [
      [ids.studentA, fx.branchA],
      [ids.studentB, fx.branchB],
    ] as const) {
      await ctx.students.insertOne({
        _id: id,
        studentNumber: id.slice(0, 8),
        branchId,
        classId: '',
        status: 'enrolled',
        givenName: 'Doc',
        familyName: 'Student',
        createdAt: now,
        updatedAt: now,
      } as never)
    }
  })
  const parent = await call(fx.app, fx.tokens.owner, 'POST', '/parents', {
    fullName: 'Parent of B',
    primaryPhone: '0795550001',
  })
  ids.parentB = (parent.body as { parent: { id: string } }).parent.id
  await call(fx.app, fx.tokens.owner, 'POST', `/parents/${ids.parentB}/links`, {
    studentId: ids.studentB,
    relationshipType: 'father',
  })
})
after(async () => {
  await other.close()
  await fx.close()
})

describe('upload', () => {
  test('stores the file with its detected type and lists it', async () => {
    const res = await upload(fx.tokens.admin, forStudent(ids.studentA, { fileName: '../../etc/birth.png' }))
    assert.equal(res.status, 201, res.error)
    assert.equal(res.doc.mime, 'image/png')
    assert.equal(res.doc.fileName, 'birth.png', 'path segments are dropped')
    assert.equal(res.doc.version, 1)
    assert.equal(res.doc.verification.status, 'unverified')
    assert.equal(res.doc.uploadedByName, 'admin')
    const listed = (await list(fx.tokens.viewer, ids.studentA)).body as { documents: Doc[] }
    assert.ok(listed.documents.some((d) => d.id === res.doc.id))
  })

  test('the type comes from the bytes: unknown content is refused, empty too', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>')
    assert.equal((await upload(fx.tokens.admin, forStudent(ids.studentA), html)).error, 'UNSUPPORTED_FILE_TYPE')
    assert.equal((await upload(fx.tokens.admin, forStudent(ids.studentA), Buffer.alloc(0))).error, 'EMPTY_FILE')
    const pdf = await upload(fx.tokens.admin, forStudent(ids.studentA, { fileName: 'r.pdf' }), PDF)
    assert.equal(pdf.doc.mime, 'application/pdf')
  })

  test('the category must be an active documentCategory code', async () => {
    const res = await upload(fx.tokens.admin, forStudent(ids.studentA, { category: 'nope' }))
    assert.equal(res.error, 'INVALID_CATEGORY')
  })

  test('only documents.upload may upload: a registrar yes, a scheduler no', async () => {
    assert.equal((await upload(fx.tokens.scheduler, forStudent(ids.studentA))).error, 'FORBIDDEN')
    assert.equal((await upload(fx.tokens.viewer, forStudent(ids.studentA))).error, 'FORBIDDEN')
    assert.equal((await upload(registrar, forStudent(ids.studentA))).status, 201)
  })

  test('an unknown owner is 404', async () => {
    assert.equal((await upload(fx.tokens.admin, forStudent(randomUUID()))).error, 'OWNER_NOT_FOUND')
  })

  test('a file over the limit is refused', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(config.maxDocumentBytes)])
    assert.equal((await upload(fx.tokens.admin, forStudent(ids.studentA), big)).status, 413)
  })
})

describe('branch isolation', () => {
  test('a branch-A admin cannot see, upload to, or open a branch-B student\'s documents', async () => {
    const docB = (await upload(fx.tokens.admin, forStudent(ids.studentB))).doc
    assert.equal((await upload(branchAdminA, forStudent(ids.studentB))).error, 'BRANCH_FORBIDDEN')
    assert.equal((await list(branchAdminA, ids.studentB)).error, 'BRANCH_FORBIDDEN')
    assert.equal((await call(fx.app, branchAdminA, 'POST', `/documents/${docB.id}/link`, {})).error, 'BRANCH_FORBIDDEN')
    assert.equal((await call(fx.app, branchAdminA, 'GET', `/documents/${docB.id}/versions`)).error, 'BRANCH_FORBIDDEN')
    assert.equal((await upload(branchAdminA, forStudent(ids.studentA))).status, 201)
  })

  test('parent documents follow the children\'s branches', async () => {
    const res = await upload(fx.tokens.admin, {
      ownerType: 'parent',
      ownerId: ids.parentB,
      category: 'id_copy',
      fileName: 'id.pdf',
    }, PDF)
    assert.equal(res.status, 201, res.error)
    assert.equal((await list(fx.tokens.viewer, ids.parentB, 'parent')).status, 200)
    assert.equal((await list(branchAdminA, ids.parentB, 'parent')).error, 'BRANCH_FORBIDDEN')
  })

  test('another tenant cannot reach a document by id', async () => {
    const doc = (await upload(fx.tokens.admin, forStudent(ids.studentA))).doc
    assert.equal((await call(other.app, other.tokens.owner, 'POST', `/documents/${doc.id}/link`, {})).error, 'NOT_FOUND')
    assert.equal((await call(other.app, other.tokens.owner, 'GET', `/documents/${doc.id}/versions`)).error, 'NOT_FOUND')
  })
})

describe('versions', () => {
  test('a new version keeps the old one in history and resets verification', async () => {
    const v1 = (await upload(fx.tokens.admin, forStudent(ids.studentA, { category: 'medical' }))).doc
    await call(fx.app, fx.tokens.admin, 'POST', `/documents/${v1.id}/verify`, { status: 'verified' })
    const v2 = await upload(fx.tokens.admin, { fileName: 'medical-2.pdf' }, PDF, `/documents/${v1.id}/versions`)
    assert.equal(v2.status, 201, v2.error)
    assert.equal(v2.doc.version, 2)
    assert.equal(v2.doc.verification.status, 'unverified')
    const listed = ((await list(fx.tokens.viewer, ids.studentA)).body as { documents: Doc[] }).documents
    assert.ok(listed.some((d) => d.id === v2.doc.id))
    assert.ok(!listed.some((d) => d.id === v1.id), 'only the current version is listed')
    const history = (await call(fx.app, fx.tokens.viewer, 'GET', `/documents/${v1.id}/versions`)).body as {
      versions: Doc[]
    }
    assert.deepEqual(
      history.versions.map((d) => [d.version, d.isCurrent]),
      [
        [2, true],
        [1, false],
      ],
    )
    const stale = await upload(fx.tokens.admin, { fileName: 'x.png' }, PNG, `/documents/${v1.id}/versions`)
    assert.equal(stale.error, 'NOT_CURRENT_VERSION')
  })

  test('two concurrent replacements: exactly one wins', async () => {
    const v1 = (await upload(fx.tokens.admin, forStudent(ids.studentA))).doc
    const results = await Promise.all(
      [1, 2].map(() => upload(fx.tokens.admin, { fileName: 'r.png' }, PNG, `/documents/${v1.id}/versions`)),
    )
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409])
  })
})

describe('verification', () => {
  test('rejecting needs a note; verifying records who', async () => {
    const doc = (await upload(fx.tokens.admin, forStudent(ids.studentA))).doc
    const url = `/documents/${doc.id}/verify`
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', url, { status: 'verified' })).error, 'FORBIDDEN')
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, { status: 'rejected' })).error, 'NOTE_REQUIRED')
    const rejected = await call(fx.app, registrar, 'POST', url, { status: 'rejected', note: 'Blurry scan' })
    assert.equal((rejected.body as Doc).verification.note, 'Blurry scan')
    const verified = (await call(fx.app, fx.tokens.admin, 'POST', url, { status: 'verified' })).body as Doc
    assert.equal(verified.verification.status, 'verified')
    assert.equal(verified.verification.byName, 'admin')
  })
})

describe('archive', () => {
  test('needs a reason, hides the document, keeps every version', async () => {
    const v1 = (await upload(fx.tokens.admin, forStudent(ids.studentA, { category: 'other' }))).doc
    const v2 = (await upload(fx.tokens.admin, { fileName: 'b.png' }, PNG, `/documents/${v1.id}/versions`)).doc
    const url = `/documents/${v2.id}/archive`
    assert.equal((await call(fx.app, fx.tokens.scheduler, 'POST', url, { reason: 'Wrong file' })).error, 'FORBIDDEN')
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, {})).error, 'REASON_REQUIRED')
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, { reason: 'Wrong file' })).status, 204)
    assert.equal((await call(fx.app, fx.tokens.admin, 'POST', url, { reason: 'Again' })).error, 'ARCHIVED')

    const visible = ((await list(fx.tokens.viewer, ids.studentA)).body as { documents: Doc[] }).documents
    assert.ok(!visible.some((d) => d.id === v2.id))
    const all = ((await list(fx.tokens.viewer, ids.studentA, 'student', true)).body as { documents: Doc[] }).documents
    assert.ok(all.find((d) => d.id === v2.id)?.archivedAt)
    const stored = await withTenant(fx.tenantId, (ctx) =>
      ctx.documents.find({ _id: { $in: [v1.id, v2.id] } }).toArray(),
    )
    assert.equal(stored.length, 2)
    assert.ok(stored.every((d) => d.archivedAt))
    const audit = await withTenant(fx.tenantId, (ctx) =>
      ctx.auditLog.findOne({ action: 'document.archive', entityId: ids.studentA }),
    )
    assert.equal(audit?.reason, 'Wrong file')
  })
})

describe('file links', () => {
  test('a link serves the exact bytes with safe headers, and is audited', async () => {
    const doc = (await upload(fx.tokens.admin, forStudent(ids.studentA, { fileName: 'شهادة.png' }))).doc
    const link = await call(fx.app, fx.tokens.viewer, 'POST', `/documents/${doc.id}/link`, { download: true })
    assert.equal(link.status, 200)
    const token = (link.body as { token: string }).token
    const res = await fetchFile(token)
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.rawPayload, PNG)
    assert.equal(res.headers['content-type'], 'image/png')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.match(String(res.headers['content-disposition']), /^attachment; .*filename\*=UTF-8''%D8/)
    const opened = await withTenant(fx.tenantId, (ctx) =>
      ctx.auditLog.findOne({ action: 'document.open', 'meta.documentId': doc.id }),
    )
    assert.ok(opened)
  })

  test('a tampered token, or a session token, is not a file link', async () => {
    const doc = (await upload(fx.tokens.admin, forStudent(ids.studentA))).doc
    const token = ((await call(fx.app, fx.tokens.viewer, 'POST', `/documents/${doc.id}/link`, {})).body as {
      token: string
    }).token
    const [h, p, s] = token.split('.')
    const flipped = `${h}.${p}.${s!.slice(0, -2)}${s!.endsWith('AA') ? 'BB' : 'AA'}`
    assert.equal((await fetchFile(flipped)).statusCode, 401)
    assert.equal((await fetchFile(fx.tokens.admin)).statusCode, 401)
    assert.equal((await fetchFile('not-a-token')).statusCode, 401)
    // …and a file link is not a session.
    assert.equal((await call(fx.app, token, 'GET', '/students')).error, 'INVALID_TOKEN')
  })
})
