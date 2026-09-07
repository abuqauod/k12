# K-12 Server

Multi-tenant backend for the timetable sync, built so the rest of a school ERP
can grow on the same foundation. Fastify + Node.js + MongoDB.

```bash
cp .env.example .env          # then change every secret
docker compose up -d db
npm install
npm run migrate               # creates indexes — safe to re-run anytime
npm run seed                  # two demo schools, so isolation can be tested
npm run dev                   # http://localhost:4000
npm run smoke                 # end-to-end checks against a running API
```

Full stack in one command: `docker compose up --build`.

## Deploying to shared hosting (Hostinger hPanel / cPanel Node.js Selector)

This is the path for a typical shared host (Hostinger, Namecheap, GoDaddy, A2,
etc.) — no Docker, and no MongoDB offered natively, so the database lives on a
free external host (**MongoDB Atlas**) that the app is simply pointed at.

**1. Create a free MongoDB Atlas cluster.** Sign up at
[atlas.mongodb.com](https://atlas.mongodb.com), create an M0 (free) cluster,
add a database user, and under Network Access allow `0.0.0.0/0` — a shared
host's outbound IP isn't fixed, so you can't allowlist a single address.
Atlas gives you a connection string:
```
mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/timetable?retryWrites=true&w=majority
```

**2. Build a release bundle** on your own machine (no Docker or MongoDB
needs to be installed locally to do this — it only compiles TypeScript):

```bash
npm install
npm run release
```

This produces `release/timetable-server.zip` — compiled `dist/`, a trimmed
`package.json` (production dependencies only), and a `DEPLOY.md` with the
same steps below. It deliberately excludes `node_modules/`: the native
argon2 module has to be built for the host's own OS/CPU, not copied from
Windows or macOS.

**3. Upload and extract** the zip somewhere *outside* `public_html` (or
whatever your domain's document root is) — the app's files, including `.env`,
must not be directly downloadable over the web.

**4. Create the Node.js app.** Hostinger hPanel: **Advanced → Node.js** (only
on Business plan and above — Starter/Single-tier shared hosting has no
Node.js option at all). cPanel: **Setup Node.js App**.
- Application root: the folder you extracted to
- Application startup file: `dist/server.js`
- Node.js version: 20 LTS or newer (the app needs Node ≥ 20.6)
- Application mode: Production

**5. Set environment variables.** Either in the panel's "Environment
Variables" section for the app, or in a `.env` file next to `package.json`
(copy `.env.example`) — both are read; the panel's own settings win if both
are set. At minimum:

```
DATABASE_URL=mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/timetable?retryWrites=true&w=majority
JWT_SECRET=<openssl rand -base64 48>
CORS_ORIGINS=https://your-frontend-domain.com
```

**6. Click "Run NPM Install"** in the Node.js app screen. This is the step
that compiles the native argon2 binary for the server's own Linux build — do
this even though `node_modules/` wasn't uploaded.

**7. Run the index setup.** Open the app's terminal button (or SSH in, if
your plan includes it) and run, from the app's folder:

```bash
npm run migrate
npm run seed   # optional: two demo schools, so isolation can be exercised
```

There's no schema to migrate — `npm run migrate` only creates indexes — so
unlike a SQL migration, it's safe to run again after every future deploy.

**8. Restart the app**, then check `https://<your-app-domain>/health`
returns `{"ok":true}`.

### Troubleshooting

- **No Node.js option in the panel at all** — that plan tier doesn't support
  it. Hostinger requires Business Web Hosting or above; on cPanel it depends
  on the host enabling the Node.js Selector.
- **`MongoServerSelectionError` / connection timeout** — almost always Atlas's
  Network Access list. Confirm `0.0.0.0/0` (or your host's actual egress IP,
  if you can get it) is allowed.
- **argon2 errors on login** ("no native build available") — `node_modules`
  wasn't installed on the server itself, or was copied from your dev
  machine. Re-run "Run NPM Install" from the Node.js app screen.
- **Connections refused / pool exhausted** — Atlas's free (M0) tier caps
  total connections (around 500, but shared/burstable tiers can be much
  lower under load). Lower `MONGO_POOL_MAX` in `.env` if you hit this.
- **CORS errors in the browser** — `CORS_ORIGINS` must exactly match the
  frontend's origin(s), comma-separated, including the scheme
  (`https://...`).

## Isolation

Shared database, `tenantId` on every tenant-scoped document. There is no
MongoDB equivalent of Postgres row-level security — no server-side policy can
reject a query for lacking a tenant filter — so this is enforced structurally
in application code instead of by the database. Stated plainly, because it's
a real trade-off and not just a footnote:

1. Every tenant-scoped read or write goes through `TenantScope`
   (`src/db.ts`), which merges `tenantId` into every filter and every
   inserted document. A handler cannot phrase a query that omits it — there
   is no parameter to leave out, structurally, the same way you can't forget
   to pass an argument a function doesn't accept.
2. Every write runs inside a MongoDB transaction (Atlas's free tier is a
   replica set, so this works there too) — no half-applied write is visible
   to a concurrent read.
3. The tenant id itself comes only from the verified JWT (`request.auth.tenantId`),
   never from a URL parameter or request body.

The one place this is **weaker** than the Postgres version it replaced:
Postgres's `FORCE ROW LEVEL SECURITY` caught a bug even in code that bypassed
the application layer entirely (a raw migration, an ad-hoc script) — the
database itself refused the query. Here, a bug inside `TenantScope` itself,
or a handler that reaches for a raw `db.collection(...)` instead of the
scoped accessor, is not caught by anything outside that code. `src/db.ts` is
the one file in this codebase that deserves the scrutiny the database used
to provide for free — `datasets`, `datasetVersions` and `auditLog` are only
ever exposed through `TenantScope`, never as raw collections, specifically
to keep that mistake structurally hard to make.

Verified against a real database (see the smoke suite): two tenants writing
to the *same* document key get back only their own document, a stale write
is refused with a 409 and the current server copy, and every accepted write
is retained in `datasetVersions`.

### Adding an ERP or CRM collection later

```ts
// 1. Add the doc shape to src/db.ts, tenantId required like the others.
// 2. Expose it through TenantScope in `withTenant`'s TenantContext —
//    never as a raw db.collection('students') a handler could reach around.
// 3. Index it in src/schema.ts:
await db.collection('students').createIndex({ tenantId: 1, familyName: 1 })
```

### The one deliberate exception

Login has to answer "which schools does this person belong to?" *before* a
tenant is known. The Postgres version needed a `SECURITY DEFINER` function to
ask this without loosening RLS generally. Here there's no policy to work
around: `withoutTenant` (also in `src/db.ts`) gives raw access to exactly
four collections — `tenants`, `users`, `memberships`, `refreshTokens` — for
the handful of operations that are legitimately tenant-less (authenticating
by email, reading a tenant's subscription status, this membership lookup).
`datasets`, `datasetVersions` and `auditLog` are never reachable through it.

## Auth

- argon2id password hashing (`memoryCost` 19456, ~50 ms).
- Access token: 15-minute JWT carrying `sub`, `tenantId`, `role`. The tenant is
  a **claim, not a URL parameter**, so a caller cannot request another school by
  editing a path.
- Refresh token: opaque random string, **only its SHA-256 is stored**, rotated
  on every use. Presenting an already-rotated token means it leaked, so the
  whole family for that user is revoked rather than just refusing the request.
  Verified live: reusing a rotated token revokes every token issued after it too.
- Unknown email and wrong password return an identical 401, so the endpoint
  cannot be used to enumerate staff.
- Roles ranked `viewer < scheduler < admin < owner`; writes need `scheduler`.
- Expired refresh tokens age themselves out of the database via a MongoDB TTL
  index (`src/schema.ts`) rather than needing a cleanup job.

## Subscriptions (offline payment)

`tenants` carries `status`, `validUntil` and `graceDays`. `requireActiveSubscription`
returns **402** once a tenant is past `validUntil + graceDays`, or if status is
not `active`. Bank transfers are slow, so the default grace is 21 days — a school
that has paid is never locked out while the transfer clears, and an expired one
loses *sync*, never its local data.

Payment itself is entirely offline: you record it, the software honours it.

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/login` | 300 + tenant list if the user belongs to several schools |
| POST | `/auth/refresh` | rotates; reuse revokes the family |
| POST | `/auth/logout` | revokes one refresh token |
| GET | `/auth/me` | |
| GET | `/datasets/:key` | 404 when the tenant has never pushed |
| PUT | `/datasets/:key` | `{ baseRevision, problem }` → 200/201, or **409 with the server copy** |
| GET | `/datasets/:key/versions` | history list |
| GET | `/datasets/:key/versions/:revision` | one past document |

`:key` scopes a document inside the tenant, so a trust can hold several campuses
— or a school several draft scenarios — with no schema change.

A 409 is a normal outcome of two people editing, not an error, and carries the
current server document so the client can merge or take theirs. It's
implemented with a single atomic `findOneAndUpdate` filtered on
`{ key, revision: baseRevision }` — no explicit lock, no race between the
check and the write.

The timetable document is stored as an opaque field. The server deliberately
does not validate lessons: the solver owns those rules, and a server that
half-understood them would need redeploying for every domain change.

## Scale notes

- One document per school read by `_id` (`${tenantId}:${key}`) — a single
  point lookup, no query planning. The whole document is read and written
  together, which is why it's one document rather than several joined
  collections.
- `datasetVersions` is append-only and indexed `(tenantId, key, revision desc)`.
- When one cluster is no longer enough, `tenantId` is the shard key; every
  tenant-scoped document's `_id` already begins with it, so a hashed or
  ranged shard key on `tenantId` keeps a school's documents co-located.
- Documents can still be indexed into more deeply later
  (`db.collection('datasets').createIndex({ 'problem.calendar.weekStart': 1 })`)
  without a migration.

## Not done yet

- No automated test suite. `npm run smoke` covers the guarantees end to end but
  is not a substitute for unit tests.
- No rate limiting on `/auth/login`.
- No admin endpoints for creating tenants or recording payments — seed only.
