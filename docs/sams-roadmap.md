# SAMS Roadmap — School Administration Management System

**Product direction**: an administration-first system (registrar, finance, HR,
front office, operations). **Not an LMS** — no courses, lesson content,
learning paths, or teaching tools. Academic references (year, grade, class,
enrollment) exist only where administration needs them.

This document is the phased build plan. It supersedes the "Recommended build
order" in [`sms-gap-analysis.md`](sms-gap-analysis.md), which remains the
per-area status reference.

## Where we are

**Phase 1 — Administration Foundation: shipped slices 1.1–1.6, closeout
(1.7–1.12) in progress.**

| Slice | What shipped | PR |
|---|---|---|
| 1.1 | Permission-scope layer (`requirePermission`) on top of the 4 ranked roles; students/attendance branch-scoping gap closed | #25 |
| 1.2 | School's own subscription status in Settings (read-only; replaced the original branch self-service scope) | #26 |
| 1.3/1.4 | Audit log: branch attribution, before/after, filters, CSV export | #27 |
| — | Transport moved from a JSON blob to a real backend (off-plan) | #30, #34 |
| 1.5 | Dashboard cross-module Overview | #36 |
| 1.6 | Tenant-scoped global search (students, parents, classes, buses, stops) | #37 |

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

---

## Phase 3 — Finance Administration
3.1 Installment plans · 3.2 Discount types + formal scholarships (approval via
1.10, documents via 2.1) · 3.3 Refunds (request → approve → pay out, capped at
the refundable amount) · 3.4 Payment allocation across invoices + payment
confirmations · 3.5 Expenses, categories, vendors (with approval) · 3.6
Finance reports (revenue, collections, aging, overdue, discounts,
scholarships, refunds, expenses, net position).

## Phase 4 — HR & Staff
4.1 Employee record separate from `MembershipDoc` (optional link to a login)
· 4.2 Departments, positions, contracts, renewals, employment history ·
4.3 Staff documents (2.1) · 4.4 Leave types, balances, requests (1.10) ·
4.5 Staff attendance · 4.6 HR reports.

## Phase 5 — Operations
5.1 Assets and lifecycle (purchase → assignment → maintenance → transfer →
disposal) · 5.2 Inventory, suppliers, stock movements · 5.3 Facilities,
buildings, rooms, maintenance requests · 5.4 Transport administration
(drivers, vehicle/driver documents, insurance/registration expiry, transport
fees) · 5.5 Library administration (copies, loans, overdue, fines) · 5.6
Events and activities (registration, capacity, attendance, costs).

## Phase 6 — Communication & Portals
6.1 General notification service over the existing queue: templates (EN/AR),
in-app channel, read state, failure tracking · 6.2 Announcements by
branch/grade/class/route · 6.3 Fee reminders and payment/admission/document
notices · 6.4 Parent portal (parent login, strictly linked-students-only
data, invoices, payments, permitted documents, announcements).

## Phase 7 — Reporting
7.1 Shared reporting service/queries (replace per-page calculations) · 7.2
Report catalog with branch/year/date/grade/class/status filters · 7.3 CSV,
Excel, PDF and print output · 7.4 Scheduled report exports.

---

## Decisions (defaults applied until changed)

| Question | Default |
|---|---|
| Tenant = organization or single school? | **Tenant = organization; branch = school/campus.** A separate school level is added only when a customer runs several schools with their own branches. |
| Close Phase 1 before Phase 2? | **Yes** — 1.7–1.12 first. |
| Phase order | **Spec order**; fee reminders may be pulled forward into Phase 3 using the existing queue. |
| Extras not in the spec (health/clinic, discipline, configurable numbering, bulk import, ID cards) | **Optional backlog**, scheduled only on request. |
