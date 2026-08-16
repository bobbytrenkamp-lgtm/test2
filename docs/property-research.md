# Property research: architecture and status

How an analyst eventually starts from *a property* — a listing URL, an
address, an existing test1 geography — instead of manually assembling every
data source, and how what comes back stays honest about what is a fact,
what is a statistic, what is a model's opinion, and what is a recommendation.

**Read this before `docs/claude-assumption-import.md`, not instead of it.**
That document is stable and describes a shipped pipeline: PDF → Claude Skill
→ `cre-assumption-import` → paste → review → apply. This document describes
the wider architecture that pipeline sits inside, and — as of this writing —
**almost none of the wider architecture exists yet.** What is real is stated
plainly in the status table below; everything else is a contract with
nothing behind it, written down so the boundary between test2, test1 and
test3 is decided before any of it is built rather than improvised at
integration time.

## The vision in one paragraph

An analyst enters a property — a listing URL, a street address, a parcel, a
neighborhood, or an existing test1 geography — instead of manually
assembling every data source. The system identifies the subject, gathers
whatever is available from the supplied source, test1's geographic and
market intelligence, and test3's statistical models, and turns all of it
into **observations**, then **comparisons**, then **recommendations** — each
one a distinct, labelled kind of thing — which an analyst reviews and
accepts through the exact same assumption-proposal architecture
`docs/assumption-contract.md` already describes. Nothing here invents a
second write path.

## What is real today

| Piece | Status | Where |
| --- | --- | --- |
| `cre-property-research` v1 schema and parser | **Built, tested** | `packages/domain-models/src/cre-property-research.ts` |
| Semantic separation: observation / comparison / model estimate / recommendation | **Built, tested** | Same file — four schemas, structurally incapable of collapsing into each other; see below |
| Conversion of a recommendation into an existing assumption proposal | **Built, tested** | `packages/domain-models/src/research-to-proposal.ts` |
| The universal research-request contract | **Designed, typed, tested** — no orchestrator reads it yet | `packages/domain-models/src/research-interfaces.ts` |
| The test1 research-interface contract | **Designed, typed, tested** — test1 is a separate repository; nothing here calls it | Same file |
| The test3 recommendation contract | **Designed, typed, tested** — same status as test1's | Same file (re-exports `cre-property-research.ts`'s `ModelEstimate`) |
| Comparable-set selection / percentile engine (§10–17 of the milestone this was scoped from) | **Built, tested** | `packages/domain-models/src/research-comparison.ts`'s `buildComparison` — `assumption-import-analyze.ts`'s sibling, a pure function over a caller-supplied observation array. Filters by metric, unit type and a recency window (each exclusion recorded with a count and reason, never silent); computes min/p25/median/p75/max by linear interpolation, subject percentile and premium-to-median; flags a 1.5×IQR outlier out of the statistics without touching the source `observations` array, which is what "flagging rather than deletion" means in practice. Deliberately does not attempt geographic-distance filtering — an `Observation` carries a free-text `geography` string, not a coordinate, so narrowing the candidate set geographically stays the caller's job, stated as a `coverage.limitations` entry on every comparison this produces rather than implied by silence. Still not wired to anything live: no orchestrator, no test1, no UI calls this yet — it is exactly the increment the row below was already waiting on |
| Listing/property-URL Claude Skill | **Not built** | External to this repository by design — see *Boundaries*, below |
| Live test1 integration | **Not built** | test1 is a separate system; `research-interfaces.ts` specifies the shape a real integration would satisfy |
| Live test3 integration | **Not built** | Same status |
| Research orchestration layer (fan out to several sources, reconcile) | **Not built** | Downstream of the two integrations above |
| "Research this property" UI action | **Not built** | Deliberately last — see *Why contracts came first* |

If a section of the original milestone note is not named in this table, it
is not built. This table is the authoritative status; prose elsewhere in
this document describes intent, not completion.

## Why contracts came first

The milestone this was scoped from says it directly: *"prioritize
contracts... do not start with a giant dashboard."* A UI that calls nothing
real teaches an analyst to distrust the product the first time they use it.
A contract that is wrong costs a compile error the day the other side of it
is built. Building the schema, the semantic separation, and the conversion
into the existing proposal system first means every later piece — the
comp-selection engine, a real test1 client, a "Research this property"
button — has a fixed target to build against, checked by the type system
every time it's referenced, rather than a shape three different components
each guessed at separately.

## The four kinds of thing, restated

This is the rule the whole format exists to enforce, so it is worth stating
twice — once in the schema's own doc comments (`cre-property-research.ts`),
and once here.

- **Observation** — a fact a source stated. A listing's asking rent, an
  OM's stated occupancy, a nearby unit's advertised rent. Addressed by a
  free-text `metric` (`listing.askingRent`, `comp.rent`), not a test2
  target — because most observations are not about any field a test2 model
  has. Never authoritative for underwriting on its own.
- **Comparison** — a deterministic statistic computed from observations: a
  median, a percentile, a premium or discount, with its sample size and
  geography stated alongside it. Still not a recommendation.
- **Model estimate** — the output of a statistical or economic model (a
  test3-shaped result), named by its model and version, never anonymous.
- **Recommendation** — the *only* entry in this format that carries a real
  `assumptionTargetSchema` target and can become a test2 proposal. It must
  state a `methodology` — a recommendation that cannot say how it was
  derived is a guess wearing a recommendation's clothes.

`cre-property-research.test.ts`'s `semantic separation` suite asserts this
structurally, not just by convention: `researchObservationSchema` has no
`target` field to accidentally validate against, and
`researchRecommendationSchema` refuses to parse without both a real target
shape and a non-empty methodology.

## Asking rent, market observation, recommended rent, underwritten rent

Four numbers that must never collapse into one field, worked through an
example:

| Label | Kind | Where it lives |
| --- | --- | --- |
| "$2,150/month" | Listing's stated asking rent | `Observation`, `metric: "listing.askingRent"` |
| "$2,275/month" | Nearby comparable median | `Comparison`, `stats.median` |
| "$2,245/month" | test3's model estimate | `ModelEstimate` |
| "$2,250/month" | What the research recommends underwriting | `Recommendation` |
| "$2,200/month" | What the model currently underwrites | The model itself — resolved via `resolveAssumptionValue`, same as every other proposal comparison |

All five are shown together once a recommendation reaches the review screen
(the existing `ProvenanceTab`/Import-Assumptions-style pattern) — never
reduced to "the rent," and never with the listing's number privileged just
because it arrived first or came bundled with the property.

## The one integration point: `research-to-proposal.ts`

```ts
export function recommendationToProposalInput(
  research: CrePropertyResearch,
  recommendation: ResearchRecommendation,
): AssumptionProposalInput
```

This is the entire bridge into the existing, stable proposal architecture.
It resolves every citation a recommendation makes — its sources, the
comparisons it drew on, the model estimates it used — into a single,
self-contained `evidence` object, so a proposal converted from research
renders in the existing Provenance screen exactly like any other proposal's
evidence does, with no UI change required to see it. `sourceKind` is always
`'recommended'`: never `'imported'`, because a comparable set's median is
evidence for a recommendation, not a fact this platform is claiming to have
read verbatim from a document. There is no new write path, no new decision
route, and no new table — a converted recommendation is accepted or
rejected exactly the way every proposal always has been. See
`docs/assumption-contract.md`.

## Boundaries this document exists to hold

**test2 stays deterministic.** No LLM call, no browser automation, no HTML
scraping lives in this repository or is planned to. A listing URL becomes
research the same way a PDF becomes an assumption import: an external Claude
Skill retrieves and normalises it, and test2 only ever receives already
structured JSON.

**Access controls are never bypassed.** A URL source retrieves only what is
lawfully and ordinarily accessible — no authentication bypass, no paywall
circumvention, no CAPTCHA defeat, no rate-limit evasion, no anti-bot
circumvention, no credential misuse, no non-public endpoint access. If a
page cannot be retrieved through a permitted path, that limitation is
reported, and the analyst can supply copied listing text, a PDF, a
screenshot export, or another permitted source instead. Underwriting never
depends exclusively on one private commercial website being reachable.

**Provider adapters are pluggable, not hardcoded.** Nothing in
`researchSourceKindEnum` names a specific listing site. `listing_url` is a
source kind; which sites a Skill knows how to read is that Skill's concern,
never this schema's.

**test1 returns data, not test2 UI or test2 rows.** `Test1ResearchResponse`
is `{ subject, observations, coverage, source }` — plain data in the same
shape `cre-property-research.ts` already accepts, so a real response drops
into a research document's `observations` array with no translation layer.
test1 never produces a React component or writes to a test2 table.

**test3 returns model results, never a written assumption.** `ModelEstimate`
(re-exported as `Test3Recommendation`) is a labelled, versioned model
output — target, estimate, unit, model name, confidence, drivers. Turning
that into a proposal is still `research-to-proposal.ts`'s job, going through
the same analyst-decision step every other source does.

**Sources are parallel, never a chain that overwrites itself.** A listing's
stated rent growth, test3's model estimate, and an analyst's own
underwriting are three facts shown side by side — never collapsed into "the
answer" by having each source silently replace the last one. See
`recommendationToProposalInput`'s evidence structure, which keeps every
citation rather than reducing to a final number.

**Zero-cost.** Nothing here calls a paid property-data API, and nothing is
planned to by default. `research-interfaces.ts`'s contracts describe shapes,
not vendors; if a genuinely useful paid dataset exists later, the correct
move is documenting it as an optional, explicitly-enabled integration behind
these same interfaces — never wiring it in as the default path. See
`docs/zero-cost-operation.md`.

## What deliberately is not built yet, and why that is not an oversight

- **A listing/property-URL Claude Skill** is, by design, built and run
  outside this repository — see *Boundaries*. Nothing here blocks it from
  being written; nothing here can shortcut writing it either.
- **A live test1 or test3 client** would need those systems to actually
  expose the endpoints `research-interfaces.ts` specifies. Writing an HTTP
  client against an interface neither system implements yet would be
  scaffolding pointed at nothing.
- **The orchestration layer** (fan out to several sources at once,
  reconcile without letting one overwrite another) is downstream of both
  integrations above and was correctly out of scope until they exist.
- **Any UI** — a "Research this property" action, a market-intelligence
  panel — was deliberately deferred past the contracts, per the milestone's
  own instruction not to build a dashboard before the data pathways behind
  it exist. Building one now would mean shipping a screen that calls
  nothing.

## Where it lives

| Layer | File |
| --- | --- |
| `cre-property-research` v1 schema and parser | `packages/domain-models/src/cre-property-research.ts` |
| Universal research request, test1 and test3 contracts | `packages/domain-models/src/research-interfaces.ts` |
| Conversion into the existing assumption-proposal architecture | `packages/domain-models/src/research-to-proposal.ts` |
| Comparable-selection and percentile engine | `packages/domain-models/src/research-comparison.ts` |
| Tests | `cre-property-research.test.ts`, `research-interfaces.test.ts`, `research-to-proposal.test.ts`, `research-comparison.test.ts` in the same directory |

## Relationship to `cre-assumption-import`

The two formats are not layers of one pipeline; they answer different
questions and remain separate contracts on purpose.

| | `cre-assumption-import` | `cre-property-research` |
| --- | --- | --- |
| Question it answers | What does this document say about the model I have open | What do I know about this property, before deciding what any of it means |
| Every entry addresses | A real, writable test2 target | Usually nothing test2-shaped (`Observation.metric` is free text) |
| Produced by | One Claude Skill reading one document | Potentially several sources — a listing, test1, test3, a document — reconciled together |
| Reaches a model via | `assumption_proposals`, `sourceKind: 'imported'` | `assumption_proposals`, `sourceKind: 'recommended'`, only for `Recommendation` entries, via `research-to-proposal.ts` |
| Stability | v1, stable, unchanged by this document | v1, new |

A future version could let a parsed `cre-assumption-import` document appear
as a research source's evidence (an imported OM's stated assumptions,
alongside a listing and test1's comparables) — genuinely useful, and
explicitly not built here, so as not to touch a contract this document was
told to keep stable.
