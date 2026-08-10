# Commercial product strategy

Where test2 is trying to go as a paid product, for whom, and in what order.
This document is strategy and positioning; `docs/commercial-gap-analysis.md`
is the corresponding audit of what the repository actually has today against
that strategy, and `docs/implementation-roadmap.md` remains the file that
tracks engineering sequencing generally.

## Positioning

**Institutional-quality CRE underwriting with Excel flexibility, modern
usability, transparent calculations, data-driven assumptions, and
dramatically less repetitive analyst work.**

Test2 is not a clone of ARGUS Enterprise, and this document is not a plan to
become one. The commercial opportunity is combining, in one product, what
today a firm assembles from several:

1. Serious CRE calculation depth (ARGUS's territory).
2. Daily usability an analyst does not fight (Excel's territory, minus the
   fragility).
3. Transparent, auditable calculations (neither ARGUS nor Excel does this
   well — a cell reference is not an explanation).
4. Formula-driven Excel interoperability, so a model is never trapped in
   the platform (`docs/excel-live-model.md`).
5. Automated assumption intake from documents and, eventually, market
   research (`docs/claude-assumption-import.md`, `docs/property-research.md`).
6. Collaboration and institutional controls (review, approval, audit — a
   spreadsheet has none of this by default).

None of this is invented from scratch. `docs/product-requirements.md` and
`docs/feature-status.md` describe a calculation engine and an application
that already reach real depth. The commercial work is turning that into
something a firm can safely put a real deal through, trust the output of,
and pay for — not adding more modelling surface area for its own sake.

## The test: would a CRE firm pay for this?

From this point forward, every proposed feature is evaluated against this
question, and against whether it does at least one of:

- save analyst time
- reduce model errors
- improve reviewability
- improve collaboration
- improve consistency across a firm's deals
- improve market intelligence
- improve investment decisions
- improve reporting
- improve institutional controls
- make switching from ARGUS/Excel easier
- reduce training time

A feature that is only technically interesting does not clear this bar on
its own.

## Initial customer (ICP)

**Small-to-mid-sized CRE investment teams**: acquisitions firms,
owner/operators, private equity real estate, development firms, family
offices, investment managers, asset managers. Teams of roughly 3–40
underwriting-adjacent people, currently running deals through ARGUS
Enterprise, Excel templates, or both, without an internal platform team to
build something custom.

This is not "every CRE company." It is teams for whom a faster, more
transparent, Excel-compatible underwriting tool with automated intake is an
obvious upgrade over what they run today, and who are small enough that a
single sold seat matters to them — the segment ARGUS's enterprise sales
motion and pricing structurally underserves.

## Personas

**Analyst** — builds models. Needs speed, Excel interoperability, fast data
import, keyboard-first editing, transparent math, and easy scenario
analysis. This is the persona the existing spreadsheet-grade grid,
calculation inspector, and PDF-assumption import already serve well; it is
the persona every new commercial surface has to keep serving at the same
bar, not just the persona for whom the deepest modelling features exist.

**Associate / Senior Analyst** — reviews models before they go further.
Needs to see assumption changes, run comparable scenarios, comment, see
history, and have material risks surfaced rather than buried in a hundred
unchanged cells. Underserved today: comments, versions and audit exist, but
nothing yet aggregates "what actually changed and does it matter" into one
place (`docs/commercial-gap-analysis.md`'s Milestone 8 entry).

**VP / Principal** — consumes results, rarely edits. Needs the IC summary,
key assumptions, downside case, key risks, major value drivers, and an
approval action. Served reasonably well today by the IC summary, model
health and key-value-driver work; the review/approval side of this persona's
workflow is the larger gap.

**Admin** — runs the organization: members, permissions, billing, access,
security, data ownership. The capability and role model underneath this is
already unusually rich (nine roles, granular capabilities — see the gap
analysis); what is missing is a coherent admin *surface* over it, and
everything commercial (entitlements, trial state, billing) that a real
customer relationship needs and that does not exist yet at all.

## The wedge: acquisition underwriting

Test2 will not sell on breadth on day one. The first paid use case is
narrow and concrete:

**Underwrite an acquisition faster and more transparently than ARGUS + Excel.**

The flagship workflow:

```
Create property
  → import rent roll
  → import assumptions from an OM/PDF
  → (optionally) research the subject property
  → populate market assumptions
  → configure debt
  → calculate
  → run a downside scenario
  → inspect model health
  → export a formula-driven Excel model
  → produce an IC summary
  → review and approve
```

Every step above already exists in the product except three: a guided
starting point that strings them together for a first-time user (Milestone 3
of the commercial gap analysis), a consolidated review/approval experience
with material-change detection (Milestones 7–8), and the research-intake
steps beyond PDF (property-research is contracts-only today — see
`docs/property-research.md`). Closing those three gaps, on top of what
already exists, is most of what turns "a powerful set of screens" into "a
flagship workflow a firm can be sold on."

## What we are explicitly not doing yet

Matching `docs/commercial-gap-analysis.md`'s deferral list and the
milestone note this strategy was drafted from: hotel and data-center
modelling, multi-currency, yield capitalization, ROFR/ROFO/expansion
options, a CRM-grade deal pipeline, native mobile apps, payment-provider
integration, and enterprise-only controls (SSO/SAML/SCIM) ahead of having a
pilot customer who needs them. The engine already has enough underwriting
depth to begin commercial validation; the near-term work is making what
exists trustworthy and usable by a paying firm, not adding modelling
surface area.

## The moat

Not data lock-in — `docs/property-research.md` and
`docs/claude-assumption-import.md` both exist specifically so a customer's
own documents and models stay exportable and reviewable, and
`docs/commercial-gap-analysis.md` treats data export as a pilot-readiness
requirement, not a nice-to-have. The moat is meant to be **workflow and
accumulated organizational underwriting intelligence**: if a firm's analysts
prefer building every serious deal in test2 because it is faster, easier to
review, and more transparent than ARGUS + Excel, monetization gets easier
without needing to make leaving hard.

## Sequencing

Implementation is sequenced in `docs/commercial-gap-analysis.md` as four
phases — Pilot Foundation, Commercial Underwriting Workflow, Monetizable
Differentiation, Scale — and only Phase A is in scope for near-term work.
Payment processing is explicitly late: entitlements, admin, onboarding,
trial state, deployment and data safety come first, because a payment
button does not make software commercially ready, and coupling product
capabilities directly to a payment vendor before the entitlement model
exists is how that logic ends up scattered through the application instead
of centralized.
