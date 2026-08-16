# Commercial gap analysis

What the repository actually has today, checked against `docs/commercial-
product-strategy.md`'s direction and the 65-point commercial-productization
milestone it was scoped from. Every row is graded against real code — a
route, a table, a screen, a test — not against intent. **Existing** means
built and reachable today; **Partial** means real infrastructure exists but
the commercial capability built on it does not; **Missing** means nothing
exists; **Not needed yet** means deliberately deferred, with the reason
stated.

This document does the sequencing the milestone note asked for
(`docs/commercial-gap-analysis.md`, its own Milestone 57) and reproduces its
Phase A–D priority order (Milestone 58) with adjustments where the audit
below changes what is actually next. Only Phase A is in scope for near-term
implementation.

## Phase A — Pilot foundation

| # | Capability | Status | Notes |
| --- | --- | --- | --- |
| 1 | Merge the assumption-import branch | **Done** | PR #43, merged into `main`. `cre-assumption-import` v1 and `cre-property-research` v1 (contracts) are both in `main` as of this analysis |
| 2 | Production deployment path | **Partial** | CI builds, tests, migrates and runs the licence gate on every push. Docker Compose is designed but has never actually been built end-to-end in this environment (blocked on an egress-policy host, per `docs/feature-status.md`). No environment separation, no secrets-management story beyond `.env`, no exercised rollback |
| 3 | Organization admin improvements | **Done** | `apps/web/src/pages/Organization.tsx` is the consolidated screen: plan (read from entitlements), the full member list with role changes and removal, and an invite form — all in one place, all gated on the real `member:manage`/`organization:invite` capabilities (a caller without `member:manage` never issues the members request, rather than being shown a 403). Reached from primary navigation. What this item did *not* try to fold in: MFA (`Security.tsx` is a personal-account setting, not an organization one, and stays separate) and audit export (`AuditPage` already does that job and duplicating it here would be the second admin screen this item exists to avoid) |
| 4 | Customer onboarding | **Partial** | Investigating item 3 surfaced a harder blocker than "no guided tour": there was no way for a brand-new account to create an organization *at all* — every screen sat behind a dead-end "select an organization" message. `CreateOrganizationForm` closes that: a zero-organization account is offered the form in place of the dead end, and creating one auto-selects it (the server already switches the session; the client just re-fetches it). `AcceptInvitationPage` (`/accept-invitation`) closes the other half — a token from item 3's invite form now has somewhere to go. Fixed one real, pre-existing bug found while wiring this up: `SignInPage` force-navigated to `/` after sign-in, silently discarding any deep link (an invitation, a shared model URL) a signed-out visitor had followed — removed, since `Shell` already resolves the real route once the session exists. Still missing: any *guided* first-run tour once an organization exists (an owner still lands on an empty dashboard with no pointer to "start your first underwriting"), and self-registration has no UI at all — `POST /auth/register` is real and tested, but reachable only by a direct API call, so inviting someone with no account yet still needs one created for them out of band |
| 5 | Application version / release info | **Done** | `APP_VERSION` (`apps/api/src/version.ts`) and `ENGINE_VERSION` are both returned by the public `GET /api/v1/health` and shown in the app's own navigation ("App 0.1.0 · Engine 3.3.1"), so establishing what a support conversation needs never depends on a valid session |
| 6 | Product entitlements | **Done** | `organization_entitlements` (migration 0016) holds plan, status and a closed feature list per organization. `canUseFeature(entitlements, feature)` in `@cre/domain-models` is the one centralized check — not coupled to Stripe or any payment vendor, per the milestone's own instruction. Wired into a real route as proof it is live, not inert: `POST .../assumption-import/apply` refuses with `402 FEATURE_NOT_AVAILABLE` when the organization's plan does not include `assumption_import`. `requireFeature` in `apps/api/src/context.ts` is the one call site a future route adds to gate a feature, mirroring how `requireCapability` gates a role. `GET /auth/me` returns the caller's entitlements. Not yet done: a self-serve or admin screen to change plan/status — today only `updateEntitlements`/`applyPlanDefaults` exist, called directly, which is enough for this phase and deliberately not a UI yet |
| 7 | Trial / internal organization state | **Done** | Every organization gets a `trial` row at creation (`createOrganization`, in the same transaction, so one never exists without the other), defaulting to the `starter` plan with a 14-day `trial_ends_at`. `canUseFeature` grants a trial or internal organization every feature regardless of its nominal plan, so a pilot organization can use the whole product during evaluation. `suspended`/`cancelled` deny every gated feature; `active`/`past_due` are gated by the plan's own list, with `past_due` deliberately treated as a grace period rather than an immediate lockout. Existing organizations were backfilled to `trial` by the same migration, so this never collapsed a working organization's access. Model-level status (draft → … → approved → published → archived) remains a separate, untouched system, exactly as this document said it should. **Deliberately not done in this slice**: a global preHandler that blocks writes for a `suspended`/`cancelled` organization across every route. `isAccessSuspended(entitlements)` exists for that purpose, but wiring it everywhere would mean making `requireCapability` — called at dozens of route sites — async and DB-backed, which is a materially larger and riskier change than this slice. Tracked as follow-up work, not silently dropped |
| 8 | Feedback / support IDs | **Partial** | Support IDs are now done: an unhandled fault returns a short reference (`ERR-482910`, built from the same row `recordError` already writes) which the client shows next to *"Something went wrong,"* and `GET /operations/errors/reference/:reference` resolves one back to the fault for a support conversation, gated on the same `audit:read` capability as the rest of operational history. Still missing: an in-app feedback form (bug/feature-request/question, current route, app and engine version) — support IDs answer "what broke," not "the user wants to tell us something" |
| 9 | Data export / offboarding basics | **Partial** | The organization-level "export everything" action now exists: `GET /organizations/:id/export`, gated on `organization:manage`, returns every property and model the organization owns — each model as the same portable, documented, non-proprietary JSON format the existing single-model export already produces — in one downloadable file, independent of staying a customer. Reachable from the new Organization admin screen (PR building on item 3). A thirteenth audit pass found the document's own "everything the organization owns" claim was not actually true: budget history, uploaded-document metadata, the model version/approval audit trail, comments, tasks, portfolios and every fund's investors and transactions were all silently absent, with nothing in the response saying so. Fixed — the export now includes all of it (`formatVersion` 2). Two things still genuinely missing: actual document *file content* (only metadata — filename, size, checksum — travels; the storage key is deliberately opaque and does not resolve to a portable file reference) and the deactivation/offboarding *workflow* itself — suspending or deleting an organization, and what happens to its data after. Export existing without either of those is a reasonable order (a customer needs to get their data out before anything is torn down), but neither is built |
| 10 | Pilot readiness checklist | **Missing** | This document and `docs/pilot-readiness.md` (not yet written) close it |

## Phase B — Commercial underwriting workflow

| # | Capability | Status | Notes |
| --- | --- | --- | --- |
| 11 | New Underwriting start flow | **Done** | `POST /underwriting` (`apps/api/src/routes/underwriting.ts`) creates the property and its first model together in one transaction — `createProperty` and the same raw `models` insert `POST /models` already uses, wrapped in `request.db.begin(...)`, so a failure on either half leaves neither behind. Reuses `propertyBody` and `modelAssumptions` (now exported from `properties.ts`/`models.ts`) rather than redefining a subset of either. The UI (`apps/web/src/pages/NewUnderwriting.tsx`, route `/underwriting/new`, nav-gated on `model:write`) is one form, one submit, and lands the analyst directly on the new model's own Assumptions tab (`/models/:id/assumptions`) rather than back on a list they have to click through again. What this does not attempt: it does not offer a "deal type" preset for the model's own scalar valuation fields (sale cost %, terminal cap rate, discount rate) beyond the same sensible defaults the two standalone forms it replaces already used — that remains the piece noted under item 13 below, deferred deliberately rather than bolted on here without a real design for what a preset picker should look like |
| 12 | Model templates | **Missing** | No organization-level template concept. Every model starts from the same defaults |
| 13 | Organization assumption libraries | **Partial** | Every reusable-*collection* family is now done: growth curves (`growth_curve_templates`, migration 0020, plus `growth_curves.source_template_code`/`source_template_name`, migration 0021), market leasing profiles (`market_leasing_profile_templates` plus `market_leasing_profiles.source_template_code`/`source_template_name`, both migration 0022), operating expenses (`operating_expense_templates` plus `operating_expenses.source_template_code`/`source_template_name`, both migration 0023), and debt facilities (`debt_facility_templates` plus `debt_facilities.source_template_code`/`source_template_name`, both migration 0024). All four follow the identical pattern: an organization-scoped, code-addressable template table (`GET`/`PUT`/`DELETE /organizations/:id/<family>-templates/:code`, gated on `model:write`); a `TemplateLibraryCard` on the Organization admin screen (one generic component, parameterized per family — see `apps/web/src/pages/Organization.tsx`); a "Start from library" picker on the model's own collection editor that seeds a new row's fields, opens the collection's own structured `RecordEditor` directly (`AssumptionsTab.tsx`'s `beginFromTemplate`) and stamps the provenance snapshot, never a live reference, so editing or deleting a library entry afterward neither breaks nor silently changes a model that already applied it. Debt facilities are the one family where the template genuinely cannot cover every field: commitment, funding date and term are inherently deal-specific (a dollar amount and a closing date sized to one acquisition), so the template seeds them with placeholder defaults the analyst is expected to replace — the fifteen-odd structural fields (rate type, fees, covenants, amortization shape) are what the template actually saves retyping. **Still remaining**: acquisition/disposition assumptions (sale cost %, terminal cap rate, acquisition costs, discount rate) are scalar fields directly on `models`, not a collection, so the code-addressable template-table pattern above does not transfer — there is no row for a template to seed. These belong with Priority 2 (the New Underwriting entry flow) as a "deal type" preset that populates a new model's scalar valuation fields at creation time, rather than a fifth instance of the collection-template pattern forced onto fields that were never a collection |
| 14 | Deal pipeline | **Missing** | No stage-tracked list of opportunities. Properties and models exist as a flat list |
| 15 | Quick Underwrite | **Missing** | No simplified screening path; every underwriting today is a full model |
| 16 | Review / approval workflow | **Done** | `apps/web/src/pages/ReviewTab.tsx` is now the consolidated screen this item asked for: status and its transition buttons, a health-findings summary, an automatic comparison of the two most recent versions, and comments, all on the model's own Review tab rather than spread across Versions, Health and a comments-only Review. Nothing new was built underneath it — every card reads the same endpoint its old separate tab already used (`GET /models/:id/health`, `GET /models/:id/versions`, `POST /models/:id/transition`, `CommentThread`), so the consolidated screen can never disagree with what a reader would find by visiting those individually. The approval workflow (status + transition buttons) *moved* off `VersionsTab` rather than being duplicated onto both screens — deciding a model's status is a review action, not a version-history one — leaving `VersionsTab` as the full version list, manual snapshotting, and pick-any-two comparison tool for going further back than the latest two. The "what changed" card reuses `VersionComparison` (now exported rather than copied) with the two most recent versions pre-selected, rather than asking a reviewer to find and tick two checkboxes for the comparison they almost always want first. The health card is deliberately a summary, not the whole Health tab: findings that need attention are listed via the same `FindingRow` (now exported) the Health tab itself uses, but the key-value-drivers panel — which runs its own on-request engine passes — stays on Health, linked rather than duplicated. One real regression caught and fixed by this feature's own e2e spec before it reached the full suite: an early version of the spec snapshotted extra versions on the shared seeded office model to exercise the new "real comparison" card, which broke `e2e/versions.spec.ts`'s own exact version-row count on that same model — fixed by moving the snapshot-creating tests onto a freshly created, isolated model instead of touching versions.spec.ts's tested assertion |
| 17 | Material-change review | **Missing** | `version-compare.test.ts` proves the underlying capability (diffing two calculated versions) already works; there is no ranked, reviewer-facing "changes since last review" view built on top of it |
| 18 | Scenario comparison improvements | **Done** | `GET /properties/:id/scenario-comparison` (`apps/api/src/routes/properties.ts`) is the decision-oriented table this item was missing: every model on a property, side by side by what it actually calculated to. Nothing is recomputed — each model's own latest *succeeded* `calculation_runs` row is read exactly as stored, through the same `extractMetric` switch (now exported) the sensitivity grid already uses, so the table can never disagree with what that model's own Returns tab shows. A model with no succeeded run yet is still listed rather than silently dropped, with `calculated: false` so the client can say "not calculated yet" rather than guess from a blank cell. Surfaced as a self-hiding "Scenario comparison" card on `PropertyDetail.tsx`, appearing only once a property has two or more models — one scenario has nothing to compare against. One real bug found and fixed by this feature's own e2e spec: the comparison table's model-name cells were originally a second `<Link>` to each model, with the exact same accessible name as the existing "Models" table's own link a few rows above on the same page — a strict-mode collision the moment a property had two or more models, which would have broken navigation in most of this suite's own browser tests once `e2e/scenarios.spec.ts`'s clone test (which leaves a permanent second model on the shared seeded office property) ran before them. Same lesson as item 34's `WorkflowProgress`: fixed by making the scenario name plain text rather than a second link, leaving the "Models" table as the one place a model name is clickable |
| 19 | Underwriting report package | **Partial** | Nine report definitions across four formats already exist. No single "package" action bundling several into one output |
| 20 | Deal decision record | **Missing** | No proceed/pass/needs-more-work capture, structured or otherwise |

## Phase C — Monetizable differentiation

| # | Capability | Status | Notes |
| --- | --- | --- | --- |
| 21 | PDF assumption workflow | **Done** | `docs/claude-assumption-import.md`, merged in PR #43 |
| 22 | Property URL / address research intake | **Missing** (contract exists) | `cre-property-research` v1 schema exists and is tested; no intake UI, no Claude Skill, no live source |
| 23 | test1 local property/rent intelligence | **Missing** (contract exists) | `research-interfaces.ts`'s `Test1ResearchRequest`/`Test1ResearchResponse` types exist; test1 is a separate repository with no live endpoint wired to this one |
| 24 | test3 data-driven assumptions | **Missing** (contract exists) | Same status as (23); `ModelEstimate`/`Test3Recommendation` types exist |
| 25 | Subject-vs-market comparison | **Missing** (schema exists) | `ResearchComparison` and `ResearchCoverage` schemas exist; the deterministic comparable-selection/percentile engine that would populate them does not |
| 26 | Assumption research panel | **Missing** | No UI. Depends on (22)–(25) |
| 27 | Organization historical underwriting intelligence | **Missing** | No cross-model organizational query surface at all yet |

## Phase D — Scale

| # | Capability | Status | Notes |
| --- | --- | --- | --- |
| 28 | Billing-provider integration | **Missing, and deliberately not next** | No Stripe or equivalent. Correctly sequenced last: entitlements (Phase A #6) have to exist first so plan logic is centralized rather than coupled to a vendor |
| 29 | Commercial API | **Not needed yet** | The current API is internal-only, and `docs/api-surface.md` is explicit that it is not an OpenAPI contract. No credentials/scopes/rate-limit infrastructure for external callers exists |
| 30 | SSO / passkeys | **Missing** | Password + TOTP MFA only today (tested, real) |
| 31 | More enterprise controls | **Missing** | IP restriction, session policy configuration, SCIM: none exist |
| 32 | Advanced deployment / observability | **Partial** | Local error monitoring and CI gates exist; no multi-environment or hosted-observability story |
| 33 | Customer-specific configuration | **Missing** | No per-organization configuration of health thresholds, report layouts, or scenario naming |
| 34 | Underwriting workflow/progress surface | **Done** | `GET /models/:id/workflow` (`apps/api/src/routes/models.ts`) reports ten steps — Setup, Rent Roll, Imports, Operating, Capital, Debt, Calculate, Scenarios, Review, Output — each `done` state a real count read straight from the model's own rows (`getModelWorkflowCounts`, `packages/database/src/repositories/models.ts`): spaces, leases, operating expenses, capital items, debt facilities, applied import sessions, a succeeded `calculation_runs` row, sibling models on the same property, and the model's own status. Never a client-side "visited this tab" flag, which a reload or a second person opening the model would silently reset. Shown as a status strip on every model workspace screen (`apps/web/src/pages/ModelWorkspace.tsx`). Related to items 11 and 16 above but distinct from both: item 11 is the one-time entry point into a model, item 16 is the multi-step approval/comment workflow once a model is under review, and this is the standing at-a-glance summary of how far *any* model — new or old, in review or not — has actually gotten, read from data rather than navigation history. Deliberately not links to the tabs it summarizes: four of the ten step labels ("Rent Roll", "Imports", "Scenarios", "Review") are, by design, the same word as an existing tab in `ModelWorkspace.tsx`'s own `TABS`, and a second `role="link"` element repeating that exact accessible name would be indistinguishable, by role and name, from the tab itself to everything in the existing browser-test suite that already finds a tab that way — found by running the full `pnpm test:e2e` suite before pushing, which failed 34 tests the first time for exactly this reason. Rendered as a plain status list instead; the tab strip immediately below remains the one way to navigate |
| 35 | Consolidated Inputs/Import center | **Done** | `apps/web/src/pages/InputsTab.tsx`, a new "Inputs" tab (first after Cash flow in `ModelWorkspace.tsx`'s `TABS`) that answers "what does this model have, and where do I add more" in one screen instead of an analyst discovering, tab by tab, that inputs are spread across Rent roll, Assumptions (operating/capital/debt), Assumption import and Imports. Adds no second source of truth: it is a pure UI consumer of the same `GET /models/:id/workflow` item 34 already built, rendering one card per input family (Rent Roll, Operating, Capital, Debt, Assumption Extract, Rent Roll Spreadsheet) with that family's real status (done/optional/not started) and a link to the screen that adds more of it. The two import mechanisms this consolidates — `AssumptionImportTab.tsx` (paste a PDF/OM extract, reviewed side-by-side against the model's current values before anything changes) and `SupportTabs.tsx`'s `ImportsTab` (CSV/Excel rent-roll workbook: analyze → map columns → validate → commit) — are both linked to, not rebuilt; this item is purely the missing front door, not a third import pipeline. Two real bugs found and fixed while building this: (1) the exact same accessible-name collision documented in item 34 recurred one level down — the "Rent Roll" and "Rent Roll Spreadsheet" cards' own `<h2>` headings collided under substring matching, breaking the card-locator tests, fixed the same way (`exact: true` at the two call sites in `e2e/inputs-tab.spec.ts` that needed to tell them apart); (2) the CTA links used relative `to={card.tab}` paths, which React Router v6 resolves against the *current* route (`models/:id/inputs`), not its parent, so `to="rent-roll"` silently produced `models/:id/inputs/rent-roll` — no such route — and fell through to the catch-all redirect to `/`, caught by the same e2e test actually clicking through rather than only checking the link's `href`; fixed by switching to the absolute-path convention every other cross-tab `Link` in the codebase already uses (`/models/${model.id}/${card.tab}`, matching `ICSummaryTab.tsx` and `AssumptionImportTab.tsx`). No new API route, no schema change |
| 36 | Decision-oriented assumption review | **Done** | `ProvenanceTab.tsx` (item 5) already made deciding on a proposal a good experience *within* one model. What it could not do is tell a reviewer *which* models have something waiting — that required already knowing to open a specific model's Provenance tab. `GET /organizations/:id/assumption-proposals/pending` (`apps/api/src/routes/assumption-proposals.ts`) is the other direction: every pending proposal across the whole organization, oldest first, each carrying the property and model it belongs to and compared against that model's own current value (`listPendingAssumptionProposalsForOrganization`, `packages/database/src/repositories/assumption-proposals.ts`, joined against `models`/`properties` and grouped so `buildModelInput` runs once per distinct model behind the queue rather than once per proposal). Surfaced as a self-hiding "Assumption decisions waiting" card on the dashboard (`PendingDecisions` in `apps/web/src/pages/Overview.tsx`), each row linking straight to the model's own Provenance tab. Deliberately read-only and gated on the weaker `model:read` rather than a new capability: the route shows nothing a `model:read` holder could not already see by opening every model in turn, and every actual decision still goes through the existing per-model `model:write`-gated decision route, unchanged. No new write path, no schema change. Distinct from item 18 (no single base/upside/downside comparison table — a scenario-comparison gap, not a provenance one) and from item 16 (the multi-step approval/comment workflow once a model is under review — this queue is about assumption proposals specifically, and exists independently of a model's own review status). One real accessibility bug found and fixed, and only by the full `pnpm test:e2e` run rather than this feature's own spec in isolation: `e2e/provenance.spec.ts`'s own tests deliberately leave several proposals permanently pending on the shared seeded office model (to prove a proposal is kept rather than discarded until decided), so by the time `e2e/screen-reader.spec.ts` reached the Dashboard, four rows in the new card all carried the identical link name "Harborview Tower · Valuation - 31 December 2026" — indistinguishable to a rotor. Fixed by giving each link its own `aria-label` naming the specific target and source behind that row, keeping the visible text as the shorter property/model pair; a regression test now posts two proposals onto the same model directly and asserts their `aria-label`s differ |
| 37 | One-click underwriting package export | **Done** | `GET /models/:id/export/underwriting-package` (`apps/api/src/routes/reports.ts`) is one workbook, one click: the same property reports `/export/workbook` already bundles (item 13's family, `annual-cash-flow`, `rent-roll`, `valuation-summary`, `return-summary`, `lease-expiration`, `recovery-detail`, `debt-schedule`, `occupancy`, `model-validation`), led by a new first sheet — the investment committee summary — built by `buildIcSummaryReport` (`packages/reporting/src/reports.ts`) from the exact figures `ICSummaryTab.tsx` already reads on screen (`result.returns`, `result.valuations`, `result.debtSchedules`, and `assessHealth`'s own findings). Deliberately *not* a `ReportDefinition` in the shared `REPORTS` catalog: every other report's `build` takes only a `ModelResult`, but the risk section needs `ModelInput` too (`assessHealth(input, result)`), so widening that shared interface for one report was rejected in favor of a route composing the extra table by hand. Reached from a "Download underwriting package" button on the IC summary screen, beside the existing Print button, gated on the same `export:run` capability the other exports already use. Answers `docs/feature-status.md`'s own "no PDF export or emailed digest yet" note on the Investment committee summary row with a workbook rather than a PDF — chosen deliberately: `exceljs` was already a project dependency and no PDF-generation library exists anywhere in the codebase, so a genuinely zero-new-dependency package meant staying inside the tool already used for every other export, not adding one. One real test bug caught by a load-bearing check rather than a first-pass pass: an early version of the cross-check test flattened the whole summary sheet into one string and checked substring containment, which stayed green even after a hardcoded wrong value was planted in the Unlevered IRR row — because this test fixture has no debt, so unlevered and levered IRR are legitimately identical, and the real value still appeared elsewhere on the sheet next to Levered IRR. Fixed by reading the sheet as metric-to-value pairs instead of one flattened blob, which then failed for exactly the planted reason before the fix was reverted. A second, unrelated discovery: Excel's 31-character sheet-name limit truncates the long report titles this route reuses, so tests locate a sheet by position or by its first-row content (which `reportToWorkbook` always writes in full) rather than by its truncated name |
| 38 | Spreadsheet-grade editing: apply to selection | **Done** | `docs/feature-status.md` named the gap directly: "bulk edit as an explicit 'apply to N selected' dialog (fill-down and paste-one-value cover the same ground today)." An "Apply to selection…" toolbar button and inline form now live in the shared `DataGrid` component (`apps/web/src/grid/DataGrid.tsx`), so every grid built on it — the rent roll and five of the six assumption collections — gained the feature from one implementation. Distinct from fill-down: fill-down copies whatever the *top* cell in the selection already holds, so setting an unfamiliar value across many rows meant typing it into the first cell and then filling; apply-to-selection writes one freshly typed value to every selected cell directly, with no cell needing to hold it first. Restricted to a single column at a time by design — a value typed once has one unambiguous meaning, and a selection spanning a rate column and an area column at once would leave that meaning undefined. Reuses the grid's existing `commitRaw` write path unchanged, so an applied value is validated by the same per-column `parse` function as a typed edit and lands in the same one-action undo entry as fill-down or a paste. No new backend route, no schema change — this is entirely the existing batched, transactional write path, invoked with more entries at once |
| 39 | Research integration seam prep: comparable-selection engine | **Done** | `docs/property-research.md` named this precisely as "the natural next increment": a pure comparable-selection/percentile engine, buildable and testable without test1 or test3 existing. `buildComparison` (`packages/domain-models/src/research-comparison.ts`) is that engine — the `assumption-import-analyze.ts`-shaped sibling `ResearchComparison`/`ResearchCoverage` were designed for. Given a caller-supplied `ResearchObservation` array, it filters by metric and unit type, applies a recency window, computes min/p25/median/p75/max by linear interpolation, subject percentile and premium-to-median, and fences a 1.5×IQR outlier out of *this comparison's* statistics — every exclusion recorded in `coverage.exclusions` with a count and a stated reason, never silent, and the source `observations` array itself is never mutated, which is what "flagging rather than deletion" (the milestone note's own phrase) means in practice with a sample small enough to reason about by hand. Deliberately does not attempt geographic-distance filtering: `ResearchObservation` carries a free-text `geography` string, not a coordinate, so narrowing a candidate set geographically stays the caller's job — stated as a `coverage.limitations` entry on every comparison this produces, rather than a capability quietly assumed. Every statistic in the thirteen tests is hand-computed and checked, not asserted against the function's own output; a load-bearing check (temporarily disabling the outlier fence) confirmed the outlier test fails for exactly that reason before the fence was restored. Still not wired to anything live — no orchestrator, no test1, no UI calls this yet, exactly the boundary `docs/property-research.md` draws for what comes next |

## Post-milestone bug audit

A full-repository review of everything built across items 21–39 above, run
after the last of them merged, found and fixed three real defects — two
correctness bugs and one dead CSS reference:

1. **Workflow/progress surface regressed "Review" and "Output" once a
   published model was archived or superseded** (item 34). `GET
   /models/:id/workflow`'s `reviewed`/`published` booleans only recognized
   `'published'` itself, not the two states only reachable *from*
   `'published'` — so archiving a model that had completed the full review
   cycle made the progress strip report it as never submitted and never
   published, exactly backwards. Fixed in `apps/api/src/routes/models.ts`
   by including `'superseded'`/`'archived'` in both booleans, with a new
   regression test in `tests/underwriting-workflow.test.ts` that walks a
   real model through the full `analyst_review → manager_review → approved
   → published → archived` chain and asserts both steps stay done
   throughout — confirmed to fail for exactly this reason against the
   original code before the fix, via a load-bearing check.
2. **The comparable-selection engine silently coerced an empty string or a
   boolean observation value into a real 0/1 data point** (item 39).
   `Number('')` is `0` and `Number(true)`/`Number(false)` are `1`/`0` —
   both finite, so neither was caught by the "missing or not a number"
   exclusion, and either would have quietly dragged down a comparison's
   min/percentile/median without appearing in `coverage.exclusions` at all.
   Fixed in `packages/domain-models/src/research-comparison.ts` by only
   calling `Number()` on genuine `string`/`number` values and explicitly
   excluding the empty string, with a new regression test confirmed to fail
   against the original coercion before the fix.
3. **A dead CSS class reference** on the bulk-apply form (item 38):
   `grid-bulk-apply` was never defined in `styles.css` — harmless, since
   `.row` alone supplies the actual layout, but a class that looks like a
   styling hook and does nothing invites a future edit to assume it works.
   Removed.

A second pass, scoped this time to the core calculation engine and its type
layer (`packages/calculation-engine/src`, `packages/domain-models/src`) rather
than the session's UI-heavy work, found three further defects, all in
`aggregatePortfolio`/`computeDebt` — the highest-value place for a CRE
platform to be wrong, since these are dollar figures a reader trusts without
re-deriving by hand:

4. **Portfolio-level IRR and equity multiple were discounted from the
   member's concluded valuation, not what was actually paid for it.**
   `aggregatePortfolio` built its initial unlevered/equity outflow from
   `dcfValue(result)` — the property's concluded DCF or direct-cap value —
   while the property's own `unleveredIrr`/`leveredIrr` in `engine.ts`
   correctly discount from `acquisitionBasis + acquisitionCosts` and the
   equity actually funded at close. Buying below or above appraised value is
   the ordinary case, not a contrived one, so the two bases routinely
   differ, and a single 100%-owned member's portfolio IRR should equal its
   own property-level IRR exactly — it did not. Fixed by exposing the exact
   basis figures the property-level IRR was already computed from as two new
   `ReturnMetrics` fields, `initialInvestment` and `initialEquity`
   (`packages/domain-models/src/results.ts`, populated in
   `packages/calculation-engine/src/engine.ts`), and having
   `aggregatePortfolio` roll up those instead of re-deriving a basis from
   concluded value.
5. **The same portfolio cash-flow combination folded a levered figure into
   the "unlevered" series.** `netDispositionProceeds` is sale proceeds net
   of *debt payoff* — a levered figure, and the same one `leveredCashFlow`
   already accounts for — but `aggregatePortfolio` added it into
   `unleveredFlows` too, double-counting the loan's effect on the sale once
   as a levered figure standing in for an unlevered one, and again in the
   levered series. Fixed by adding back `grossSaleProceeds` net of
   `sellingCosts` instead — gross of any debt, exactly what `engine.ts`'s
   own `computeReturns` adds to build the property-level `unleveredIrr` this
   must match.
6. **The same combination also double-counted month-0 debt proceeds against
   the levered flows.** Month 0's `leveredCashFlow` already carries the
   loan's own proceeds landing in the account; `initialEquity` is *net* of
   that same debt (what was actually funded at closing after the loan), so
   summing the raw month-0 figure counted the debt-funded portion of the
   purchase twice. Fixed by subtracting `debtProceeds[0]` from month 0
   before combining, matching the same subtraction `engine.ts` already does
   when building the property-level `leveredIrr`. A new regression test in
   `packages/calculation-engine/src/portfolio.test.ts` asserts the
   fixable invariant directly: a single 100%-owned member's
   `portfolioUnleveredIrr`/`portfolioLeveredIrr`/`portfolioEquityMultiple`
   must equal its own property-level figures exactly, confirmed to fail
   against the pre-fix code (for all three bugs at once, one assertion at a
   time as each was found) via a load-bearing check.
7. **A facility that both capitalizes interest and amortizes computed a
   principal figure that corresponded to no real amortization schedule**
   (`packages/calculation-engine/src/debt.ts`). Once past the interest-only
   window, the loop capitalized that period's interest onto the balance
   *and*, in the same period, computed a level payment against that
   just-inflated balance, then subtracted the never-paid capitalized
   interest back out as "principal" — nothing was actually paid in cash to
   justify calling any of it repayment, so the resulting balance, DSCR, LTV
   and debt yield were all silently wrong for every period from there on. A
   construction-to-permanent facility (capitalize through lease-up, then
   amortize in cash once stabilised) is the ordinary shape this combination
   models, and no existing fixture or test exercised it — every
   `capitalizeInterest: true` fixture pairs it with `amortizationMonths: 0`.
   Fixed by only capitalizing while still inside the interest-only window;
   once amortization is due, interest is serviced in cash like any other
   amortizing facility. A new regression test confirms the facility now
   fully retires to an exactly-zero balance at the end of its own
   amortization schedule — the textbook property of a level-payment annuity
   recomputed each period, which the pre-fix code could not and did not
   reach, confirmed via a load-bearing check.

Also investigated and discarded as not a genuine defect: `MULTIPLE_CURRENCIES`
validation in `engine.ts` built its "distinct currencies" set from a single
one-element array (`new Set([input.currency])`), which can never have more
than one member since `ModelInput` carries exactly one top-level `currency`
field and nothing else in the schema names a currency. The check was
therefore unreachable dead code rather than a bug with an observable wrong
answer — but dead code masquerading as a validation gives false assurance
that currency consistency is being checked when it structurally cannot be.
Removed rather than fixed, since building a real multi-currency check would
require adding a second currency-bearing field to the schema, well beyond a
bug-fix's scope.

## Cross-organization security audit

Milestone 64 treats cross-organization exposure as unacceptable and asks
for authorization/isolation tests on every organization-scoped route. A
whole-repository sweep (prompted by a broader bug-check request, not tied
to a specific milestone item) found and closed three real cross-tenant
leaks, all of the same shape: a route's primary `:id` route param was
correctly checked against the caller's organization, but a *second*,
caller-supplied id reached a repository function that queried by that id
alone with no organization filter.

- `GET /models/:id/trace?runId=...` — `runId` reached `getTrace(sql, runId)`
  unchecked; `calculation_traces` carries no organization column at all, so
  any authenticated user who knew or guessed a run id could read another
  organization's full calculation trace (every formula and value that
  produced it).
- `GET /variance?comparisonModelId=...` — `comparisonModelId` reached
  `getLatestCalculation(sql, modelId)` unchecked, leaking another
  organization's forecasted NOI/cash-flow lines into a variance report.
- `POST /budgets/:id/reforecast` with `modelId` in the body — the same
  unchecked path, and on the write side: another organization's forecast
  was actually persisted into the caller's own budget record, not just
  displayed.

All three are fixed by verifying the secondary id against the caller's
organization before use — `getModel(sql, organizationId, modelId)` for the
two budgets routes, and a join to `calculation_runs` inside `getTrace`
itself (the trace table has no organization column of its own to check
directly). Each fix has a regression test in `tests/authorization.test.ts`
that was confirmed to fail against the unfixed code before the fix landed,
per this repository's own testing discipline. A repository-wide sweep for
the same shape elsewhere in `apps/api/src/routes/*.ts` found no further
instances — every other secondary id is either checked directly, derived
from an already-checked value, or filtered by organization in the same SQL
statement.

## What is already strong and should not be rebuilt

Worth stating plainly, because the temptation in a productization pass is to
assume commercial infrastructure means starting over:

- **The capability/role model is already commercial-grade.** Nine roles,
  a granular capability table checked on every route, cross-organization
  isolation tested with real dedicated tests (`tests/authorization.test.ts`).
  Admin UI and entitlements should sit on top of this, never replace it.
- **The model status lifecycle already matches what Milestone 6 asked for**,
  under different names (`draft`/`analyst_review`/`manager_review`/
  `approved`/`published`/`superseded`/`archived` versus the milestone's
  `Draft`/`Ready for Review`/`In Review`/`Approved`/`Archived`). No second
  status system should be invented.
- **The audit log, immutable versions, and comments are real and tested**,
  and are the correct foundation for the review/approval and material-change
  work in Phase B — not something to duplicate.
- **Error monitoring already groups and fingerprints faults server-side.**
  Support IDs (Phase A #8) are a client-facing surface over this, not a new
  monitoring system.
- **The Excel Live Model export and the PDF-assumption-import pipeline are
  both real, tested, and already follow the "contracts + deterministic
  engine, external system does the AI/scraping work" pattern** that the
  wider property-research architecture is built to extend.

## Priority rationale

Within Phase A, the audit above changes the practical order slightly from a
flat top-to-bottom read of the milestone list: items that are **Partial**
are cheaper to close than items that are **Missing** from zero, because real
infrastructure already exists underneath them. Items 5 (application version)
and the support-ID half of item 8 are now **Done** — 5 was nearly free
because the hard half (engine-version reproducibility) was already solved,
and it was a genuine prerequisite for 8, since a support reference is only
useful next to a version. Items 6 and 7 (entitlements and organization
lifecycle state) are now also **Done**, built together as one migration and
one domain module since a trial state is naturally one value in the same
table an entitlement plan sits in — see their rows above for what shipped
and the one thing deliberately deferred (a global write-blocking hook for
suspended organizations). Item 3 (organization admin) is now **Done**, and
building it surfaced a blocker outside its own scope — no account could
create an organization at all — which is why item 4 (customer onboarding)
moved from **Missing** to **Partial** in the same slice rather than waiting
its turn: an admin screen for managing members is not a real capability if
nothing can produce the first organization to administer. The practical
build order for the remaining Phase A work is: **9 → 4's remaining guided
first-run half → 8's remaining feedback-form half → 2 → 10**, with 2
(production deployment) gated on infrastructure this session cannot exercise
(see `docs/feature-status.md`'s standing blockers) and 10 (the checklist
itself) written last, once the items it checks are either done or honestly
marked outstanding.
