// SAMS 1.9: parents follow their children's branches. A branch-A member
// sees families with a child in A (and unlinked intake records), never a
// branch-B-only family — in lists, detail, search, edits and duplicate
// warnings.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withTenant } from '../db.js'
import { call, createFixture, member, type Fixture } from './harness.js'

let fx: Fixture
const ids = { studentA: '', studentB: '', pA: '', pB: '', pBoth: '', pNone: '' }
const phoneB = '0791111222'

async function parent(fullName: string, primaryPhone: string): Promise<string> {
  const res = await call(fx.app, fx.tokens.owner, 'POST', '/parents', { fullName, primaryPhone })
  assert.equal(res.status, 201, `create parent: ${res.error}`)
  return (res.body as { parent: { id: string } }).parent.id
}

async function link(parentId: string, studentId: string) {
  const res = await call(fx.app, fx.tokens.owner, 'POST', `/parents/${parentId}/links`, {
    studentId,
    relationshipType: 'mother',
  })
  assert.ok(res.status === 201 || res.status === 200, `link: ${res.status} ${res.error}`)
}

before(async () => {
  fx = await createFixture()
  ids.studentA = randomUUID()
  ids.studentB = randomUUID()
  const now = new Date()
  await withTenant(fx.tenantId, async (ctx) => {
    const rows: [string, string][] = [
      [ids.studentA, fx.branchA],
      [ids.studentB, fx.branchB],
    ]
    for (const [id, branchId] of rows) {
      await ctx.students.insertOne({
        _id: id,
        studentNumber: id.slice(0, 8),
        branchId,
        classId: '',
        status: 'enrolled',
        givenName: 'Kid',
        familyName: branchId === fx.branchA ? 'Alpha' : 'Beta',
        createdAt: now,
        updatedAt: now,
      } as never)
    }
  })
  ids.pA = await parent('Family Zed A', '0790000001')
  ids.pB = await parent('Family Zed B', phoneB)
  ids.pBoth = await parent('Family Zed Both', '0790000003')
  ids.pNone = await parent('Family Zed None', '0790000004')
  await link(ids.pA, ids.studentA)
  await link(ids.pB, ids.studentB)
  await link(ids.pBoth, ids.studentA)
  await link(ids.pBoth, ids.studentB)
})
after(async () => {
  await fx.close()
})

const listIds = async (token: string, query = '') => {
  const res = await call(fx.app, token, 'GET', `/parents${query}`)
  return new Set((res.body as { parents: { id: string }[] }).parents.map((p) => p.id))
}

describe('branch-confined parent visibility', () => {
  test('list shows own-branch, shared and unlinked families only', async () => {
    const scoped = await listIds(fx.scopedToken)
    assert.ok(scoped.has(ids.pA) && scoped.has(ids.pBoth) && scoped.has(ids.pNone))
    assert.ok(!scoped.has(ids.pB))
    const wide = await listIds(fx.tokens.scheduler)
    assert.ok(wide.has(ids.pB), 'tenant-wide caller still sees everyone')
  })

  test('a student-side filter cannot reach around the rule', async () => {
    const scoped = await listIds(fx.scopedToken, '?studentName=Beta')
    assert.ok(!scoped.has(ids.pB))
    // Matching on the shared family's branch-B child would reveal that child.
    assert.ok(!scoped.has(ids.pBoth), 'other-branch children cannot be probed by name')
    assert.ok((await listIds(fx.scopedToken, '?studentName=Alpha')).has(ids.pBoth))
  })

  test('detail of another branch family is refused', async () => {
    const res = await call(fx.app, fx.scopedToken, 'GET', `/parents/${ids.pB}`)
    assert.equal(res.error, 'BRANCH_FORBIDDEN')
  })

  test('a shared family shows only this branch child', async () => {
    const res = await call(fx.app, fx.scopedToken, 'GET', `/parents/${ids.pBoth}`)
    assert.equal(res.status, 200)
    const students = (res.body as { students: { studentId?: string; id?: string }[] }).students
    assert.equal(students.length, 1)
    const wide = await call(fx.app, fx.tokens.scheduler, 'GET', `/parents/${ids.pBoth}`)
    assert.equal((wide.body as { students: unknown[] }).students.length, 2)
  })

  test('edits and link changes on another branch family are refused', async () => {
    const patch = await call(fx.app, fx.scopedToken, 'PATCH', `/parents/${ids.pB}`, { notes: 'x' })
    assert.equal(patch.error, 'BRANCH_FORBIDDEN')
    const linkIt = await call(fx.app, fx.scopedToken, 'POST', `/parents/${ids.pB}/links`, {
      studentId: ids.studentA,
      relationshipType: 'father',
    })
    assert.equal(linkIt.error, 'BRANCH_FORBIDDEN')
  })

  test('linking an intake record to another branch child is refused, own branch works', async () => {
    const other = await call(fx.app, fx.scopedToken, 'POST', `/parents/${ids.pNone}/links`, {
      studentId: ids.studentB,
      relationshipType: 'father',
    })
    assert.equal(other.error, 'BRANCH_FORBIDDEN')
    const own = await call(fx.app, fx.scopedToken, 'POST', `/parents/${ids.pNone}/links`, {
      studentId: ids.studentA,
      relationshipType: 'father',
    })
    assert.equal(own.status, 201)
  })

  test('search hides another branch family', async () => {
    const res = await call(fx.app, fx.scopedToken, 'GET', '/search?q=Family%20Zed')
    const found = (res.body as { results: { type: string; id: string }[] }).results
      .filter((r) => r.type === 'parent')
      .map((r) => r.id)
    assert.ok(!found.includes(ids.pB))
    assert.ok(found.includes(ids.pA))
  })

  test('a duplicate in another branch warns without personal details', async () => {
    const res = await call(fx.app, fx.scopedToken, 'POST', '/parents', { fullName: 'New Person', primaryPhone: phoneB })
    assert.equal(res.status, 201)
    const warning = (res.body as { warnings: { id: string; restricted?: boolean; fullName: string }[] }).warnings.find(
      (w) => w.id === ids.pB,
    )
    assert.ok(warning?.restricted)
    assert.equal(warning?.fullName, '')
  })

  test('list filters stay inside the caller branches', async () => {
    const res = await call(fx.app, fx.scopedToken, 'GET', `/parents?branchId=${fx.branchB}`)
    assert.equal(res.error, 'BRANCH_FORBIDDEN')
    const list = await call(fx.app, fx.scopedToken, 'GET', '/parents')
    const both = (list.body as { parents: { id: string; linkedStudentCount: number }[] }).parents.find(
      (p) => p.id === ids.pBoth,
    )
    assert.equal(both?.linkedStudentCount, 1, 'sibling in another branch is not counted')
  })

  test('the other branch child link on a shared family cannot be edited', async () => {
    const wide = await call(fx.app, fx.tokens.owner, 'GET', `/parents/${ids.pBoth}`)
    const linkB = (wide.body as { students: { linkId: string; studentId: string }[] }).students.find(
      (s) => s.studentId === ids.studentB,
    )!.linkId
    const base = `/parents/${ids.pBoth}/links/${linkB}`
    const patch = await call(fx.app, fx.scopedToken, 'PATCH', base, { emergencyContact: true })
    assert.equal(patch.error, 'BRANCH_FORBIDDEN')
    const branchAdmin = (await member(fx.tenantId, 'viewer', [fx.branchA], 'branch_admin')).token
    assert.equal((await call(fx.app, branchAdmin, 'POST', `${base}/deactivate`, {})).error, 'BRANCH_FORBIDDEN')
  })

  test('the audit feed hides another branch family records', async () => {
    const branchAdmin = (await member(fx.tenantId, 'viewer', [fx.branchA], 'branch_admin')).token
    const res = await call(fx.app, branchAdmin, 'GET', '/audit-log?entity=parent')
    const entityIds = (res.body as { entries: { entityId: string }[] }).entries.map((e) => e.entityId)
    assert.ok(entityIds.includes(ids.pA), 'own-branch family is audited')
    assert.ok(!entityIds.includes(ids.pB))
  })

  test('a family whose links were all deactivated stays hidden', async () => {
    const wide = await call(fx.app, fx.tokens.owner, 'GET', `/parents/${ids.pB}`)
    const linkId = (wide.body as { students: { linkId: string }[] }).students[0]!.linkId
    const off = await call(fx.app, fx.tokens.owner, 'POST', `/parents/${ids.pB}/links/${linkId}/deactivate`, {})
    assert.equal(off.status, 200)
    assert.equal((await call(fx.app, fx.scopedToken, 'GET', `/parents/${ids.pB}`)).error, 'BRANCH_FORBIDDEN')
  })
})
