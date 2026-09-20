# School Management System — Gap Analysis

**Scope of this document**: analysis and a recommended build order only. Nothing
in this document is built as part of this PR except the Parent Management
module, which is implemented alongside it (`server/src/parents/`,
`timetable-ui/src/pages/ParentsPage.tsx`) and is included in the table below
as "existing" for that reason.

## Methodology

Status is graded against what actually exists in this repository today, not
what could plausibly be inferred from the product's name. Evidence is the
module directories under `server/src/` (a real Fastify route file + Zod
schemas + MongoDB collection is "existing"; a field that exists on a document
but has no route/UI is "partially implemented"; nothing at all is "missing")
and the page files under `timetable-ui/src/pages/`.

Server module evidence base (`server/src/*`, one directory per domain):
`academicYears`, `admin`, `apikeys`, `attendance`, `auditlog`, `auth`,
`branches`, `classes`, `datasets`, `enrollments`, `memberships`,
`notifications`, `parents`, `students`.

Frontend page evidence base (`timetable-ui/src/pages/*`):
`AttendancePage`, `ClassesPage`, `DashboardPage`, `LogsPage`, `ParentsPage`,
`RoutesPage`, `SettingsPage`, `StudentsPage`, `TimetablePage`, plus
auth-flow pages (`LoginPage`, `ForgotPasswordPage`, `SetPasswordPage`).

## Per-area status

| Area | Status | Evidence | Notes |
|---|---|---|---|
| **Academic Management** | | | |
| Academic years | Existing | `academicYears/routes.ts`, `AcademicYearDoc` | One current year per tenant; terms are a sub-array (`AcademicTerm[]`) but have no dedicated UI. |
| Terms/semesters | Partially implemented | `AcademicYearDoc.terms` | Data shape exists, no route or UI to manage them independently of the year. |
| Grades / classes / cohorts | Existing | `classes/routes.ts`, `SchoolClassDoc`, `ClassesPage.tsx` | Grade + section model, with enrolled-count. |
| Subjects / curriculum | Missing | — | The timetable's `Lesson.subject` is a free-text string per lesson, not a curriculum catalog. |
| Timetable / teacher assignments | Existing | `timetable-ui/src/solver/*`, `TimetablePage.tsx` | The core product — a full local-search solver, but persisted as one opaque JSON blob (`datasets/:key`), not a real per-lesson/teacher schema server-side. |
| Exams / assessments | Missing | — | No grading, no assessment model anywhere. |
| Grades/results, report cards | Missing | — | Depends on Exams/Assessments existing first. |
| Attendance | Existing | `attendance/routes.ts`, `AttendanceCorrectionDoc`, `AttendancePage.tsx` | Full per-day, per-student model with a correction trail and absence-notification integration. |
| Promotion/repetition | Missing | — | No year-end rollover flow; a new academic year and re-enrollment would currently be entirely manual. |
| Enrollment & transfers | Existing | `enrollments/`, `StudentDetailDialog.tsx` | Real history model — transfer/withdraw close one row and open another, never overwritten. |
| **Student Management** | | | |
| Student profiles | Existing | `students/routes.ts`, `StudentsPage.tsx` | |
| Parent/guardian management | Existing (this PR) | `parents/`, `ParentsPage.tsx` | Normalized, many-to-many. See "Architecture note" below for how it relates to the older embedded `Guardian[]`. |
| Enrollment history | Existing | `enrollments/service.ts`'s `enrollmentHistory` | |
| Student documents | Missing | — | No file/document model anywhere in the schema. |
| Medical/emergency info | Partially implemented | `StudentDoc.medicalNotes` | Free-text only — no structured allergy/condition list, no vaccination record. |
| Behavior/discipline | Missing | — | |
| Student attendance | Existing | (see Attendance above) | |
| Transportation | Existing | `RoutesPage.tsx`, `solver/vrp/*`, `StudentDoc.stopId/transportMode/lat/lng` | Full bus-routing solver with stop pinning and per-student pickup pins. |
| Student activities | Missing | — | |
| Student ID/cards | Missing | — | `studentNumber` exists as a field; no card-generation or ID-badge feature. |
| **Parent Management** | | | |
| Parent profiles | Existing (this PR) | `ParentDoc` | |
| Multiple guardians | Existing (this PR) | `ParentStudentLinkDoc` (many-to-many) | |
| Parent-student relationships | Existing (this PR) | same | Relationship type, primary/secondary/emergency contact, authorized pickup. |
| Parent communication | Partially implemented | `communicationPermissions` on the link; the actual send pipeline is `notifications/` (built for absence alerts, keyed off the *embedded* `Guardian[]`, not `ParentDoc`) | Wiring a general "message this parent" action into the existing notification queue is a natural next step (see roadmap). |
| Parent portal | Missing (placeholder only) | `ParentDoc.portalAccess`, `ParentStudentLinkDoc.portalAccess` | Flags only — no login surface, no `UserDoc` link, no portal-facing UI. |
| Notifications | Partially implemented | `notifications/` (absence sweep only) | Not parent-management-specific; a general "notify this parent" action doesn't exist yet. |
| Parent documents | Missing | — | |
| Financial responsibility | Partially implemented (forward hook only) | `ParentStudentLinkDoc.financialResponsibility` | A boolean flag with nothing downstream to read it yet — see Finance below. |
| **Finance & Accounting** | Missing (whole area) | — | No fee, invoice, payment, or ledger model anywhere. The Parent↔Student join and its `financialResponsibility` flag (this PR) are the only piece in place that a Finance module needs to exist before it can be built. |
| **HR & Staff Management** | Missing (whole area) | `MembershipDoc` covers *authentication/authorization* for staff (role, branch scoping), not HR records | No contracts, payroll, leave, performance, or recruitment model. A "staff profile" beyond login credentials doesn't exist. |
| **Communication** | Partially implemented | `notifications/` (email/SMS queue + worker + per-channel opt-in), used only for the absence sweep today | The queue/worker/attempt-log infrastructure (`NotificationJobDoc`, `NotificationAttemptDoc`) is generic enough to extend to announcements, fee reminders, and exam-result notices without rebuilding it — see roadmap. |
| **Transportation** | Existing | `RoutesPage.tsx`, `solver/vrp/*`, `server/src/students` (stop/location fields), fleet dataset | Buses, stops, routing, student pins, straight/route map toggle. GPS/live tracking is the one sub-item genuinely missing (no device/telemetry ingestion anywhere). |
| **School/Branch Management** | Existing | `branches/routes.ts`, `BranchDoc`, per-branch scoping throughout (`classes`, `students`, `schoolCalendars`, `notificationSettings`, `fleet`) | Multi-branch is a first-class concept across the whole schema, not bolted on. |
| **Documents & Administration** | Missing (whole area) | — | No document/file storage model exists for any entity (student, parent, staff, enrollment). |
| **Inventory & Assets** | Missing (whole area) | — | |
| **Library** | Missing (whole area) | — | |
| **Health & Welfare** | Partially implemented | `StudentDoc.medicalNotes` (free text) | No structured allergy list, no clinic/incident log, no vaccination record. |
| **Activities & Events** | Missing (whole area) | — | |
| **Reporting & Analytics** | Partially implemented | `DashboardPage.tsx` (cohort load, break coverage), `auditlog/routes.ts` (a raw audit feed) | No cross-cutting reporting layer — each page computes its own view over its own data; there is no shared query/reporting API. |
| **System Administration** | | | |
| User accounts | Existing | `auth/`, `UserDoc` | |
| Roles and permissions | Partially implemented | `auth/guard.ts`'s 4-tier `requireRole` (viewer/scheduler/admin/owner) + per-branch `MembershipDoc.branchIds` | Coarse and role-based, not a granular per-action permission table. Explicitly not extended in this PR — see the Parent Management PR description for the reasoning; flagged here as a real gap if finer-grained control (e.g. "can view financial data" as a standalone grant) becomes a real requirement. |
| Audit logs | Existing | `auditlog/routes.ts`, `AuditLogDoc`, `recordAudit()` | Generic — every module (including this PR's Parent Management) reuses it rather than building its own. |
| System settings | Partially implemented | `SettingsPage.tsx`, `notificationSettings`, `schoolCalendars` | Scattered per-feature settings, not a single settings domain. |
| Academic year / branch settings | Existing | (see above) | |
| Notification settings | Existing | `notificationSettings` (per-branch) | |
| Numbering/ID configuration | Missing | — | `studentNumber` is caller-supplied, not system-generated/configurable. |
| Data import/export | Partially implemented | `timetable-ui/src/lib/exports.ts` (CSV/JSON export of the timetable dataset) | No import path for any SIS entity (students, parents, classes) — only the timetable blob exports. |
| Backup/recovery | Missing | — | No explicit backup tooling in this repo (relies on the hosting DB provider's own backups, unconfirmed). |
| Integrations / API access | Partially implemented | `apikeys/` (tenant-scoped API keys, used by `datasets`/sync today) | No public integration surface beyond the dataset sync endpoints and whatever a key-holder can already call. |

## Architecture note: two "guardian" models, on purpose

`StudentDoc.guardians` (embedded, pre-dates this PR) and the new
`ParentDoc`/`ParentStudentLinkDoc` (normalized, this PR) both exist and are
**not** merged. The embedded array is load-bearing for absence notifications
(`notifications/sweep.ts` reads `notifyByEmail`/`notifyBySms`/
`preferredLanguage` from it directly); merging the two models would mean
either duplicating those fields onto the link document or rewiring the
notification pipeline, both out of proportion to Parent Management on its
own. A one-time backfill (`backfillParentsFromGuardians` in
`server/src/backfill.ts`) seeds the new model from the old one so the Parents
page isn't empty for existing tenants, but going forward the two are
independent — a change to one does not update the other. Unifying them (most
likely: retiring the embedded array in favor of the notification pipeline
reading `ParentStudentLinkDoc.communicationPermissions` instead) is real
follow-up work, not done here.

## Recommended build order

Grouped by what each depends on, not strictly by business priority — a
school might reasonably want Communication before Finance, for instance.

1. **Academic Management gaps (Subjects/Curriculum, Exams/Assessments,
   Grades/Results, Report Cards, Promotion/Repetition)** — the one area
   where later items build directly on earlier ones within the same group.
   Nothing else in this list depends on it, so it can move independently.
2. **Finance & Accounting** — depends on this PR's Parent↔Student join
   (`financialResponsibility`) and the existing Enrollment model (what a
   student is being charged for follows from their class/year). The
   highest-value next module given `financialResponsibility` already exists
   as a hook with nothing reading it yet.
3. **Communication (general)** — extends the existing
   `NotificationJobDoc`/`NotificationAttemptDoc` queue and worker rather than
   building new send infrastructure; natural to build once Finance exists
   (fee reminders) but doesn't strictly require it (school-wide announcements
   and exam-result notices don't).
4. **Parent Portal** — depends on Parent Management (this PR) and
   Communication (for portal-triggered notifications); a real auth surface
   for `ParentDoc.portalAccess`/`ParentStudentLinkDoc.portalAccess` to mean
   something.
5. **Health & Welfare** — a natural extension of `StudentDoc.medicalNotes`
   into a structured model; independent of the above, low complexity.
6. **HR & Staff Management** — independent of the student/parent/finance
   chain; depends only on the existing `MembershipDoc`/role model as a
   starting point for a real staff-profile entity.
7. **Documents & Administration** — a generic file-storage layer that
   Student, Parent, Staff, and Enrollment records can each attach to; best
   built once at least two of those entities exist as real consumers (they
   already do: Student and Parent), rather than speculatively.
8. **Inventory & Assets, Library, Activities & Events** — largely
   independent leaf modules with no hard dependency on anything above;
   sequence by business priority, not architecture.
9. **Reporting & Analytics (cross-cutting layer)** — deliberately last: it's
   most valuable once there's more than Attendance/Cohort data to report on,
   and building it early risks a reporting API shaped around only the
   current, narrower set of modules.
10. **System Administration gaps (granular permissions, numbering
    configuration, data import, backup tooling)** — permissions in
    particular should be revisited once Finance and the Parent Portal exist,
    since "who can see financial data" and "who can see a portal-eligible
    parent record" are exactly the kind of per-action grants the current
    4-role model can't express.

## How future modules fit the existing isolation model

Every collection proposed above should follow `server/src/db.ts`'s existing
pattern: a `tenantId` field, access only through `TenantScope`/
`TenantContext`/`withTenant` (never a raw `db.collection()` call from route
code), and indexes registered in `schema.ts`. Nothing recommended here
requires changing `db.ts`'s isolation mechanism itself — the same structural
guarantee that already covers Students, Enrollments, Classes, Attendance, and
(this PR) Parents extends to Finance, HR, Documents, or any other module
exactly as it stands today.
