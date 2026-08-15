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
| 16 | Review / approval workflow | **Partial** | This is the most-built item in Phase B. Model status transitions (`draft → analyst_review → manager_review → approved → published/superseded/archived`) exist and are tested; comments exist and are anchored to a model (`ReviewTab`); immutable versions and side-by-side version comparison exist and are tested ("what was edited and what it did"). What is missing is a single consolidated review screen that pulls status, changes, health warnings and comments together — today they live on three separate tabs |
| 17 | Material-change review | **Missing** | `version-compare.test.ts` proves the underlying capability (diffing two calculated versions) already works; there is no ranked, reviewer-facing "changes since last review" view built on top of it |
| 18 | Scenario comparison improvements | **Partial** | Sensitivity grids and model cloning exist (`docs/feature-status.md`: "Functional"). No single decision-oriented base/upside/downside comparison table |
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
