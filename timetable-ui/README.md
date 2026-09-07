# Timetable Studio

A TypeScript web UI for K-12 school timetabling. It models the same domain as the
Apache KIE Optaplanner "School Timetabling" example — `Timeslot` and `Room` as
planning values, `Lesson` as the planning entity — and solves it client-side in a
Web Worker.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build
```

## Pages

| Route | What it is |
| --- | --- |
| `/login` | Sign-in. Redirects to the page you asked for once authenticated. |
| `/dashboard` | KPIs, last solve verdict, the school week and per-cohort load. |
| `/timetable` | The scheduler — editor, board and constraint inspector. Its header carries only solve controls: score, time budget, Solve/Stop, Reseed, API JSON. |
| `/settings` | Three tabs — **Account** (language, appearance, signed-in user, dataset tools, server sync), **Calendar** (the school-week shape) and **Tuning** (soft-constraint weights). |

Everything except `/login` sits behind an auth guard and shares one sidebar.

> **Authentication is a demo stub.** Credentials are checked in the browser
> against a list that ships inside the bundle (`src/auth/AuthContext.tsx`), so it
> is not a security boundary — anyone can read it. It exists to exercise routing,
> roles and the session flow. Replace `signIn` with a real identity provider and
> move the user list server-side before pointing this at live staff accounts.
> Demo logins: `admin@school.test` / `admin123`, `scheduler@school.test` / `plan123`.

## Languages

English and Arabic, switchable from the sidebar, the login screen or Settings.
Choosing Arabic sets `dir="rtl"` on the document and the whole interface mirrors
— the layout was built on CSS logical properties, so the timetable grid reads
right-to-left with Sunday on the right. Fonts follow suit: Poppins for Latin,
Cairo for Arabic, both self-hosted so the app makes no third-party request.

Solver justifications are stored as a translation key plus parameters rather
than a baked sentence, so a violation like *"KG1-A has 3 lessons at Wednesday
09:15"* renders in either language with a localised day name. The exported API
payload deliberately stays English, so downstream consumers see stable text.

**User data is never translated.** Subject names, teacher names, cohort labels
and break names display exactly as entered — switching language does not rewrite
your dataset. Type them in Arabic and they show in Arabic in both modes.

## What it does

- **Edits the problem** — lessons, the school calendar, timeslots, rooms,
  teacher unavailability and soft-constraint weights, all in the left panel.
- **Solves it** — greedy construction followed by simulated annealing with
  reheats, running to a time budget you pick (2s–30s).
- **Shows the result** three ways — a week grid per cohort, per teacher or per
  room, plus a day matrix showing every cohort across one day's periods.
- **Explains every penalty** — the inspector lists each broken constraint with a
  human-readable justification; clicking one highlights the lessons involved.
- **Exports the wire payload** — the API JSON dialog emits the exact response
  shape the scheduling backend returns, and the dataset dialog round-trips
  through Import.

## Calendar and breaks

The school week can be edited in two places — **Settings → Calendar** and the
timetable editor's own **Calendar** tab. Both render the same
`SchoolWeekFields` component against the same `problem.calendar`, so they cannot
drift apart; Settings additionally shows a read-only summary of the breaks, which
are edited next to the grid where their effect is visible.

Either way, the fields define the shape of the week and regenerate the timeslots
whenever you touch them:

- **Week starts on** — any weekday. Sunday–Thursday and Monday–Friday weeks are
  both first-class; the setting rotates day ordering everywhere, including the
  solver's own notion of "day".
- **Teaching days**, **first period starts**, **period length**, **periods per day**.
- **Breaks** — as many as you need. Each is one of two kinds, because a shared
  grid cannot express them the same way:

| Kind | What it does | Use for |
| --- | --- | --- |
| **Whole-school gap** | Inserts real minutes after a period. No teaching slot is consumed; the rest of the day shifts later. | Morning recess, assembly |
| **Class break** | Reserves a whole period as a break for the cohorts you pick. The slot still exists — other cohorts teach through it — but the listed cohorts can never be scheduled in it. | Staggered lunch, per-class breaks |

A class break is enforced as the hard constraint **Cohort break**, and it is also
excluded from the student-continuity penalty, so a cohort's own lunch never
counts against it as an idle gap.

## Constraint model

| Level | Constraint | Rule |
| --- | --- | --- |
| Hard | Room conflict | One lesson per room per timeslot |
| Hard | Teacher conflict | One lesson per teacher per timeslot |
| Hard | Student group conflict | One lesson per cohort per timeslot |
| Hard | Teacher unavailable | No lesson inside a blocked slot |
| Hard | Cohort break | No lesson during a period a cohort has reserved as its break |
| Hard | Room capacity | Room seats ≥ cohort size |
| Soft | Teacher continuity | Penalise idle gaps in a teacher's day |
| Soft | Student continuity | Penalise free periods inside a cohort's day |
| Soft | Subject distribution | Penalise a repeated subject on one day, unless both lessons are flagged as a double period and land on adjacent slots |
| Soft | Teacher room stability | Penalise extra rooms a teacher uses per day |
| Soft | Cohort room stability | Penalise extra rooms a cohort uses per day — this is what holds KG classes in their homeroom |

A solution is `SUCCESS` only at zero hard penalty; anything else is reported as
`INFEASIBLE` together with the best attempt and the breaking constraints.

## Sample dataset

Boots with a six-cohort school spanning every tier — `KG1-A`, `KG2-A`,
`Grade 4-A/B`, `Grade 8-A`, `Grade 11-Science` — 153 lessons, 40 timeslots
(Sunday–Thursday × 8 periods) and 10 rooms. It exercises the awkward cases on
purpose: a 20-minute morning recess after period 3, a **staggered lunch** where
the lower school breaks at period 5 and the upper school at period 6, a
part-time music teacher on site two days a week, a science head out on the last
day, double-period requests, and specialist subjects pinned to the gym, art
studio, computer lab and science lab.

A 15-second search on that dataset reaches 0 hard / about −80 soft, with
essentially no idle gaps in any teacher's day.

## Layout

```
src/
  app/        AppShell.tsx (sidebar + routed outlet)
  auth/       AuthContext.tsx (demo session, route guard source)
  i18n/       translations.ts (en/ar dictionaries) · I18nContext.tsx
  state/      AppContext.tsx (problem, solver, theme shared across pages)
  pages/      LoginPage · DashboardPage · TimetablePage · SettingsPage
  domain/     types.ts (entities, constraint metadata) · calendar.ts (week shape,
              break rules, timeslot generation) · sample.ts (demo school)
  solver/     model.ts   Problem -> integer typed arrays
              score.ts   full HardSoftScore, O(lessons) per evaluation
              explain.ts human-readable justification per violation
              solve.ts   construction heuristic + simulated annealing
              solver.worker.ts
  lib/        useSolver.ts (worker hook) · api.ts (wire payload) · view.ts (grid math)
  components/ DataPanel · TimetableBoard · LessonCard · InspectorPanel · JsonDialog
```

The search loop never touches strings: `compile()` flattens the problem into
`Int32Array`s, and `score()` reuses preallocated buffers, clearing only the
entries the previous evaluation touched. Day-level soft constraints are computed
from 32-bit period bitmasks, which caps a day at 32 periods.

Seeded with `mulberry32`, so the same seed and time budget reproduce the same
schedule; **Reseed** re-runs from a different starting point.

## Theme

Design tokens in `src/styles.css` come from the supplied LESS theme:

| LESS variable | Token |
| --- | --- |
| `@internal-theme-transition-border-border-gradient` | `--brand-gradient` — primary buttons, avatar, active nav rail, login panel |
| `@global-font-family: 'Poppins'` | `--font-latin` (paired with Cairo for Arabic) |
| `@global-background: #FFFFFF` | `--paper` |
| `@inverse-navbar-nav-item-color: #0D0A46` | `--ink` / `--nav-item` |
| `@inverse-navbar-nav-item-hover-color: #44434A` | `--ink-2` / `--nav-item-hover` |

`#ff7300` on white falls below AA for body text, so `--accent-text` (`#c25400`)
carries orange text while `--accent` stays for fills and rules. The gradient is
light enough that primary buttons take dark ink (`--on-accent`) rather than
white. A matching dark palette keeps the navy/orange family.

## Deployment note

Routing uses the History API, so a static host must rewrite unknown paths to
`index.html` or a refresh on `/timetable` will 404. `npm run dev` and
`npm run preview` already do this.

## Persistence, locking, export and sync

- **Autosave.** Every edit is written to `localStorage` (debounced ~600 ms) under
  a versioned key, and restored on load. The sample only appears on a fresh
  install or after **Reset**. A corrupt or outdated payload is discarded rather
  than loaded into a mismatched model.
- **Locking.** The lock column in the Lessons table freezes a lesson in the
  period the solver chose; the next run keeps it and rearranges everything else
  around it. Locking sets `pinnedTimeslotId` only — `pinnedRoomId` stays a
  *dataset* room requirement (the gym, the labs), so unlocking never destroys it.
  The CSV reports the two separately as `locked` and `room_required`.
- **Export.** `CSV` writes one row per lesson with a UTF-8 BOM so Excel opens it
  cleanly. `Print` uses a dedicated stylesheet: A4 landscape, sidebar and panels
  hidden, subject colours forced on, rows kept off page breaks.
- **Sync.** The Sync button pushes the dataset to the server configured in
  Settings, and reports what actually happened — including *not configured*,
  *offline*, *timeout* and *the server moved on*. It never shows success it did
  not get.

### Server contract

Two endpoints, one document per school, an integer revision for optimistic
concurrency:

```
GET  {baseUrl}/datasets/{schoolId}
     200 { revision, updatedAt, problem }
     404 when the school has never pushed

PUT  {baseUrl}/datasets/{schoolId}
     body { baseRevision, problem }
     200 { revision, updatedAt }
     409 { revision, updatedAt, problem }   server moved on; caller decides
```

`Authorization: Bearer <token>` is sent when a token is configured. A 409 is a
normal outcome, not an error — the UI offers push-again or pull.

## Resizable workspace

The editor and solver panels are drag-resizable by their dividers, so the
timetable can be widened without hiding anything. The **board itself is the hard
limit**: a panel may only grow while the timetable still has 420px left, so it
can never be squeezed out of readability. Panels clamp to 260–560px (editor) and
250–520px (solver).

The limit is recomputed from the live workspace width, so it still holds after
the window is resized or the solver panel is hidden — a layout saved on a wide
screen cannot crush the board on a narrow one. Double-click a divider (or press
Home when it has focus) to reset; arrow keys nudge it 16px. Widths persist per
browser, and the drag direction mirrors correctly under RTL.
