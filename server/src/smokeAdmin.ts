/**
 * Manual verification script for the platform-admin / membership / API-key /
 * password-reset features — exercised once against a live server, not part
 * of `npm run smoke` (that suite covers the original tenant-isolation
 * guarantees; this one is throwaway verification for this session).
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4000'

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
  console.log('\n== platform admin ==')
  const adminLogin = await login('ci@example.test', 'ci-only-password-123')
  check('platform admin logs in with no tenant', adminLogin.status === 200 && adminLogin.body.tenant === null, adminLogin.body)
  check('platform admin flag is set', adminLogin.body.platformAdmin === true)
  const adminToken = adminLogin.body.accessToken as string

  const asRegularUser = await login('admin@northgate.test', 'admin123')
  const regularToken = asRegularUser.body.accessToken as string
  const forbidden = await call('/admin/tenants', {}, regularToken)
  check('a regular user cannot reach /admin', forbidden.status === 403, forbidden.body)

  const slug = `smoke-${Date.now().toString(36)}`
  const created = await call(
    '/admin/tenants',
    {
      method: 'POST',
      body: JSON.stringify({ slug, name: 'Smoke Test School', ownerEmail: `owner-${slug}@example.test` }),
    },
    adminToken,
  )
  check('platform admin creates a tenant', created.status === 201, created.body)
  check(
    'owner invite fails cleanly with no SMTP configured (expected in this test env)',
    created.body.ownerInvite === 'EMAIL_NOT_CONFIGURED',
    created.body,
  )
  const tenantId = created.body.id as string

  const list = await call('/admin/tenants', {}, adminToken)
  check(
    'the new tenant appears in the admin list',
    (list.body.tenants as Array<{ slug: string }>).some((t) => t.slug === slug),
  )

  const patched = await call(
    `/admin/tenants/${tenantId}`,
    { method: 'PATCH', body: JSON.stringify({ validUntil: '2030-01-01' }) },
    adminToken,
  )
  check('platform admin can record a payment (extend validUntil)', patched.body.validUntil === '2030-01-01', patched.body)

  const suspended = await call(
    `/admin/tenants/${tenantId}`,
    { method: 'PATCH', body: JSON.stringify({ status: 'suspended' }) },
    adminToken,
  )
  check('platform admin can suspend a tenant', suspended.body.status === 'suspended', suspended.body)

  console.log('\n== membership self-service (an existing user, no email needed) ==')
  // admin@riverside.test already has a working password, so inviting them
  // to northgate should just grant access immediately — no email needed.
  const invite = await call(
    '/memberships/invite',
    { method: 'POST', body: JSON.stringify({ email: 'admin@riverside.test', role: 'viewer' }) },
    regularToken,
  )
  check('inviting an existing user grants access directly (no email)', invite.body.outcome === 'added', invite.body)

  const crossLogin = await login('admin@riverside.test', 'admin123')
  // riverside's admin now belongs to two schools — expect the tenant picker.
  check('a user in two schools gets the tenant picker', crossLogin.status === 300, crossLogin.body)

  const asNorthgate = await login('admin@riverside.test', 'admin123')
  const pickNorthgate = await call('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@riverside.test', password: 'admin123', tenantSlug: 'northgate' }),
  })
  check(
    'picking the school logs in as that tenant',
    Boolean(pickNorthgate.body.tenant) && (pickNorthgate.body.tenant as { slug: string }).slug === 'northgate',
    pickNorthgate.body,
  )
  void asNorthgate

  const members = await call('/memberships', {}, regularToken)
  check(
    'membership list shows the newly added member',
    (members.body.members as Array<{ email: string }>).some((m) => m.email === 'admin@riverside.test'),
    members.body,
  )

  const viewerMember = (members.body.members as Array<{ userId: string; role: string }>).find(
    (m) => m.role === 'viewer',
  )!
  const roleChange = await call(
    `/memberships/${viewerMember.userId}`,
    { method: 'PATCH', body: JSON.stringify({ role: 'scheduler' }) },
    regularToken,
  )
  check('role can be changed', roleChange.status === 200, roleChange.body)

  const ownerLookup = (members.body.members as Array<{ userId: string; role: string }>).find(
    (m) => m.role === 'owner',
  )!
  const lastOwnerGuard = await call(
    `/memberships/${ownerLookup.userId}`,
    { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) },
    regularToken,
  )
  check('cannot demote the last owner', lastOwnerGuard.status === 409, lastOwnerGuard.body)

  console.log('\n== login rate limiting ==')
  for (let i = 0; i < 10; i++) {
    await login('admin@northgate.test', 'definitely-wrong')
  }
  const lockedOut = await login('admin@northgate.test', 'definitely-wrong')
  check('account locks out after repeated failures', lockedOut.status === 429, lockedOut.body)
  const lockedEvenWithRightPassword = await login('admin@northgate.test', 'admin123')
  check('lockout blocks even the correct password', lockedEvenWithRightPassword.status === 429)

  console.log('\n== password reset (SMTP not configured in this test env) ==')
  const forgot = await call('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@riverside.test' }),
  })
  check('forgot-password fails cleanly without SMTP configured', forgot.status === 501, forgot.body)

  console.log('\n== branches are console-provisioned ==')
  const northgate = (list.body.tenants as Array<{ id: string; slug: string }>).find((t) => t.slug === 'northgate')!
  const ngId = northgate.id

  const tenantBranchWrite = await call(
    '/branches',
    { method: 'POST', body: JSON.stringify({ name: 'X', code: 'x-nope' }) },
    regularToken,
  )
  check('the tenant-facing POST /branches is gone (console-only)', tenantBranchWrite.status === 404, tenantBranchWrite.body)

  const adminBranch = await call(
    `/admin/tenants/${ngId}/branches`,
    { method: 'POST', body: JSON.stringify({ name: 'North Annex', code: `annex-${Date.now().toString(36)}`, address: '12 School Rd' }) },
    adminToken,
  )
  check('the platform admin can provision a branch for a tenant', adminBranch.status === 201 && typeof adminBranch.body.id === 'string', adminBranch.body)
  const provisionedBranchId = adminBranch.body.id as string

  const adminBranchPatch = await call(
    `/admin/tenants/${ngId}/branches/${provisionedBranchId}`,
    { method: 'PATCH', body: JSON.stringify({ address: '99 New Rd', active: false }) },
    adminToken,
  )
  check('the platform admin can relocate / deactivate a branch', adminBranchPatch.body.address === '99 New Rd' && adminBranchPatch.body.active === false, adminBranchPatch.body)

  const tenantSeesIt = await call('/branches', {}, regularToken)
  check(
    'the tenant can read the provisioned branch',
    (tenantSeesIt.body.branches as Array<{ id: string }>).some((b) => b.id === provisionedBranchId),
    tenantSeesIt.body,
  )

  const otherTenantBranches = await call(`/admin/tenants/${tenantId}/branches`, {}, adminToken)
  check(
    'branch provisioning is per-tenant (the other tenant does not get it)',
    !(otherTenantBranches.body.branches as Array<{ id: string }>).some((b) => b.id === provisionedBranchId),
    otherTenantBranches.body,
  )

  console.log('\n== API keys (console-only "server key") ==')
  const tenantKeyWrite = await call(
    '/api-keys',
    { method: 'POST', body: JSON.stringify({ name: 'CI script', role: 'scheduler' }) },
    regularToken,
  )
  check('the tenant-facing /api-keys surface is gone (console-only)', tenantKeyWrite.status === 404, tenantKeyWrite.body)

  const keyCreate = await call(
    `/admin/tenants/${ngId}/api-keys`,
    { method: 'POST', body: JSON.stringify({ name: 'CI script', role: 'scheduler' }) },
    adminToken,
  )
  check('the platform admin can mint an API key for a tenant', keyCreate.status === 201 && typeof keyCreate.body.key === 'string', keyCreate.body)
  const apiKey = keyCreate.body.key as string
  const keyId = keyCreate.body.id as string

  const keyDataset = await call(`/datasets/api-key-test`, {
    method: 'PUT',
    headers: { 'X-Api-Key': apiKey },
    body: JSON.stringify({ baseRevision: 0, problem: { lessons: ['VIA-KEY'], timeslots: [] } }),
  })
  check('the minted key can push a dataset with no user login at all', keyDataset.status === 201 || keyDataset.status === 200, keyDataset.body)

  const keyList = await call(`/admin/tenants/${ngId}/api-keys`, {}, adminToken)
  check(
    'the key never appears in a listing, only its preview',
    (keyList.body.keys as Array<{ preview: string }>).every((k) => !k.preview.includes(apiKey)),
  )

  const revoke = await call(`/admin/tenants/${ngId}/api-keys/${keyId}`, { method: 'DELETE' }, adminToken)
  check('the platform admin can revoke a key', revoke.status === 204, revoke.body)

  const afterRevoke = await call(`/datasets/api-key-test`, {
    headers: { 'X-Api-Key': apiKey },
  })
  check('a revoked key is refused', afterRevoke.status === 401, afterRevoke.body)

  console.log('\n== audit log ==')
  const audit = await call('/audit-log', {}, regularToken)
  check('audit log has entries from the pushes above', ((audit.body.entries as unknown[]) ?? []).length > 0, audit.body)

  console.log('\n== sessions ==')
  const sessions = await call('/auth/sessions', {}, regularToken)
  check('sessions list returns at least one active session', ((sessions.body.sessions as unknown[]) ?? []).length > 0, sessions.body)

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
