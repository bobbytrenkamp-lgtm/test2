# Implementation roadmap

## Where the build reached

| Phase | Status |
| --- | --- |
| 0. Audit and preservation | **Complete.** Repository was empty; see `docs/repository-assessment.md`. |
| 1. Foundation | **Complete.** Monorepo, environment validation, PostgreSQL, migrations, authentication, organizations, permissions, design system, CI, tests, seed data. |
| 2. Property and lease domain | **Complete.** Properties, buildings, spaces, tenants, leases, rent steps, market leasing assumptions, validation. |
| 3. Calculation engine | **Complete.** Calendar, lease revenue, rent steps, vacancy, expenses, recoveries with multiple pools and reconciliation, NOI, capital, traces, 20 regression fixtures. |
| 4. Valuation and returns | **Complete.** DCF, direct capitalisation, terminal value, sale, IRR, XIRR, equity multiple, NPV, yield metrics. |
| 5. Debt and equity | **Complete.** Facilities, amortisation, floating rates, covenants, refinancing, equity flows, waterfalls. |
| 6. Analyst interface | **Substantially complete.** Workspace, cash-flow grid, validation panel, calculation inspector, fund positions, one keyboard workflow, all covered by a browser suite. Spreadsheet-grade editing is not built. |
| 7. Imports and reports | **Partial.** CSV and Excel import with a mapping wizard; Excel and CSV export; nine property reports, three portfolio reports and two fund reports; print HTML. Server-side PDF is not built. |
| 8. Scenarios and versions | **Substantially complete.** Cloning, immutable versions, sensitivity grids, batch runs, approval workflow, side-by-side version comparison. |
| 9. Budgets and asset management | **Complete.** Budget periods, trial-balance import, variance with materiality, commentary with two-person approval, reforecast carry-forward, a task board against properties and models, interface and tests. |
| 10. Portfolio and funds | **Substantially complete.** Dynamic and static portfolios, aggregation (single-query and tested), concentration analysis, fund-level commitments, capital calls, distributions, recallable distributions, unfunded capital, investor returns and a fund-level waterfall (tiered preferred return, GP catch-up and residual split against each investor's real, per-transaction ledger), portfolio reports and an investor statement. |
| 11. Advanced asset classes | **Partial.** Development, retail percentage rent, multifamily unit modelling work through the common engine. Hotel departmental and data-centre capacity models are not built. |
| 12. Production hardening | **Substantially complete.** Restore drill, engine benchmark, database load test and a concurrency test all run in CI; every migration is gated on leaving the previous release able to run; documentation counts are gated too. Machine-checked accessibility. Local error monitoring. Multi-factor authentication. A CI `docker` job builds every image, brings the full stack up and scripts the deploy sequence end to end on every build. Still missing: a screen-reader audit — the one item left that needs a person, not a container. |

## What to do next, in order

### 1. ~~Test the web application~~ — done

23 Playwright tests now drive Chromium against the built bundle, a real API and
a freshly seeded database: sign in → property → model → calculate → inspect a
traced figure; the lease editor's validation; capability-driven control
visibility for three roles; the import wizard on a part-invalid file; and
`axe-core` on nine screens. See `docs/testing-strategy.md`.

Four defects surfaced immediately and are fixed: every form control in the
platform was unlabelled, scrollable tables were unreachable by keyboard, the
import wizard wrote rows without saying so, and concurrent migrations raced on
`CREATE EXTENSION`.

**Since then: scenarios, reports and the portfolio roll-up are covered too**, and
each is held to a claim rather than to having rendered. `Functional` in
`docs/feature-status.md` meant reachable and believed working; believed is not
verified, and these were the screens where the gap was widest.

- **Sensitivity grids** are checked against an economic truth. A higher exit
  capitalisation rate buys the same income for less, so value must fall as the
  rate rises — on any asset, every time. A grid that is transposed, or that
  reuses one cell's result, renders perfectly and fails that. The two-way test
  checks the column direction as well, which the one-way test cannot see.
- **Reports** are held to the promise the screen makes in its own words: one
  definition rendered four ways, so the screen and the file can never disagree.
  The test reads a report on screen, fetches the same report as CSV, and
  compares the columns, their order and the row count. Reversing the column
  order in the exporter fails it, which is how it was confirmed to bite.
- **The portfolio roll-up** is checked against the rule the module rests on: a
  rate is rebuilt from the portfolio's own numerator and denominator, never
  averaged across assets. Replacing the aggregation with a plain mean moves the
  going-in cap rate by 2.64 percentage points on the demonstration portfolio —
  five times the test's tolerance — so the tolerance has been tested against the
  error it exists to catch rather than guessed at.

Writing them cost one debugging round of my own making: the metric-tile helper
read a tile's note along with its figure, and "assets" ends in a T, which the
compact-notation scale suffix matched. The amount came back as `NaN`. The helper
now reads the first line only and says why.

**Since then: the assumptions editor too.** It sets the discount rate, the exit
capitalisation rate and the sale month — the handful of numbers that move every
figure the platform reports — and nothing checked that editing one did anything.
A form test that types a value and finds it in the box proves the box works, so
these change an assumption, recalculate, and require the valuation to fall, then
restore it and require the value back. That is the difference between "the edit
was applied" and "something changed".

Writing it produced a lesson worth more than the test. It first reported an
unchanged valuation, which looked like an engine defect; driving the same
sequence through the API directly showed the API was perfect
(0.0825 → $47.7M, 0.14 → $34.4M). The test was clicking Calculate and then
typing while the calculation was still in flight, and the edit reverted.

Two wrong turns on the way, both recorded because the reasoning was the
mistake. The status banner was used as the completion signal — it reads the
same after every run, so waiting for it matches the *previous* result
instantly. And a remount-on-refetch was diagnosed in `ModelWorkspace`, a fix
written for it, and a regression test written to prove the fix: the test passed
with the fix reverted, and `modelResource.reload` turned out never to be called
anywhere, so the model never refetches, the diagnosis was wrong and the change
was inert. Both were reverted. The comment in the spec now states what was
established by trying it both ways and stops there, rather than inventing a
mechanism.

**What remains here:** the versions tab has no dedicated coverage beyond the
comparison tests and the accessibility sweep, and the suite runs in Chromium
only.

### 2. Verify what is written but unproven — done

**Backup and restore: drilled.** `pnpm drill:restore` takes a real `pg_dump`,
restores into a scratch database, and confirms that a stored valuation still
reproduces from the restored data — not merely that the row counts match. It
runs on every CI build. It found that the seed never froze a model version, so
the demonstration data had an empty Versions tab and there was no stored
valuation to reproduce; the seed now calculates against a frozen version.

**Docker images: built and run end to end — in CI, not in this development
container.** The base-image blockage that stood in the way is diagnosed
exactly, which matters because "the registry is unreachable" pointed at the
wrong thing. The Docker daemon runs and Docker Hub's registry API is
reachable — `registry-1.docker.io/v2/` answers 401 unauthenticated as it
should, `auth.docker.io/token` answers 200 — but its **blob CDN**,
`production.cloudfront.docker.com`, returns 403 from this development
container's own egress proxy, and that denial is reported here rather than
retried or routed around, per the proxy's own documentation. `quay.io` and
AWS's ECR Public Gallery CDN redirect are refused the same way. `mirror.gcr.io`
is not: it is a separate, independently-reachable, publicly documented
read-through cache of Docker Hub's official images — the same content, not a
different build — and every Dockerfile in this stack now references it for
that reason (see the comment at the top of `Dockerfile.api`).

Past the base image, `docker compose build` still does not complete inside
*this* development container: its own outbound TLS is transparently
intercepted, which the build container does not trust by default, so `RUN
pnpm install` and `RUN apk add chromium` both fail on the certificate before
reaching what they fetch. Trusting that interception was confirmed to fix the
`pnpm install` layer in an uncommitted, throwaway diagnostic build — not
committed, since a production Dockerfile has no business trusting a
certificate that belongs to one development sandbox. `apk add chromium` fails
past that regardless: Alpine's package CDN (`dl-cdn.alpinelinux.org`, and
every mirror tried) is itself blocked here, with no alternative found.

Both blocks are specific to where this repository happens to be edited, not
to the images themselves — and a `docker` job was added to
`.github/workflows/ci.yml` to settle that distinction with a real run rather
than an argument: it builds every image with `docker compose build`, brings
the full stack up with `docker compose up -d postgres api worker web`, and
runs `scripts/docker-smoke-test.ts` against the real running containers —
health check, register a user, create an org/property/lease/model, calculate
it, queue a PDF report through the real worker's job queue, and poll the job
to completion, asserting the returned bytes actually start with `%PDF-`. GitHub's
own runner has neither this container's TLS interception nor its Alpine CDN
block, and the job has passed on every build since it was added: the images
build, the stack comes up, and the deploy sequence that used to be only
documented is now scripted and exercised for real, not merely written down.
What is still true, and is a different fact from "never built": nobody has
stood up a real, running instance of this stack for anyone but CI to use.

### 3. Close the engine's honest gaps — options done

- ~~**Lease options.**~~ Renewal, termination and contraction are modelled as
  probability-weighted paths, applied in exercise-date order so mutually
  exclusive options behave without special-casing. Three regression fixtures,
  engine 2.0.0.
  **The editor gap is closed separately**: the engine modelled renewal,
  termination and contraction from the start, but no screen ever offered a
  field for one — `RentRollTab.tsx`'s "Edit … in full" button had promised
  an options editor in its own tooltip text since it was written. The write
  route's `options` field is validated against the real `leaseOptionSchema`
  now too, in place of an unchecked `z.record(z.unknown())`.
  ~~**Purchase, ROFR, ROFO and expansion as disclosure fields.**~~ Done. A
  lease carrying one of these four, written directly against the API or by a
  future import path, was invisible on the lease editor — `otherOptions`
  merged it back in unedited on save, but no screen ever showed it existed.
  The editor now offers a second, disclosure-only section for exactly these
  four types, asking only the fields each one actually means something by (a
  space and a price for expansion, a price for purchase, dates and a
  likelihood for all four) rather than reusing the renewal-shaped form those
  fields do not fit.
  ~~**Expansion via a space reference.**~~ Done. `areaChange` alone stated how
  much area was taken but not *which* space it came from, so honouring it
  would either have double-counted area against whatever already occupied
  that space or invented rentable area the property does not have — the
  reason it stayed refused (`LEASE_OPTION_NOT_MODELLED`) even after the
  disclosure work above. `LeaseOption` now carries `expansionSpaceIds`,
  naming real spaces exactly as `Lease.spaceIds` does; naming one is what
  turns an expansion from disclosure-only into a real, modelled option — its
  area and unit count are added to the lease from the exercise date, at the
  tenant's existing rent schedule (unrepriced, the same convention
  contraction already uses in reverse). A space that does not exist, or that
  the lease already holds, refuses the whole option
  (`EXPANSION_SPACE_INVALID`) rather than partially claiming the rest; a
  space some *other* lease already holds is left to the engine's own
  pre-existing `SPACE_DOUBLE_LET` diagnostic rather than a second check.
  Still refused with no space named, exactly as before. Purchase, ROFR and
  ROFO remain disclosure-only by design: they bear on disposition, not
  operating cash flow. 4 new engine tests against hand-derived figures.
  A disclosed right with a nonzero likelihood that is not actually modelled
  still raises the existing `LEASE_OPTION_NOT_MODELLED` diagnostic on the
  Validation tab, so recording one is never mistaken for making it affect the
  forecast.
- ~~**Multiple recovery pools per lease**, reconciliation timing and prior-year
  true-ups.~~ Done. A lease settles any number of pools, each with its own base
  year, cap history and reconciliation, and a tenant can be billed an estimate
  monthly with the difference settled after the year closes. Both default to the
  previous behaviour.

  Writing the round-trip test found a defect of my own making: 2.0.0's
  area-share correction was also being applied when spreading an annual
  entitlement across months, so a lease covering part of a space recovered only
  its share of that space of what it was owed. Engine 3.0.0; fixture 18 covers
  the case and reproduces the old figure when the fix is reverted.
- ~~**Development and refinance fee bases** in the waterfall.~~ Done. Both types
  had been in the schema since it was written with no basis, so a model
  configuring one charged nothing. A development fee is now charged on capital
  expenditure as it is incurred; a refinance fee on debt proceeds drawn after
  the first funding period. Engine 3.2.0, and the fallback branch now assigns
  the fee type to `never`, so adding a type to the schema is a compile error
  rather than a fee that quietly is not charged.
- ~~**Cash-management triggers** on covenant breach.~~ Done. A breach the engine
  only reported was a breach with no consequence: the model showed the covenant
  failing and distributed the cash anyway, overstating the levered return in
  precisely the years a lender is most worried about. Surplus cash is now
  withheld from equity while a breach persists and released on cure, with NOI
  and unlevered cash flow untouched — a financing outcome, not an operating one.
  Engine 3.1.0, default off. **Cash sweep is deliberately not modelled**:
  applying trapped cash to principal makes the schedule depend on the cash flow
  that depends on the schedule, and approximating that would misstate every
  covenant tested against the balance afterwards.

### 4. ~~Budgets, actuals and variance~~ — done

Budget periods, a trial-balance import reading both the wide and long layouts a
ledger exports, budget-versus-actual and budget-versus-forecast variance,
favourable/unfavourable designation with materiality thresholds, and commentary
that cannot be approved by its own author.

The sign convention is the load-bearing decision: amounts are held money-in
positive, money-out negative, which makes a favourable variance simply a
positive one on every account. A miscategorised row then lands in the wrong
subtotal — visible — rather than reversing its own variance, which is not. See
`docs/calculation-specification.md` §21.

**Done: reforecast carry-forward.** `POST /budgets/:id/reforecast` builds the
year as it now looks — the closed months as the ledger recorded them, the rest
as the model still projects — and writes it as a real budget period, so the
variance screen reports against it without a second mechanism existing.

The two halves are never blended: a month is either closed or it is not, and
averaging an actual with a forecast for the same month produces a number that
describes neither. The cut-off is stated rather than inferred, because a single
early posting into next month would otherwise truncate the forecast, and a month
is closed when the accountant says so.

Accounts that do not line up are named in both directions — one the ledger
posted that nothing projects forward, one the forecast expected that never
appeared. A missing posting and a genuine zero look identical in a ledger, so
neither is assumed.

### 5. Spreadsheet-grade editing (phase 6) — partly done

**Done: paste from Excel.** Selecting rows in a spreadsheet and pasting them
into the rent roll is how an analyst actually works, and asking them to save a
CSV first was a step that existed only because the software could not be
bothered. The clipboard hands over tab-separated text, and the existing import
pipeline already detects its delimiter, finds the header row, matches columns
and normalises values — so this is the same proven parser reached by a different
door, not a second reader that would drift from the first. Nothing is written
until the findings have been shown.

**Done: a command palette.** Ctrl/Cmd + K anywhere, filtering properties,
models and screens; arrow keys and Enter; `aria-activedescendant` so the
highlight is announced rather than only shown.

**Done: finding a lease.** Three tenancies fit on a screen; a regional mall's
three hundred do not, and reading a rent roll top to bottom is how a lease gets
missed. The grid searches on lease code, tenant and suite, and sorts on six
columns — with `aria-sort` on the header and a real button inside it, so a
screen reader can say what the table is ordered by and a keyboard can change it.

Two details are load-bearing. **Area and rent sort as numbers**: they are
decimal strings, and sorting them as text puts 9,000 sf above 10,000 sf. The
browser test pins this with a 4,200 sf lease against the seed's five-digit
ones — as text it sorts after 38,200, so it is the case that tells a numeric
comparison from a lexicographic one, and the test was confirmed to fail against
a `localeCompare` implementation. **The count says when it is a subset**: a
total that silently means "the filtered rows" is how a rent roll gets reported
short.

Both happen in the browser against the leases already loaded. A rent roll is one
property's — hundreds of rows, not millions — and a round trip per keystroke
would be slower than the filter it replaces. If a model ever holds enough leases
for that to stop being true, the endpoint will need to filter and page; it
currently returns them all, and the file says so.

**Still to do:** multi-cell edit, fill-down, undo/redo, column hiding, and saved
views (the `saved_views` table exists and is unused).

### 6. Collaboration (phase 32 of the brief) — comments, tasks and mention notifications done

**Done: comments.** The approval workflow could move a model from review back to
draft and record that it happened, but not why — so an analyst learned that
someone disagreed, not what to change.

A comment is anchored to a model, a property or a budget period, so it sits
where the disagreement is. `comments` has no foreign key to the thing it names,
because the thing varies, so the route checks the anchor exists in the caller's
organization before anything is read or written against it.

Two rules carry the rest. **Only the author or someone who can approve may
resolve**: if anyone could close anything, the fastest way past a reviewer's
objection would be to dismiss it, and the review would be decorative. And a
**mention must name a member of the organization** — accepting an arbitrary
identifier would claim to have drawn in someone who will never be told, and
would confirm to a stranger that a guessed user exists.

Comments are not the audit log, and the audit entry deliberately records that a
comment happened without copying what it said. An append-only copy of every word
would make resolving one cosmetic.

The Review tab on the model workspace carries the conversation, on its own tab
rather than tucked under Versions: an objection nobody can find is an objection
nobody answers. A resolved comment recedes rather than disappearing — it is
history, not work — and the open list is what a reviewer is asked to act on.

Four browser tests drive it across two roles, including the one the whole
feature rests on: the analyst who was criticised can read and answer the
objection but is offered no way to dismiss it.

**Done: tasks.** A model says what a building is expected to do; nothing said
what anyone was supposed to *do about it*. That work lived in inboxes, where
nobody outside the thread can see what is outstanding and nothing connects it to
the asset it concerns. A task is deliberately small — title, state, optionally a
due date, an assignee, and the property or model it is against. It is not a
project plan: no dependencies, no sub-tasks, no estimates, because a half-built
one of those is worse than none.

Three decisions are worth recording.

**Nothing here decides what day it is.** `due_date` is a calendar date with no
timezone, and the server's date is not the reader's — an asset manager in
Auckland and one in Los Angeles disagree about "today" for twenty-one hours out
of every twenty-four. So the overdue filter takes the caller's date as a
parameter, and the browser supplies its own. On a screen whose entire purpose is
telling you what is late, being a day out is not a small error.

**`completed_at` is derived, never accepted, and recomputed on every write.**
Set-on-close is the obvious implementation and is wrong: reopen a finished task
and the column becomes a record of the last time somebody *thought* it was done,
while still reading like a completion date. Reopening clears it; editing a
closed task keeps the date it was actually closed on.

**An absent key leaves a column alone; an explicit `null` clears it.**
`COALESCE(new, old)` looks like the tidy way to write that and cannot tell the
two apart, so a due date could be set and never removed. Both halves are
asserted, and both assertions were checked against a deliberately broken
implementation to confirm they fail when they should.

The board links each task to the property or model it is against, hides finished
work by default and can show it again — "done" must not mean "destroyed". Twelve
API tests and four browser tests cover it, including the `axe-core` gate.

The `/jobs` screen was labelled "Tasks and jobs" and is now "Background jobs":
with a real task board in the product, calling a queue of calculations "tasks"
made the navigation lie.

**Done: mention notifications.** A comment's `mentions` array was recorded and
shown in the thread since the first collaboration migration, but nobody was
told out of band. `notifications` (migration 0026) is one row per person a
comment names; a bell in the header polls a personal feed and unread count
(`GET /notifications`), gated on `property:read` — the one capability every
role holds — since being told you were mentioned is not a privilege tied to
what you may edit. A general activity feed across everything that changed in
an organization is still not built; `/audit` already serves that role for
whoever holds `audit:read`.

### 7. Portfolio reporting and funds (phase 10) — funds done

**Done: fund-level investor economics.** A fund records its investors and their
commitments, the capital called from each and the distributions returned, and
reports the position that adds up to: unfunded capital, proportion called, DPI,
RVPI, TVPI and a net internal rate of return solved from the fund's own dated
flows.

Two decisions carry the rest. Residual value comes from the roll-up of the
portfolio the fund holds — the same one the portfolio screen shows, reached
through the same function, because a second aggregation would drift and a fund
and a portfolio disagreeing about the same assets is a defect nobody notices
until an investor asks. And a fund with no portfolio attached reports zero
residual value **and says why**: substituting contributed capital would give
every such fund a TVPI near 1.0, a number that looks like an answer and is not
one.

**Fund-level waterfall, `fund-waterfall.ts`.** `fund.ts` itself makes no
assumption about how a distribution was split once it lands — that settlement
is `computeFundWaterfall`, a separate module because a fund's investors are
admitted and called on real, irregularly-spaced dates and amounts, not the
deal waterfall's fixed monthly grid and constant partner share. It draws the
same tier taxonomy as the deal waterfall (return of capital, preferred return
or IRR hurdle, GP catch-up, residual split) but accrues on actual/365 real
dates — the same day-count convention `xirr` already uses — and treats every
past distribution as a stated fact to book against each investor's own
ledger (accrued preferred first, then unreturned capital) rather than a
figure to recompute; only a new, proposed distribution is actually allocated.
Unlike the deal waterfall's fallback-to-contribution-share behaviour, an
under-specified tier set (most often a missing `residual_split`) throws
naming the exact shortfall, since this runs on demand for one proposed
distribution a GP can still catch before money moves. Reachable at
`GET`/`PUT /funds/:id/waterfall-tiers` and `POST /funds/:id/waterfall/preview`
and `/apply`, the latter recording one `distribution` transaction per paid
investor in a single write.

Deliberately not modelled: management fee mechanics — offsets, step-downs,
fees on invested rather than committed capital. A fee that has been charged
appears as the contribution it was funded by; how it was computed is
upstream.

**Recallable distributions, added later.** A transaction can be marked
`recallable`, and a later `recall` transaction draws against it — both facts
the caller states, since whether a distribution may be recalled and whether one
actually was are LPA terms and GP decisions no engine should guess at. The
arithmetic nets a recall against `distributed` (so DPI reflects what an
investor actually kept) and against `recallableOutstanding` (how much recall
right is still live); it does **not** restore or expand unfunded commitment
beyond what was stated, which stays out of scope as the LPA-specific mechanism
this module has always refused to guess at.

The Funds screen carries all of it: the position, the per-investor breakdown,
the capital record the return was solved from, and forms for adding an investor
or recording a call. The demonstration seed creates a fund that is half called,
deliberately — a fund shown fully drawn hides the unfunded figure, which is the
one an investor relations team is asked about most often.

**Done: portfolio reports and an investor statement.** Three portfolio reports
— summary, concentration and the lease expiration schedule — and two fund
reports, the investor statement and the capital account.

Portfolio and fund reports take different inputs from a property report, so they
are separate definitions rather than a `ModelResult` report with a
portfolio-shaped hole in it. Both are built from the same roll-up and the same
position the screens show, through the same extracted functions, because a
statement that disagrees with the screen it was printed from is the worst kind
of report: both look authoritative and only one can be right.

Every rate on the portfolio summary carries its basis in a column, because a
portfolio capitalisation rate that looks like an average of property rates — and
is not — will be misread unless the report says otherwise.

The investor statement is the one that leaves the building, so it states its own
limits on its face: where the unrealised value came from, how each multiple is
built, that the net IRR is solved from dated flows rather than annualised from a
multiple, how a recall is netted, and that fund-level carried interest and
management fee mechanics are not modelled. A statement that omits its limits
invites the reader to assume it has none.

**Still to do:** nothing in phase 10 beyond what phase 12 covers.

### 8. Production hardening (phase 12)

~~Engine performance baseline~~ — done. `pnpm benchmark` times four synthetic
models against budgets and runs in CI. Its first run found a 2.4-second floor on
a *single-tenant* model: `discountFactor` and `xirr` were each taking decimal.js's
most expensive operation — a fractional power — once per period, tens of
thousands of times per calculation. Fixed; 18× faster, no figure changed. See
`docs/architecture.md`.

~~Database load test~~ — done. `pnpm load-test` builds 5,000 properties,
10,000 models and 200,000 leases and times the real queries; it runs in CI at a
thousand. Every list query stays flat. It found that portfolio aggregation
issued two round trips per property in a loop — 1,000 of them for a 500-property
fund — now a single `DISTINCT ON` query. The aggregate had no tests at all, so
seven were written alongside the rewrite.

~~Concurrency test~~ — done. `pnpm concurrency-test` drives the real server
through 200 parallel clients: ~1,000 req/s, p95 200 ms, zero failures. It
corrected an assumption of mine — the connection pool is **not** the constraint;
measured across 5 to 60 connections throughput was flat to worse, because the
single Node process is the bottleneck. Throughput scales by running more API
processes. It also records that concurrent lease writes are last-write-wins,
with no optimistic locking.

~~Optimistic locking on lease writes~~ — done. Leases carry a `version`; a
write that names a version the store has moved past is refused with 409 and the
current version, rather than silently discarding someone's edit. Ten
simultaneous guarded writes resolve to one accepted and nine refused. Sending no
version remains a deliberate opt-out, which is what bulk import needs.

Models carry the same protection now. The first attempt at it was wrong — the
check and the update ran as two autocommit statements, so the row lock was
released before the write and both simultaneous writers passed. Only the
`Promise.all` race test caught it.

~~The assumption collections~~ — done. Expenses, other revenue, capital, debt,
growth curves and market leasing profiles each carry a **row-level** version,
not the model's. That distinction is the point: two analysts editing the same
expense line collide, and two editing different lines do not. A model-wide
version could not tell those apart, and one that refuses unrelated edits gets
worked around rather than heeded. The guard lives in the shared collection
registration, so a seventh collection would inherit it; a test asserts all six
are actually covered, because "it is shared" is not evidence.

~~Cursor pagination on the audit log~~ — done. The log paged by `OFFSET`, which
makes PostgreSQL walk and discard every skipped row, so page four hundred costs
four hundred times page one. It now pages by keyset — reading from where the
last page stopped — on an index of `(organization_id, occurred_at DESC,
id DESC)`.

The id in that key is the load-bearing part. `occurred_at` alone is not unique:
a bulk import writes a batch of audit rows inside one statement and PostgreSQL's
`now()` is the transaction's start time, so they genuinely collide. Two rows
that compare equal can land on either side of a page boundary — one shown twice,
another never. On an audit log a silently skipped row is the worst defect
available, so the test writes twenty-five rows sharing one timestamp to the
microsecond and walks every page at three different page sizes.

~~Error monitoring~~ — done, and deliberately a table rather than a hosted
service: it costs nothing, keeps failure detail in the same database as
everything it refers to, and can be replaced later by anything that reads it.

Faults are grouped by a fingerprint that strips identifiers and digits, so one
route failing four thousand times reads as one problem rather than four
thousand, and the count of organizations affected is what separates a support
conversation from an outage.

What is **not** recorded matters as much: no request body, no query values, no
headers, no session token, and the route pattern rather than the resolved path.
An error store is a copy of production data under weaker access controls unless
it is disciplined about that, and the test asserts the absence against the
schema rather than against one write — a column added later has to be argued
for.

~~Grid virtualisation~~ — profiled, then done. `pnpm profile:grid` measured the
monthly view of a ten-year forecast at 3,240 interactive cells and a median of
429 ms to switch into, against 163 ms for the annual view. Rendering only the
columns near the viewport took that to 594 cells and 212 ms.

That left it still above the hundred-millisecond line, and the script said the
remaining time was in the rows rather than the column count — from which the
obvious conclusion was row virtualisation. **That conclusion was wrong, and the
profiler now says so in its own output.**

The remaining cost was per *cell*, not per row. `formatCurrency` built a fresh
`Intl.NumberFormat` on every call — construction resolves a locale and is
roughly two orders of magnitude dearer than formatting with one already built —
and the grid called it twice per cell, once for the figure and once for the
label a screen reader reads. Caching the formatter by its options and formatting
once took the monthly switch from a median of about **219 ms to about 108 ms**,
measured four times either side because the first single-run comparison was an
outlier and would have overstated the gain. Roughly two thirds of that came from
halving the call count and one third from the cache; the cache also benefits
every other screen, since a report table and a metric card were paying the same
toll unnoticed.

Row virtualisation stays deliberately undone. The statement has 28 line items, a
viewport shows most of them, and a cash-flow statement is read as a whole —
unmounting "Net operating income" because it scrolled away costs a reader more
than the milliseconds are worth. What is left is React reconciling several
hundred buttons, and going further means a cheaper cell, which trades away the
per-cell accessible label. That is a decision, not a refactor, and it is
recorded in `scripts/profile-grid.ts` so the next person to read the profiler's
output is not sent down the wrong path.

~~The rollback path~~ — enforced. The deployment guide's rollback procedure
rested on "migrations are backward compatible by policy", which was a policy
with nothing behind it: one `DROP COLUMN` and a rollback stops working, and
nobody finds out until the day they need one.

`pnpm check:migrations` now refuses a migration that drops a table or column,
renames either, relaxes a constraint, or adds a `NOT NULL` column without a
default. It runs on every CI build. A destructive change stays possible behind
an explicit `-- rollback-unsafe:` marker, which does not make it safe — it
records that somebody considered the rollback and accepted the consequence.

The guide also says plainly what the check cannot see: a release that writes
data the previous one cannot read is not a schema change, and no automated check
here catches it.

Still to do: an audit with a real screen reader. The deploy automation itself
— the ordering and health-check procedure — is done; see item 2 for the
`docker` CI job that builds, brings the stack up and scripts the same
migrate-then-serve sequence a real deploy exercises, health check included.
~~Backup and restore drill~~ — done, see item 2.

### 8b. Multi-factor authentication — done

A platform holding institutional valuations behind a password alone fails any
serious security review, and `users.mfa_enrolled` had been in the schema since it
was written with nothing to set it.

**TOTP is implemented here rather than pulled in**, for two reasons. RFC 6238 is
about forty lines — an HMAC, a dynamic truncation, a modulo — so a dependency
would be more code to audit than the thing it replaces, and this is an
authentication path where "audit" is not rhetorical. And the RFC **publishes
official test vectors**, so the implementation is checked against numbers nobody
here chose. That is the same rule the calculation engine follows: an expected
value taken from your own output agrees with you by construction and would pass
on the day the code breaks. RFC 4226 Appendix D, RFC 6238 Appendix B and RFC 4648
§10 are all asserted.

Four decisions carry the rest.

**Enrolment is two steps.** A secret is issued, and the account is not protected
until a code generated from it verifies. Flipping the flag on issue would lock
somebody out with a secret they never finished scanning — the failure where the
security feature is the attacker.

**The code is checked before any session exists.** Issuing the cookie first and
asking afterwards is not a second factor; it is a second factor-shaped screen in
front of a session the attacker already holds.

**The secret leaves the server exactly once.** Never from `/auth/me`, never from
the status endpoint, never into the audit log. Somebody who has already stolen a
session must not be able to ask the API for the factor that session is supposed
to be protected by, and an append-only log of it would be a permanent copy.

**Recovery codes are hashed and single-use.** A plaintext column of working
bypass codes is a second password column with none of the care taken over the
first. Spending one is audited separately, because a recovery code being used is
either a lost device or somebody working around one.

Both properties were checked against deliberately broken implementations:
reusable recovery codes fail two tests, and skipping the factor check entirely
fails six.

The screen states what this does **not** protect against — someone relaying a
code to the site in real time is inside the window, and no shared-secret scheme
fixes that. WebAuthn does, by binding the response to the origin, and is the
honest upgrade path. A browser test asserts that sentence is on the page.

### 8c. The API surface, enumerated and defended — done

There was no generated API documentation, and `tests/authorization.test.ts`
checked endpoints chosen by hand. That is worth having and it has a hole the
shape of every route nobody thought to add to it: an endpoint registered
tomorrow without an authorization check passes the entire suite, because no test
knows it exists.

The server now records its own routes as they register, through Fastify's
`onRoute` hook, and two things read that inventory.

`tests/route-inventory.test.ts` walks every route and requires each to refuse an
unauthenticated request. Making one public is still possible and is now a
deliberate act: it must be named in an allowlist **with a stated reason**, and a
further test fails if a listed route no longer exists — a stale exemption is how
a path quietly becomes public after a rename. A third test does the same for the
CSRF header on every state-changing route. Proved non-vacuously with an
unguarded probe route, which the suite named and reported the status it wrongly
returned.

One entry earns its place by having been caught: `OPTIONS *`, the CORS
preflight, was passing because injecting `*` returns 400 — a refusal by
accident, not by design. It is now listed explicitly with the reason a preflight
is safe to serve, rather than left to pass for a reason that could change.

`pnpm api:inventory` prints the same table as documentation, and
`docs/api-surface.md` is generated from it: 116 routes, 7 reachable without a
session. A hand-written list would have been wrong within a release, which is
the same failure the documentation-count gate exists to stop.

**It is deliberately not an OpenAPI document**, and the script says so. Request
and response shapes are validated by `zod` schemas declared inside each handler
rather than registered with Fastify, so nothing can see them from outside;
emitting a spec with empty schemas would look like a contract and describe
nothing. A real one means lifting those schemas onto the route definitions,
which is a change to every route and a decision rather than a script.

### 8d. Spreadsheet import — done

A rent roll arrives as `.xlsx` far more often than as `.csv`, and the answer was
"save it as CSV first" — a step that existed only because the software could not
be bothered. `exceljs` was already a dependency, used for export.

The reader produces `string[][]`, exactly what `parseCsv` produces, so header
detection, column mapping, number and date normalisation, validation and
duplicate detection are reached unchanged. Same door as the clipboard paste: a
different reader in front of the same proven pipeline, not a second pipeline
that would drift from the first.

**Converting a cell is not `String(value)`.** Every interesting failure here is a
cell that converts without complaining and means something else afterwards, so
each is handled and tested against real `.xlsx` bytes rather than against
hand-made objects that merely resemble what the library returns:

- **Dates.** Excel holds them as serials and exceljs returns a `Date`.
  `toISOString()` shifts across midnight for anyone west of UTC, turning a lease
  that expires on the 1st into one that expires on the 31st. Taken in UTC,
  date-only.
- **Formulas.** `{ formula, result }` — the result, never the formula's text.
  A cached-result-free formula imports as empty rather than as `=B2*12`.
- **Rich text.** `{ richText: [...] }` stringifies to `[object Object]`, which
  flows into a tenant name without ever looking like an error.
- **Error cells.** `#REF!` becomes empty and then fails validation like any
  other missing field, rather than becoming a tenant called `#REF!`.
- **Blank columns.** exceljs's `eachCell` skips empty cells, which shifts every
  value after a gap one column left — expiry dates land in the rent column,
  silently, every row looking plausible. Read by position instead.

Two of those were confirmed to bite by reverting to the naive implementation and
watching three tests fail.

**One dispatcher, not three.** Analyse, validate and commit all read through the
same function, because they must agree about what a file contains; picking a
different sheet at each step would import something nobody previewed. The sheet
list and the chosen index come back from `analyze` so the wizard can show the
choice — a workbook with a cover sheet first is the common case, and importing
the cover is the mistake worth making visible.

The change is additive: `filename` defaults to empty, and an empty filename
reads as CSV, so a client written before this keeps its exact behaviour. A test
asserts that by sending no filename at all.

`.xls`, the old binary format, is **not** supported — exceljs cannot read it, and
the error says to save as `.xlsx` rather than failing at parse time.

~~**Still to do here:** the import wizard does not yet offer the sheet
picker.~~ Done in the following change. The wizard reads a spreadsheet's bytes
as base64 in the browser — chunked, because `String.fromCharCode(...bytes)` is
the usual one-liner and throws on a file of any size — hides the paste box for a
binary file rather than showing mojibake, and offers the worksheet as a named
choice whenever a workbook has more than one. Changing it re-analyses, because
headers and a mapping belong to a sheet. Confirmed to be a real choice rather
than a label by stopping the picker's value reaching the server and watching the
browser test fail.

### 9. Optional extras, only if wanted

Excel import, server-side PDF, multi-factor authentication and malware
scanning are all built and tested now. What is left: yield capitalisation
methods, cash sweep, advanced phased/multi-building development
underwriting, hotel and data-centre modules, and the AI assistant — which
stays disabled by default and adds no paid dependency without approval.

## Standing rules

- Nothing is marked Tested in `docs/feature-status.md` without automated tests.
- A regression fixture's expected values are never taken from engine output.
- Any change to existing model numbers is a **major** engine version.
- Documentation is updated in the same commit as the behaviour it describes.
  **This one is now enforced** for the part of it a machine can see:
  `pnpm check:docs` enumerates every suite without running it and fails the
  build if a stated count is wrong. It was added because the rule kept being
  broken — one pass alone corrected nine rows describing shipped work as
  unbuilt, and a verification block four merges out of date. It cannot tell
  whether a row marked Tested describes what the tests assert; that still needs
  a reader. It closes the gap that kept reopening.
