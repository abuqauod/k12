# SAMS Roadmap — School Administration Management System

**Product direction**: an administration-first system (registrar, finance, HR,
front office, operations). **Not an LMS** — no courses, lesson content,
learning paths, or teaching tools. Academic references (year, grade, class,
enrollment) exist only where administration needs them. Phase 11 adds a
gradebook and report cards on request: marks and printed results, which
administration issues, not teaching tools.

This document is the phased build plan. It supersedes the "Recommended build
order" in [`sms-gap-analysis.md`](sms-gap-analysis.md), which remains the
per-area status reference.

## Where we are

**Phases 1–7 and the backlog extras are shipped and on `main`. Phases 8–12
(production, security, polish, pilot, new modules) and Phase 13 (the SaaS
offer) are planned below.**

| Phase | Slices | PRs |
|---|---|---|
| 1 — Administration foundation | 1.1–1.6: permission scopes, subscription status, audit log, dashboard overview, global search. Transport moved to a real backend (off-plan, #30, #34) | #25–#27, #36, #37 |
| 1 — Closeout | 1.7 test harness · 1.8 admin roles · 1.9 parent branch isolation · 1.10 approvals · 1.11 settings · 1.12 audit/search/dashboard | #40, #42–#44, #46, #49, #50, #52 |
| 2 — Student administration | 2.1 documents · 2.2 student profile · 2.3 guardian models · 2.4 enrollment · 2.5 admissions · 2.6 year-end re-enrollment | #53, #55, #56, #58, #59, #61 |
| 3 — Finance administration | 3.1–3.6 | #60, #61 |
| 4 — HR & staff | 4.1–4.6 | #62 |
| 5 — Operations | 5.1–5.6 | #62 |
| 6 — Communication & portals | 6.1–6.4 | #64 |
| 7 — Reporting | 7.1–7.4 | #65–#67 |
| Backlog — extras | numbering, health/clinic, discipline, bulk import, ID cards; email/SMS delivery | #68 |

## Definition of done (every slice)

Schema + indexes in `schema.ts`, migration/backfill where existing data is
affected, Zod validation, `requirePermission` server-side, branch isolation,
`recordAudit` on every mutation, UI wired to the real API with
loading/empty/error states, EN + AR strings, automated tests for the
workflow **and** its permission/branch boundaries, green production build, no
existing API broken. No mock data to make a screen look complete.

All new collections follow `db.ts`'s isolation model: `tenantId` field,
access only through `TenantScope`/`withTenant`.

---

## Phase 1 closeout — foundation gaps

Gaps found by checking the shipped Phase 1 against the SAMS spec. These come
first because every later phase depends on them.

### 1.7 Test harness + finish the permission migration
- **Why**: the spec's definition of done requires permission-boundary and
  branch-isolation tests; today there are only `smoke.ts` scripts. 11 routes
  still use `requireRole` directly (academicYears, classes, datasets,
  enrollments, finance, memberships, notifications, parents, attendance).
- **Build**: `node:test` + `tsx` runner against a disposable test database;
  helpers to create a tenant, branches, and a caller per role. Migrate every
  remaining `requireRole` call site to `requirePermission` — behavior-neutral,
  proven by tests written *before* the migration.
- **Tests**: a scope × role matrix per route; branch-scoped caller cannot read
  or write another branch's records.

### 1.8 Administrative roles + granular scopes
- **Why**: a finance officer cannot be given finance access today without also
  getting student and parent write access. The spec names Registrar,
  Finance, HR, Operations, Reception, Branch Admin, School Admin, Super Admin.
- **Model**: `MembershipDoc` gains `roleKey` (named role preset). The existing
  rank `role` stays as the trust level (who can grant whom, legacy checks);
  scopes resolve from `roleKey` when present, else from the rank bundle — no
  existing member changes behavior.
- **Scopes**: split coarse `module.write` into actions where the spec needs
  it: `students.create/update/delete`, `enrollments.create/withdraw/transfer`,
  `finance.invoice.create`, `finance.payment.create`, `finance.payment.void`,
  `finance.refund.approve`, `finance.discount.approve`, `reports.finance`,
  `documents.upload/delete`, `approvals.decide`, `hr.*` (reserved).
- **UI**: role picker in member management with a read-only scope preview.
- **Tests**: each preset's allowed/denied matrix; rank rules for granting still hold.

### 1.9 Branch isolation for parents
- **Why**: `ParentDoc` has no branch, so a branch-scoped user sees every
  family — the exact case spec §10 forbids.
- **Build**: a branch-scoped caller sees a parent only when linked to at least
  one student in their branches (derived from links, not a copied field).
  Unlinked parents are visible to tenant-wide callers only. Applies to
  `/parents`, parent detail, and `/search`.

### 1.10 Approval workflow engine
- **Why**: admissions, refunds, scholarships, discounts, expenses, leave and
  document verification all need approvals; spec §22 requires one shared
  mechanism instead of one per module.
- **Model**: `ApprovalRequestDoc` — `type`, `entity`/`entityId`, `branchId`,
  `status` (pending/approved/rejected/cancelled), `requestedBy`, `decidedBy`,
  `comments[]`, `payload` snapshot. Modules register a type with its required
  scope and an `onApproved` handler.
- **UI**: an Approvals queue page (filter by type/branch/status) and an
  approval panel reusable inside any detail view.
- **Tests**: requester cannot approve own request; scope + branch enforced on
  decide; every transition audited.

### 1.11 Centralized settings
- **Why**: settings are spread across pages; `settings.manage` is declared
  but unused.
- **Build**: one Settings area with sections: Organization, Branches,
  Academic years, Grades & classes (links to existing pages), Payment methods,
  Document categories, Notification templates (placeholder until Phase 6),
  Roles. Lookup lists (categories, methods) share one
  `LookupDoc { kind, code, label, labelAr, active }` collection so later
  phases add a `kind` rather than a new settings model.

### 1.12 Audit, search, dashboard completion
- **Audit**: capture IP and user agent; required `reason` on sensitive actions
  (void, withdraw, delete, refund); check coverage against spec §17's action list.
- **Search**: add enrollments, invoices, payments (permission-filtered).
- **Dashboard**: parents card (total, multi-child, incomplete), enrollment
  card (active, withdrawals, transfers this year), recent activity from the
  audit log, pending approvals count.

---

## Phase 2 — Student Administration

### 2.1 Documents foundation
- **Why first**: admissions, student records, staff, finance and expenses
  all attach documents.
- **Storage**: MongoDB GridFS (no new infrastructure) behind a small
  `DocumentStore` interface so object storage can replace it later.
- **Model**: `DocumentDoc` — `ownerType`/`ownerId`, `branchId`, `categoryCode`
  (lookup), `fileName`, `mime`, `size`, `version`, `expiresAt`,
  `verification` (unverified/verified/rejected), `uploadedBy`, `archivedAt`.
  New upload of the same slot = new version, old kept.
- **Access**: download only via short-lived signed tokens; never a
  predictable public URL. Read access follows the owner entity's permission
  and branch.
- **Built** (student and parent owners): links are 5-minute signed JWTs,
  not `actionTokens`. Those are single-use, and a PDF preview makes several
  range requests. Uploads are raw bytes (no multipart dependency); the file
  type is taken from the bytes (PDF/PNG/JPEG/WebP only). New scope
  `documents.verify`. Staff and application owners come with Phases 4 and
  2.5.
- **UI**: reusable Documents panel (upload, preview image/PDF, verify,
  archive, version history).

### 2.2 Student profile expansion
- Add preferred name, nationality, national ID, admission source, previous
  school, profile photo (via 2.1), structured emergency contacts.
- Custody/pickup restriction notes, visible only with a dedicated scope.
- A **record completeness** check (drives the dashboard "incomplete records" card).
- Live financial summary (balance, invoices, payments, discounts) computed
  from Finance — never stored on the student.
- Student detail becomes a full page with tabs: Profile, Family, Enrollment
  history, Finance, Documents, Activity (audit).
- **Built**: new scope `students.custody` (admins, registrars); custody
  text is never written to the audit log. Admission source is a settings
  list (`admissionSource`). Completeness items: date of birth, gender,
  nationality, national ID, address, primary phone, a parent or guardian,
  an emergency contact, a birth certificate and a photo that aren't
  rejected. Only enrolled students count. The photo is the student's
  current `photo` document, not a separate field. The student dialog is
  gone; `/students/:id` replaces it.

### 2.3 Unify the guardian models
- Absence notifications switch from `StudentDoc.guardians` to
  `ParentStudentLinkDoc.communicationPermissions`; backfill any embedded
  guardian not yet represented as a link; stop writing the embedded array.
  Removes the documented dual-model debt.
- **Built**: `retireEmbeddedGuardians` (migrate.ts) moves every guardian
  onto a parent link, then renames the list to `legacyGuardians` (history,
  never read). Hand-made links are left alone; links from the earlier
  backfill take the guardian's current opt-ins. Phones match on their last
  nine digits. Parents gain a preferred language. The student API refuses a
  guardian list (`GUARDIANS_MOVED`). Absence-alert channels are switched
  per child on the parent. Also fixed: backfilled link ids (~130 chars)
  were over Fastify's 100-character path parameter limit, so those links
  could not be edited or removed.

### 2.4 Enrollment expansion
- Add `pending` status, withdrawal reason codes (lookup), re-enrollment as a
  new row (history never overwritten), and a DB-enforced rule of one active
  enrollment per student per academic year.
- **Built**: statuses `pending` (a planned place; leaves the student's
  class alone) and `cancelled`. `POST /students/:id/enrollments` plans a
  place or re-enrolls as a new row; `/enrollments/:id/activate` and
  `/cancel`. The existing one-active-per-student index stays, plus one
  open (active or pending) row per student per academic year. Withdrawal
  reasons are a settings list (`withdrawalReason`); a note alone counts as
  "other". Also fixed: enrollment history wasn't branch-checked.

### 2.5 Admissions
- `ApplicationDoc` (applicant, guardians, requested branch/grade/year, source,
  status: draft → submitted → under review → accepted/rejected/waitlisted →
  converted), required-documents checklist (2.1), decision via the approval
  engine (1.10).
- Conversion creates the Student, parent links and a `pending` Enrollment in
  one audited operation — no retyping.
- UI: applications table, detail with checklist and decision panel.
- **Built**: statuses as above plus `withdrawn`; the checklist is a per-
  application list of documentCategory codes (default: birth certificate,
  photo, previous report); accepting needs each present and not rejected.
  Scopes: admissions.read / admissions.manage (schedulers, registrars,
  reception) and admissions.decide (admins). Conversion reuses a parent on
  file by phone, creates the student as `inquiry` ("Admitted") with a
  pending enrollment, and moves the documents. Intake staff may upload an
  applicant's documents with admissions.manage.

### 2.6 Year-end re-enrollment
- Bulk move eligible students to the next academic year (promote / hold back
  / graduate / withdraw), with a preview before commit; creates new
  enrollment rows only.
- **Built**: plan (proposal with suggestions → preview → all-or-nothing
  commit: planned places for promote/hold, graduate/withdraw close the old
  year on its last day), then "start the new year" activates every planned
  place and closes old rows as `completed`. Class names are now unique per
  academic year (the old index ignored the year, so next year's "Grade 2 A"
  couldn't be created).

---

## Phase 3 — Finance Administration
3.1 Installment plans · 3.2 Discount types + formal scholarships (approval via
1.10, documents via 2.1) · 3.3 Refunds (request → approve → pay out, capped at
the refundable amount) · 3.4 Payment allocation across invoices + payment
confirmations · 3.5 Expenses, categories, vendors (with approval) · 3.6
Finance reports (revenue, collections, aging, overdue, discounts,
scholarships, refunds, expenses, net position).

**Built** (server and UI; Finance page tabs, the invoice dialog, and the
student's Finance tab):
- 3.1 An invoice can carry dated installments (even split or explicit) that
  add up to its total. Paid / part paid / due / overdue is worked out on
  read, oldest installment first. A later line change flags the plan.
- 3.2 Discount types are a price list applied to an invoice as adjustments,
  directly (`finance.discount.approve`) or through an approval. Scholarships
  are one student and year, raised with a reason and documents, approved by
  someone else (`finance.scholarship.approve`). They apply to every invoice of
  that year, including later ones; where more was already paid, the difference
  is a refundable credit. Revoking one takes it off invoices with nothing paid.
- 3.3 Refunds: request → approve → pay out (`finance.payout`), capped at what
  the invoice received less refunds paid or in progress, re-checked at each
  step. Only a paid refund reduces the paid total. A void invoice can be
  refunded.
- 3.4 One payment spread over a student's invoices (oldest due first, or an
  explicit split), one receipt. Cheques and transfers can be recorded as
  awaiting confirmation (`finance.payment.confirm`). Until confirmed they
  count for nothing and have no receipt.
- 3.5 Expenses with categories (settings list `expenseCategory`), vendors,
  approval (`finance.expense.approve`), payment, and attached receipts.
- 3.6 `GET /finance/reports/summary`: revenue (gross, discounts,
  scholarships, billed), collections by method, refunds, expenses by
  category, net position (cash basis), aging and overdue as of today.
- The approval engine gained `insertRequest` (raise a request in the
  caller's transaction) and `onClosed`, so records with their own status
  follow a rejection or cancellation.

## Phase 4 — HR & Staff
4.1 Employee record separate from `MembershipDoc` (optional link to a login)
· 4.2 Departments, positions, contracts, renewals, employment history ·
4.3 Staff documents (2.1) · 4.4 Leave types, balances, requests (1.10) ·
4.5 Staff attendance · 4.6 HR reports.

**Built** (server and UI; the HR page, the employee page, and "My leave" in
Account settings):
- 4.1 Employees (`EMP-` numbers) with an optional link to one login each.
  Terminating needs a reason, ends open contracts and cancels future leave;
  rehire starts a new history entry.
- 4.2 Departments, positions and contract types are settings lists. Contracts
  can't overlap; a renewal starts the day after the old one ends. Salary is
  hidden without `hr.salary.read`. Every change lands in the employment history.
- 4.3 Employee documents use 2.1, with new categories contract, certificate
  and licence.
- 4.4 Leave types (annual 14, sick 14, emergency 3, unpaid unlimited by
  default), balances per year (entitlement + adjustments − approved −
  pending), working days counted from the branch calendar. Requests go through
  the approval engine (`hr.leave`); nobody decides their own. Linked staff can
  request and cancel their own leave.
- 4.5 A daily staff attendance sheet per branch; approved leave shows as leave.
- 4.6 `GET /hr/reports/summary`: headcount, contracts ending, expiring staff
  documents, leave taken by type.
- New scopes `hr.attendance.write`, `hr.leave.approve`, `hr.salary.read`,
  `reports.hr` (admins and the `hr` preset).

## Phase 5 — Operations
5.1 Assets and lifecycle (purchase → assignment → maintenance → transfer →
disposal) · 5.2 Inventory, suppliers, stock movements · 5.3 Facilities,
buildings, rooms, maintenance requests · 5.4 Transport administration
(drivers, vehicle/driver documents, insurance/registration expiry, transport
fees) · 5.5 Library administration (copies, loans, overdue, fines) · 5.6
Events and activities (registration, capacity, attendance, costs).

**Built** (server and UI; the Operations, Library, Events and Fleet pages):
- 5.1 Assets (`AST-` numbers): assign to a person or room, return, maintenance,
  transfer between branches, dispose (reason required). Every step is kept as
  an asset event.
- 5.2 Stock items per branch with reorder levels; movements receive / issue /
  adjust / transfer, never below zero. Suppliers are the finance vendors.
- 5.3 Buildings and rooms; maintenance requests (`MNT-` numbers) from open to
  closed. An asset under repair follows its request, and whoever reported a
  request may cancel it while it's open.
- 5.4 Bus paperwork (registration, insurance, inspection), drivers with
  licence expiry and an optional employee link, a compliance list, and
  transport fees billed onto invoices.
- 5.5 Books and copies, loans to students or staff with a loan limit and
  renewals, fines for late returns that block new loans until paid or waived.
- 5.6 Events from draft to completed, registration with capacity and a
  waitlist, attendance, costs, and the event fee billed onto invoices.
- The dashboard has a "Needs attention" card: payments to confirm, refunds
  and expenses to pay, contracts ending, open maintenance, low stock, overdue
  loans and expiring transport papers, each shown only with its read scope.
- New scopes `ops.read`, `ops.events.manage`, `ops.library.manage`,
  `ops.maintenance.report` (schedulers and up) and `ops.assets.manage`,
  `ops.facilities.manage`, `ops.inventory.manage` (admins); the `operations`
  preset has them all.

## Phase 6 — Communication & Portals
6.1 General notification service over the existing queue: templates (EN/AR),
in-app channel, read state, failure tracking · 6.2 Announcements by
branch/grade/class/route · 6.3 Fee reminders and payment/admission/document
notices · 6.4 Parent portal (parent login, strictly linked-students-only
data, invoices, payments, permitted documents, announcements).

**Built** (server and UI; the Communication page, the notification bell, the
parent record's portal panel, and the parent portal at `/portal`):
- 6.1 One template per message kind in English and Arabic (a blank Arabic
  text falls back to the English), editable and switchable off per school.
  Every family notice goes through one service: in-app for parents with a
  portal login whose link grants the portal, email/SMS through the existing
  queue for parents who opted in. Keys are deterministic, so repeating a
  notice sends nothing new. The delivery log shows every message with its
  status and failure reason, and a failed one can be retried. Staff and
  parents share one inbox; an approval decision reaches the requester there.
- 6.2 Announcements by school, branch, grades, classes or bus (students at
  stops pinned to it): draft, publish once, archive. The students it reached
  are fixed when it is published; the portal shows it to those families.
  A school-wide announcement needs a tenant-wide caller.
- 6.3 Fee reminders for money due within N days or overdue (installments
  counted oldest first), to the parents responsible for fees, at most every
  `repeatDays` per invoice; preview and send by hand, or daily when switched
  on. Automatic notices: payment receipts, admission decisions (to the
  applicant's primary guardian), rejected and expiring student documents.
- 6.4 A `parent` preset whose only scope is `portal.parent`, given by
  enabling the portal on a parent record with an email (invite link to set a
  password; an existing account just gains access). It can't be picked or
  edited in Team settings. A parent sees only children whose link grants the
  portal; fees only where they are responsible for them; documents only
  verified ones in the categories the school shares. Disabling removes the
  membership and revokes sessions at once.
- New scopes `announcements.manage` (admins, registrar, operations),
  `finance.reminders` (admins, finance officer), `portal.manage` (admins,
  registrar, reception) and `portal.parent`. Also fixed: a session whose
  membership was removed kept its rank's scopes until the token expired; it
  now has none.

## Phase 7 — Reporting
7.1 Shared reporting service/queries (replace per-page calculations) · 7.2
Report catalog with branch/year/date/grade/class/status filters · 7.3 CSV,
Excel, PDF and print output · 7.4 Scheduled report exports.

**Built** (server and UI; the Reports page at `/reports`):
- 7.1 `server/src/reports/`: the finance summary (3.6) and HR summary (4.6)
  moved into shared queries, and one `receivables` function (balance after
  payments and refunds, overdue per installment, aging) now feeds the
  finance summary, the catalog and the dashboard. The dashboard's finance
  tiles came from a browser-side sum of open invoices' totals (ignoring part
  payments and installments); they now come from the server.
- 7.2 A catalog of 14 table reports: student roster, enrollment by class,
  withdrawals and transfers, attendance by student and by class, admissions
  by grade, outstanding balances, payments received, billing by grade,
  expenses, staff list, leave, maintenance and library loans. Each declares
  its scopes (the module's read scope, or `reports.finance` / `reports.hr`)
  and which filters it takes (branch, year, dates, grade, class, status); a
  member sees only the reports they may run, over their own branches.
  Labels and values come in English or Arabic.
- 7.3 CSV (UTF-8 with BOM, formula-safe), Excel (.xlsx written by a small
  zip writer — no new dependency; right-to-left in Arabic, frozen header,
  money and percentage formats, totals row) and a print page that the
  browser saves as PDF. PDF is deliberately the browser's: it shapes Arabic
  correctly, which a hand-built PDF would not. Every export and download is
  in the audit log.
- 7.4 Scheduled exports (new scope `reports.schedule`: admins, registrar,
  finance officer, HR): a report, its filters, a relative period (yesterday,
  last 7/30 days, this or last month, year to date, the academic year),
  daily/weekly/monthly, CSV or Excel, English or Arabic. The sweep runs what
  is due as the owner, re-reading their access each time (a removed owner
  or one who lost the scope stops the export). Recipients must be able to
  run the same report over the same branches, checked when saved and again
  on every run. The file goes to the document store (last 12 kept per
  schedule); each recipient gets an inbox item and an email through the
  Phase 6 queue (`report_ready` template) linking to "My files".

---

---

## Phase 8 — Production readiness
8.1 Boot checks: refuse to start in production with missing or default
secrets, and report which optional channels (email, SMS, payments) are off ·
8.2 `/health` (alive) and `/ready` (database reachable) for the proxy and
monitors; graceful shutdown that finishes requests and stops the workers ·
8.3 Request ids in every log line and error response; optional error
reporting to a Sentry-compatible DSN · 8.4 Rate limits on sign-in, password
reset and public endpoints; security headers · 8.5 Backups: a scheduled
`mongodump` with retention, optional copy to S3-compatible storage, a
restore script and a documented restore drill · 8.6 Deployment checklist
and a fixed deploy workflow (the UI docroot is still a placeholder).

**Built**:
- 8.1 `server/src/runtime/preflight.ts`: a production start exits on a
  missing, default or short `JWT_SECRET` or the default MongoDB password,
  warns on local `APP_URL`/`CORS_ORIGINS` and missing backups, and logs
  which channels (email, SMS, error reporting) are on.
- 8.2 `/live` (process), `/health` and `/ready` (database; 503 while
  shutting down, with uptime and release). SIGTERM stops the sweeper,
  drains requests and exits within `SHUTDOWN_GRACE_MS`. The compose API
  restarts on failure and has a health check.
- 8.3 A request id on every request (the proxy's `X-Request-Id` kept when
  sane) in logs and the `x-request-id` header. Unexpected errors answer
  `{ error: "INTERNAL", requestId }` — never the message — and go to a
  Sentry-compatible DSN when set (no SDK; no bodies or headers sent).
  Malformed JSON is now a 400, not a 500.
- 8.4 Per-IP limits on sign-in, reset, invites and refresh (429
  `RATE_LIMITED`) on top of the per-account lockout; `nosniff`,
  `SAMEORIGIN`, referrer policy, HSTS in production. The app no longer
  signs a user out when a token refresh fails for a network or server
  reason — only when the server rejects the session.
- 8.5 `scripts/backup.sh` / `restore.sh` and a daily `backup` service:
  gzipped `mongodump`, retention, optional S3-compatible copy; restore
  needs `RESTORE_CONFIRM=yes`, or rehearses into another database.
  Rehearsed on the dev database (52k documents, 63 collections).
- 8.6 [`docs/deployment-checklist.md`](deployment-checklist.md); CI now also
  lints and builds the school app; the deploy's docroot comes from the
  `UI_DOCROOT` secret and a deploy fails unless the new API answers
  `/ready`.

## Phase 9 — Security and permissions review
9.1 A route inventory test: every registered route must appear in the
permission matrix, so a new route cannot ship without its scope and branch
rows · 9.2 Cross-tenant and cross-branch sweep over every read, list,
export, search and file download · 9.3 Parent portal exposure: only the
parent's own children, only released data · 9.4 Sensitive data (health,
discipline, salaries): who sees it, what the audit log and exports carry ·
9.5 Fix everything found; findings and fixes listed here.

**Built**:
- 9.1 `test/routes.test.ts` lists every route the server registers and
  fails when one has no row in the permission matrix
  (`test/routeMatrix.ts`) and no stated exemption. **Found**: 14 routes
  had no row (student delete, school profile, dashboard, lookups, the
  inbox, approvals), and the school team routes (`/memberships`) and the
  platform console API (`/admin/*`) had no permission tests at all. All
  now have rows; the console API is checked to refuse every school rank,
  owner included.
- 9.2 `test/isolation-sweep.test.ts` makes records in branch B (student,
  family, invoice, payment, receipt, employee, clinic visit, incident,
  asset, maintenance, application, health profile), each carrying a
  marker, then calls every read route — each record id put into every
  route parameter, list routes with branch/student filters, all 16
  reports and their CSV exports, search — about 750 requests per caller.
  An admin confined to branch A and the owner of another school receive
  no marker and no id. **Found**: nothing; a parent with no linked child
  is visible to every branch, which is the documented rule.
- 9.3 The same sweep as a parent portal login of another family (which
  does see its own): nothing.
- 9.4 Sensitive data swept per role: medical details not marked as alerts
  reach only the nurse (and admins); salaries only HR (and admins);
  incidents only their reporter and `discipline.manage`. Checked that the
  sweep does find each for the role meant to see it. File links and
  sessions are separate tokens; uploads are typed by content, served
  `nosniff`.
- Found and fixed along the way (Phase 8): malformed JSON answered 500;
  an error could return Fastify's own message to the client.

## Phase 10 — Polish
10.1 Arabic/RTL pass over every screen added since Phase 5 · 10.2 Phone
layouts for the pages staff use on the move (attendance, clinic, behaviour,
gate, portal) · 10.3 Large schools: a 3,000-student demo tenant, timings for
the heavy lists and reports, indexes and paging where they are slow.

**Built**:
- 10.1 Every page checked in Arabic at desktop and phone width (a browser
  script flags page overflow, anything wider than the screen, raw
  translation keys, and errors). All right-to-left, nothing overflowing.
  **Found**: audit actions showed as codes (`invoice.installments.set`) on
  the dashboard, the student's Activity tab and the audit log; they now
  read "Invoice › Installments · Set" / «فاتورة › أقساط · تعيين»
  (`lib/auditLabels.ts`, the code kept as a tooltip). `/hr/me` answered
  404 for everyone without an employee record, filling the console; it
  now answers `{ employee: null }`.
- 10.2 Phone layouts: no page scrolls sideways; wide tables scroll inside
  their card.
- 10.3 `server/src/perf.ts` builds a school through the real routes (3,000
  students, 1,500 families, 3,000 invoices, 40 days × 96 classes of
  attendance = 120,000 marks) and times 25 heavy reads. Before → after:
  attendance by class 1.8 s → 0.49 s and by student 1.75 s → 0.82 s (the
  counting moved into MongoDB via a new tenant-scoped `aggregate`, which
  refuses `$lookup`/`$unionWith`/`$out`/`$merge`; it had also been
  copying each group's array on every mark). Everything else is under
  0.4 s; the full student and invoice lists are ~3 MB of JSON, so Caddy
  now compresses responses (`encode zstd gzip`).

## Phase 11 — New modules
11.1 **Online fee payment**: a payment-provider interface with PayTabs and
HyperPay first (hosted payment page, signed callbacks, reconciliation into
the Phase 3 receipts, refunds through the provider); parents pay open
invoices from the portal · 11.2 **Gradebook and report cards**: subjects
per grade, terms and assessments with weights, marks entry per class,
grading scales, report cards printed and released to the portal ·
11.3 **Library**: catalogue with copies, loans and returns by barcode (the
ID cards'), limits, overdue notices and fines into billing · 11.4
**Canteen / student wallet**: a prepaid balance per student, top-up at the
office or online (11.1), sales at the canteen by card scan, daily limits
and parent-set restrictions, statements in the portal.

**Built — 11.1 online fee payment** (`server/src/payments/`):
- One provider interface; **PayTabs** (hosted page, signed callbacks,
  query, refund; regions Jordan/UAE/Saudi/Egypt/Oman/global) and
  **HyperPay** (COPYandPAY widget on a page this API serves, status,
  refund), plus a **test gateway** (a Pay/Decline page; off in production).
- Each school's own merchant keys (Settings → Online payments), stored
  AES-256-GCM encrypted, never returned or audited; currency per school.
- A family pays all or part of what is owed from the portal. A payment is
  settled **only on the gateway's answer to a status query** (the callback
  and the browser's return merely prompt it; the sweep checks the rest every
  few minutes, gives up after two days), exactly once, and only if amount
  and currency match. It then goes through the normal `recordPayments`:
  oldest due first, receipt, "payment received" email. Paid while the
  office also took cash: the rest stays as credit and is flagged.
- The office's Finance → Online payments list (per branch) with "check
  now". An approved refund paid out with method "online" is sent back to
  the card through the gateway first.
- Found on the way: built-in settings entries added in a later release
  never reached a school that had added its own entries; fixed.

**Built — 11.2 gradebook and report cards** (`server/src/grades/`, the
Grades page):
- A year's **terms** can now be set after the year exists (Settings →
  Academic years): inside the year, in order, not overlapping; a term a plan
  or marks use can't be removed. Before, terms could only be given when
  creating a year, and nothing in the app did.
- **Subjects** are a settings list (Arabic, English, Mathematics, …
  defaults). An **assessment plan** per year and grade picks its subjects
  and each term's assessments (weight, maximum mark). Changing a plan never
  loses marks: an assessment or subject with marks stays, and a maximum
  can't drop below a mark already given.
- **Grading scale** per school (default A–F, 50 passes) and pass mark.
- **Mark entry** per class, subject and term (`grades.enter`, in the
  caller's branches): blank = not taken; scores checked against the
  maximum; one audit entry per save.
- **Results**: a term result is the weighted average of the assessments
  taken, the year result weighs the terms; per-subject grade, pass/fail,
  average, rank (ties shared) and the class teacher's remark.
- **Report cards**: one A4 page per student in English or Arabic
  (attendance for the term, remark, signature line), printed from the
  Results tab. **Releasing** a class's term emails families (new
  `report_card` template), shows the card in the portal's new Report cards
  tab (only their own child), and locks marks and remarks until a
  coordinator un-releases it.
- Scopes `grades.read` / `grades.enter` (schedulers and up) and
  `grades.manage` (admins, registrar); a new **Teacher** role (registers,
  marks, behaviour notes).

**Built — 11.3 library** (on top of 5.5, which already had books, copies,
loans, renewals, limits and fines):
- The desk takes the **ID card**: scanning a student or staff number (the
  card's barcode) finds the borrower with their loans and fines; scanning a
  copy **returns** it without looking the borrower up first.
- A student's fine can be **added to their invoice** for the year (a
  `Library fine — <title>` line, once per loan); the loan then counts as
  settled at the library (`billed`) and no longer blocks borrowing.
- **Overdue notices** to families (new `library_overdue` template): from
  the Loans → Overdue list, or daily when switched on in Communication →
  Automatic notices; each loan at most once per `repeatDays`.

**Built — 11.4 canteen and student wallet** (`server/src/canteen/`, the
Canteen page, the portal's Canteen tab):
- A prepaid **wallet** per student; every change is a transaction with the
  balance after it. A debit only succeeds if the money is there at that
  moment (a conditional update), so two tills can't spend the same money —
  tested with three sales at once.
- **Products** per branch, in `canteenCategory` groups (settings list).
- The **till** (new Canteen role, `canteen.sell` only): scan the ID card,
  tap products, charge. It sees the student's name, number, balance and
  what is left today — nothing else of the record. Refused when the balance
  is short, over the family's **daily limit**, or a **category the family
  blocked**.
- **Top-ups** at the office (`canteen.manage`, any payment method) or
  **online by the family** through the school's gateway (11.1; a wallet
  top-up never touches the fees). Same-day refund of a sale.
- The family sees the balance and statement, tops up, and sets the limits
  in the portal; the office sees the day's takings per product.

## Phase 12 — Pilot run
A realistic school built through the product itself (bulk import, fee
structures, timetable, a term of attendance, fees, grades, report cards,
notices) as an automated end-to-end scenario; every rough edge found is
fixed and listed here.

**Built.** A new school, "Al-Nour Academy", was opened in the vendor
console and taken through a term by its owner, a teacher and a parent in
the browser: school profile, a year with two terms, six classes, three fee
structures, 18 students with their families from a spreadsheet, a whole
grade billed, attendance, an assessment plan, marks, results released to
families, every family invited to the portal, a parent reading the report
card and paying part of an invoice through the test gateway, the payment
showing in Finance → Online payments, and the emails that went out.

Found and fixed on the way:

- *A new school had no campus*, so nothing could be created until the vendor
  added one by hand. A school opened in the console now starts with "Main
  campus" (or the name given).
- *The demo timetable leaked between schools* on one device: work saved in
  the browser was restored for whoever signed in next. Local work now
  belongs to its school and is cleared on sign-out; a school without a
  timetable starts from an empty one.
- *No way to know where to start.* A getting-started checklist on the
  dashboard (profile, year, classes, fees, students, invoices, team,
  payments), driven by the school's own data (`GET /onboarding`).
- *Billing a grade meant one invoice per student.* Finance → Bill grade
  invoices every student of a grade or class from its fee structure, with a
  preview; students already billed are skipped.
- *Classes made before a year existed belonged to no year* and vanished from
  year-scoped pages; the bulk path ignored the year given. Classes without a
  year now join the current one.
- *Two years with the same name or overlapping dates* could be created and
  confused every year picker; now refused (`YEAR_NAME_TAKEN`,
  `YEARS_OVERLAP`, `DATES_OUT_OF_ORDER`).
- *A fee structure for a grade that no class uses* matched no students.
  The grade field suggests the grades the school has and warns otherwise.
- *Menu items a role cannot open* were shown and led to "not allowed";
  every item now carries its scope, and sign-in lands on the first page the
  user may see (a parent lands on the portal).
- *Families were invited to the portal one by one.* Parents → Invite all to
  the portal (preview, then one email each; the caller's campuses only).
  An invite that could not be emailed is reported as such, not counted as
  sent.
- *A new parent set a password, then had to type their email again.*
  Accepting an invite now signs them straight in.
- *Imported families could not see or pay their bills*: the importer linked
  each guardian without financial responsibility, so the portal showed no
  Fees tab, the wallet could not be topped up and fee reminders fell back
  to the primary contact. The guardian a row names is now the fee contact
  when an admin imports; the same holds for the primary guardian of an
  admitted application.

Noted, not changed: family emails (receipts, report cards) leave with the
delivery sweep, every five minutes by default (`ABSENCE_SWEEP_INTERVAL_MS`).

## Phase 13 — SaaS offer
13.1 Plans and feature gating: each tenant's plan enables modules and sets
limits (students, branches, SMS credits); the UI hides what the plan does
not include and the API refuses it · 13.2 Self-serve trial sign-up next to
the sales-led path in the console, with an onboarding checklist · 13.3
Subscription billing: price list per currency (JOD, USD, SAR, AED), annual
and monthly terms, invoices to the school, card payment through the 11.1
providers or bank transfer recorded in the console, dunning into the
existing grace/suspension · 13.4 Usage metering (active students, SMS sent)
and the console's revenue view · 13.5 Public pricing page and legal
documents (terms, privacy, data processing) · 13.6 The business model:
`docs/saas-business-model.md`.

**Built.**

- *13.1 Plans.* Essentials, Professional, Enterprise and a 30-day trial,
  each a set of modules over the core with limits on students, campuses
  and SMS (`billing/plans.ts`, the one place prices and modules are set).
  - Every tenant route passes the plan check, which answers 402
    `PLAN_EXCLUDES_MODULE`.
  - Menus, tabs, settings sections, portal tabs and ID-card buttons hide
    what the plan lacks. A page reached by its address says it is not in
    the plan.
  - Sweeps skip excluded modules: scheduled reports, library notices, and
    transport loading.
  - Student limits are checked on create, import and admission. Campus
    limits are checked in the console.
  - The console sets plan, add-on modules, limit overrides and billing
    details. `custom` means everything, for agreed deals. Schools opened
    before plans existed keep everything.
- *13.2 Trial sign-up.* The public `/signup` page (`POST /public/signup`)
  gives:
  - a trial school with a first campus in its country's time zone and its
    currency;
  - the owner invited by email, and accepting signs them straight in.
  - It is rate-limited, has a hidden field for bots, allows one trial per
    email, notifies sales, and `SIGNUP=off` closes it.
- *13.3 Subscription billing.* Settings → Subscription shows:
  - the plan, its standing and usage against limits;
  - a live quote, where choosing a plan issues an invoice;
  - card payment through the vendor's own PayTabs or HyperPay account
    (`VENDOR_*`; a test gateway in development), or bank transfer;
  - invoices, printable with the vendor's details and bank information.
  - Paying applies the plan and paid-through date exactly once.
  - The console issues invoices (with onboarding fees or discounts as
    extra lines), records transfers and voids invoices.
  - The daily sweep issues renewal invoices 30 days ahead, reminds about
    unpaid invoices (7 days before, on the day, 7 days after), and emails
    trials 7 days and 1 day before they end.
  - A lapsed school keeps its grace days, then reads and exports its data
    for 60 days before it is locked. It can always reach the page to pay.
    A banner in the app says where the school stands.
- *13.4 Metering and revenue.* Usage per school: enrolled students,
  campuses, staff, and SMS this month. The console's Revenue card shows:
  - MRR and ARR per currency;
  - collections for the month and year;
  - open and overdue invoices;
  - schools by plan;
  - trials, sign-ups and conversion.
- *13.5* The public `/pricing` page reads `GET /public/plans`. It shows four
  currencies, yearly or monthly terms and a calculator. Templates for the
  terms, privacy policy and DPA are in `timetable-ui/public/legal/`, marked
  for legal review.
- *13.6* `docs/saas-business-model.md`: the price list, the reasoning, unit
  economics, go-to-market, tax and legal notes, KPIs and open decisions.

Also fixed: staff landed on Approvals after signing in. The first-page
redirect ran before the user's permissions had loaded; it now waits.

---

## Backlog — extras (built on request)

- **Email and SMS delivery.** SMS through Twilio or any HTTP SMS gateway
  (`SMS_PROVIDER`), local numbers turned international with
  `SMS_DEFAULT_COUNTRY_CODE`; SMTP without a login for relays; a plain-text
  part and clickable links. Communication → Automatic notices shows whether
  each channel is set up and sends a test; the delivery log can retry every
  message that failed (e.g. before a provider was set up). The credentials
  themselves are the operator's to set (see `server/.env.example`).
- **Configurable numbering.** Students, applications, invoices, receipts,
  refunds, expenses, employees, assets, maintenance requests and incidents:
  prefix, separator, digits, optional year (count restarts yearly), next
  number forward-only; numbers already used are skipped. Student numbers
  may be left blank and are then given.
- **Health and clinic.** A health profile per student (blood type,
  allergies with severity, conditions, medication, doctor); items marked
  as alerts show on the student record to all staff who can see the
  student, the rest needs `health.read`. Clinic visit log; a child sent
  home, referred or taken to emergency is reported to the family. New
  Nurse role; Clinic page; Clinic visits report.
- **Discipline.** Incidents about one or more students (`INC-` numbers),
  types and actions as settings lists. `discipline.report` (teachers,
  reception, nurse) logs and follows their own; `discipline.manage`
  (admins, registrar) sees all, records actions (warning … suspension),
  tells families and closes. Behaviour page, student tab, report.
- **Bulk import.** Students (with a parent per row) and staff from CSV:
  template, a preview that checks every row, and a commit that creates each
  valid row through the normal create routes as the caller; siblings share
  one parent found by phone or email. Settings → Import data.
- **ID cards.** Student and staff cards (photo, names in both languages,
  number as a Code 128 barcode, class or position, valid until), ten to an
  A4 sheet or one per card-printer page.

## Decisions (defaults applied until changed)

| Question | Default |
|---|---|
| Tenant = organization or single school? | **Tenant = organization; branch = school/campus.** A separate school level is added only when a customer runs several schools with their own branches. |
| Close Phase 1 before Phase 2? | **Yes** — 1.7–1.12 first. |
| Phase order | **Spec order**; fee reminders may be pulled forward into Phase 3 using the existing queue. |
| Extras not in the spec (health/clinic, discipline, configurable numbering, bulk import, ID cards) | **Built on request** (see Backlog — extras). |
| Payment providers | **PayTabs and HyperPay first**, behind one provider interface so others (eFAWATEERcom, Stripe) plug in later. |
| First markets | **Jordan, the Gulf and wider MENA together**: prices in JOD, USD, SAR and AED; Arabic and English. |
| Gradebook | **Built on request** (Phase 11.2): marks and report cards only, no lesson content. |
