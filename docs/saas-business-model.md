# Selling SAMS as a service: business model and price list

This is the commercial side of the product: who pays, for what, how much,
and how the system supports selling it. The price list here is the one the
software enforces and quotes (`server/src/billing/plans.ts`); change both
together.

Figures marked *assumption* are starting points for your own numbers, not
market research. Check them before you rely on them, especially costs, tax
and competitors' prices.

---

## 1. The offer in one paragraph

A school management system for private schools in Jordan, the Gulf and the
wider Arab region. It is Arabic and English throughout and runs in the
browser, with a parent portal. It covers students, families, fees,
attendance, the timetable, grades and report cards, HR, transport, the
library and the canteen. Schools pay **per enrolled student per year**, on
one of three plans, with a yearly minimum per plan. Staff accounts and the
parent portal cost nothing extra. A school can start a 30-day trial of
everything on its own, or be sold to and set up by us.

## 2. Who buys, and why

| Segment | Size | What they need | Plan |
|---|---|---|---|
| Small private schools, kindergartens | 80–300 students, one campus | Fees and receipts, student and family records, the parent portal, notices | Essentials |
| Mid-size private schools | 300–1,200 students, 1–3 campuses | All of the above, plus grades and report cards, HR and payroll, transport, and online fee payment | Professional |
| School groups and large international schools | 1,000+ students, several campuses | Everything, plus operations, the canteen wallet, consolidated reporting, priority support and data location | Enterprise |

The decision maker is the owner or general manager. The finance manager and
the registrar influence the choice. The reasons to switch, from the pilot
and from typical complaints:

- **Fees are collected late and by hand.** This is solved by invoices per
  grade in one click, reminders, and parents paying online through the
  school's own PayTabs or HyperPay account.
- **Parents call the office for everything.** The portal shows attendance,
  fees, report cards and notices, in Arabic.
- **Several spreadsheets and a desktop program that one person understands.**
  Here the school has one system, with roles per person and per campus, and
  an audit log.
- **Report cards take a week to produce.** Teachers enter marks per class;
  results, ranks and printable cards follow, and are released to the portal.

## 3. Price list

Prices are per enrolled student per year. The school is billed for the
higher of its enrolled students and the plan's minimum. The prices are set
per currency and rounded, not converted from USD each day.

| | **Essentials** | **Professional** | **Enterprise** |
|---|---|---|---|
| USD | 12 (min 1,200/yr) | 20 (min 3,000/yr) | 30 (min 7,500/yr) |
| JOD | 8.50 (min 850/yr) | 14 (min 2,100/yr) | 21 (min 5,250/yr) |
| SAR | 45 (min 4,500/yr) | 75 (min 11,250/yr) | 110 (min 27,500/yr) |
| AED | 45 (min 4,500/yr) | 75 (min 11,250/yr) | 110 (min 27,500/yr) |
| Minimum covers | 100 students | 150 students | 250 students |
| Campuses | 1 | up to 3 | any number |
| SMS included | none (packs) | 2 / student / month | 4 / student / month |

**What each plan includes**

- **Every plan (the core):**
  - students, families, classes, academic years and the timetable
  - attendance with absence alerts
  - fees, invoices, receipts, installments, discounts, refunds and expenses
  - the parent portal, announcements and family notices (email and in-app)
  - reports on demand and exports
  - imports, the audit log, roles and permissions
- **Professional adds:**
  - gradebook and report cards
  - admissions
  - HR, leave and payroll
  - transport and bus routes
  - library
  - behaviour and clinic
  - ID cards
  - online fee payment
  - scheduled report emails
- **Enterprise adds:**
  - assets, inventory, maintenance and events
  - the canteen and student wallet
  - any number of campuses
  - priority support
  - data location options, on request

**Terms**

- **Monthly billing** costs 20% more than paying for the year: 1/12 of the
  yearly price × 1.2.
- **Invoices** are due in 14 days. Schools pay by card or by bank transfer.
  Prices exclude tax.
- **After the paid-through date**, a paying school gets 14 grace days in
  which everything works. For the next 60 days it can view and export its
  data but not change it. Only after that is it locked. This is built into
  the product, not just promised.

**Worked examples, per year** (*also shown by the pricing page calculator*)

| School | Plan | Calculation | Price |
|---|---|---|---|
| Kindergarten, 90 children, Amman | Essentials, JOD | below minimum | JOD 850 |
| School, 450 students, Riyadh | Professional, SAR | 450 × 75 | SAR 33,750 |
| Group, 2,000 students, Dubai | Enterprise, AED | 2,000 × 110 | AED 220,000 |

### One-off fees and add-ons (invoiced from the console as extra lines)

| Item | USD | JOD | SAR / AED | Notes |
|---|---|---|---|---|
| Onboarding: import, setup and 2 training sessions | 800 | 550 | 3,000 | Free for self-serve Essentials. Enterprise is quoted, from USD 2,500. |
| Extra campus on Professional | 600 / yr | 425 / yr | 2,250 / yr | Raise the school's campus limit in the console. |
| SMS pack, 1,000 messages | 25 | 18 | 95 | For Essentials, and for use above the included allowance. |
| One Professional module on Essentials | 3 / student / yr | 2 | 11 | Set as an add-on in the console, for example grades only. |

### Discounts: keep them few and written down

| Discount | Amount |
|---|---|
| 2 years prepaid | 10% |
| 3 years prepaid | 15% |
| Groups of 3 or more schools on one contract | 10–15% |
| Founding schools (the first 10), for a reference and a case study | 30% in year 1 |
| Registered charities and community schools | 20% |

Discounts go on the invoice as a negative extra line. Do not change the list
price for one school.

## 4. Why this model

- **Per student** matches how schools think about money: fees come per
  student. The price grows with the school, and a small school is not
  priced out.
- **Minimums** cover the fixed cost of a school: onboarding, support and
  hosting. They stop tiny contracts that cost more to serve than they bring
  in.
- **Free staff seats** mean every teacher is invited, which is what makes
  the system stick. Per-user pricing makes schools share logins.
- **Tiers by module** give a clear upgrade path. The Professional modules
  (grades, HR, transport, online payment) are the ones mid-size schools ask
  for first.
- **Yearly billing by default** fits school budgets and cash flow. It also
  reduces churn to one decision a year, before the new academic year.

## 5. Unit economics (*assumptions to replace with your numbers*)

Costs to serve one mid-size school (600 students, Professional, USD 12,000
a year):

| Cost | Per year | Basis |
|---|---|---|
| Hosting, backups, email | ~150 | shared cluster, per-school share |
| SMS included (2 × 600 × 12 = 14,400 SMS) | ~430 | ~USD 0.03 per SMS in Jordan; varies by country |
| Card fees on the subscription | ~330 | ~2.75% if paid by card |
| Support | ~250 | one support person per ~70 schools |
| **Total** | **~1,160** | **gross margin ≈ 90%** |

Watch **SMS** most closely. It is the one cost that grows with use, and
prices differ a lot between countries. If a country's SMS is expensive, sell
packs instead of including SMS. The console's usage view shows SMS per
school per month.

**Break-even (*assumption*).** Two developers, one salesperson and one
support and onboarding person in Amman cost about USD 120–150k a year with
tools and hosting. At an average contract of USD 6k a year, that is 20–25
schools. The first year's goal is therefore about 25 paying schools.

## 6. Going to market

**Sequence.**

1. **Jordan first:** the pilot, references, and Arabic sales material. Sell
   to schools directly in Amman, Irbid and Zarqa.
2. **Saudi Arabia and the UAE** next, through resellers or implementation
   partners who already sell to schools. Pay them 20% of year-1 revenue and
   10% of renewals.
3. The rest of the region (Kuwait, Qatar, Bahrain, Oman, Egypt, Iraq,
   Palestine) through self-serve trials and partners, billed in USD.

**The school year sets the calendar.** Schools choose systems between March
and July and go live in August or September. A second, smaller window is
the mid-year break in January and February. Book demos and trials in the
spring, and keep onboarding capacity free for the summer.

**Two ways in, both built:**

- **Self-serve:** the pricing page, then the 30-day trial of everything. It
  sends reminders 7 days and 1 day before the end. The school then picks a
  plan in Settings → Subscription and pays by card. Best for small schools.
  Every sign-up emails the sales team (`SALES_NOTIFY_EMAIL`) so someone can
  call within a day.
- **Sales-led:** a demo, then the school is opened in the console with its
  first campus and its owner invited. Then the onboarding package, an
  invoice from the console, and payment by bank transfer, which is recorded
  in the console. Best for Professional and Enterprise.

**Getting a school live** (from the pilot, Phase 12):

1. The getting-started checklist on the dashboard covers the profile, the
   year and terms, classes and fee structures.
2. Import students and families from a spreadsheet.
3. Bill each grade.
4. Invite every family to the portal in one step.
5. Turn on online payment.

With onboarding this takes about a week. Aim for the first fee cycle to go
through the system within 30 days, because schools that collect fees in it
stay.

**What to show in a demo:** a parent paying a fee on a phone, a report card
released to the portal, and invoices for a whole grade in one click.

## 7. Revenue beyond subscriptions (later, not built)

- **A convenience fee on parent card payments** (for example 1%), charged
  by the school's gateway. It needs an agreement with the gateway and must
  be clearly disclosed to parents. Some schools will refuse it.
- **Paid integrations**, such as the ministry's student information system,
  accounting exports, and biometric attendance devices.
- **Data location or private hosting** for Enterprise customers, at a
  premium.

## 8. Tax, invoicing and legal (*check with an accountant and a lawyer*)

**Tax**

The default rates on invoices are Jordan 16% (sales tax), Saudi Arabia 15%
(VAT) and UAE 5% (VAT). Change them with `VENDOR_TAX_RATES`, and the
console can override them per invoice. Whether you must charge tax, and in
which country, depends on where the company is registered and where the
school is.

**Saudi Arabia**

- If you register for VAT in Saudi Arabia, invoices must follow ZATCA's
  e-invoicing (Fatoora) rules. The printable invoice here is not a Fatoora
  e-invoice.
- The PDPL has rules on transferring personal data abroad. Enterprise
  schools may ask for hosting inside the country.

**Legal templates** are in `timetable-ui/public/legal/`: terms of service,
privacy policy and a data processing agreement, linked from the sign-up and
pricing pages.

- Fill in the bracketed details, such as company name, addresses and
  sub-processors.
- Have a lawyer review them for each country before publishing.
- The school is the controller of pupils' data and you are its processor.
  The DPA says so.

**Company.** Register the company and a merchant account for the vendor's
own card payments, separate from the schools' accounts. Set `VENDOR_*` in
the server environment.

## 9. Numbers to watch every month

The console's **Revenue** card shows:

- MRR and ARR by currency
- collected this month and this year
- open and overdue invoices
- schools by plan
- trials running and ending this week, sign-ups, and conversion

Each school's page shows its enrolled students, campuses, staff and SMS
against its limits.

Also track, outside the system:

- **Logo churn:** schools that did not renew. Aim for under 10% a year.
- **Net revenue retention:** renewals plus upgrades, divided by last year's
  revenue. Aim for over 100%, as schools grow and move to Professional.
- **Trial to paid conversion:** aim for 15–25% of self-serve trials.
- **CAC payback:** the sales and marketing cost of a school, divided by its
  monthly gross margin. Aim for under 12 months.
- **Days from contract to first fee cycle in the system.**

## 10. How the product enforces and supports this

| What | Where |
|---|---|
| Plans, modules, limits, prices, monthly uplift, trial length | `server/src/billing/plans.ts` (the one place to change prices) |
| Module gate (402 `PLAN_EXCLUDES_MODULE`), menus hidden, "not in your plan" page | `auth/guard.ts` `requireActiveSubscription`; UI `hasModule` |
| Student and campus limits (402 / 409 `PLAN_LIMIT_*`) | `billing/usage.ts`; the console can set limits per school |
| Grace days, 60 days read-only, then locked | `billing/plans.ts` `subscriptionState`; a banner in the app |
| Public price list, trial sign-up | `GET /public/plans`, `POST /public/signup`; pages `/pricing`, `/signup` |
| School picks a plan, pays by card, prints invoices | Settings → Subscription; `billing/routes.ts` |
| Vendor's card gateway (PayTabs, HyperPay) | `VENDOR_PAYMENT_PROVIDER` and related, `billing/service.ts` |
| Console: plan, add-ons, limits, billing details, invoices, transfers, revenue | `/console/` |
| Renewal invoices 30 days ahead, reminders on unpaid invoices, trial-ending emails | the daily sweep, `runBillingSweep` |

**A new school, sold (console):**

1. Create it with a plan.
2. Set its billing currency, term and students.
3. Issue the invoice, adding the onboarding fee and any discount as extra
   lines.
4. When the bank transfer arrives, click **Record transfer**. The school is
   then paid through the invoice's period.

**A renewal:** the sweep issues the invoice 30 days before the date, and the
school pays by card or transfer. Upgrades are the same: the school, or you,
issues an invoice for the new plan. The plan changes when that invoice is
paid.

## 11. Decisions still open

- **Company and billing entity:** one company billing the whole region, or
  a local entity in Saudi Arabia for VAT and e-invoicing.
- **Hosting region:** one region for all schools, or in-country hosting for
  Saudi Enterprise schools.
- **SMS:** whether to keep SMS included in Professional in countries where
  it is expensive, or sell packs only.
- **Mid-term changes:** whether mid-term upgrades are prorated. Today an
  upgrade invoice starts after the current paid period, or today for a
  trial or lapsed school. The console can add a prorated credit as a
  negative line.
- **Refunds:** the policy for a school that leaves mid-year. The default in
  the terms is no refunds, except when we end the service.
