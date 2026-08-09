# The assumption input contract

How another system tells this one what it believes about a model's assumptions,
and what happens next.

This is the integration surface the product directions call **test1 / test3** —
separate systems that hold data this one does not: a submarket's rent
comparables, a property's own operating history, a research view on exit yields.

## The rule that shapes everything else

**Nothing that arrives through this contract reaches the calculation engine.**

A proposal is stored, shown beside the assumption it concerns, and applied only
when a person decides to apply it.

That is not caution about data quality. A market-data service may well be more
accurate than the analyst about market rent in a submarket it watches full time.
It is that **the analyst is the one who has to defend the model** — in an
investment committee, to a lender, to a valuer — and a number they cannot
account for is worse than a number they can argue with, however good its
provenance. A tool that quietly improved their exit yield overnight would have
replaced their judgement while appearing to support it.

The corollary is that a **rejection is recorded, not deleted**. "We saw the
market number and stayed at 3.00%" is a defensible position, and it only exists
later if the tool kept it. That is the question a reviewer actually asks, and
the screen answers it.

## The endpoints

All three are model-scoped and organization-scoped. A caller can only reach a
model its session's organization owns.

| Method | Path | Capability |
| --- | --- | --- |
| `POST` | `/models/:id/assumption-proposals` | `model:write` |
| `GET` | `/models/:id/assumption-proposals?status=` | `model:read` |
| `POST` | `/models/:id/assumption-proposals/:proposalId/decision` | `model:write` |

`model:write` gates the post rather than a capability of its own. A proposal is
not an edit, but it does put a decision in front of whoever owns the model, and
a read-only viewer should not be able to do that.

### Posting

```json
{
  "proposals": [
    {
      "target": "valuation.terminalCapRate",
      "value": "0.0545",
      "sourceKind": "market_data",
      "sourceName": "test3",
      "confidence": 0.81,
      "observedAt": "2026-03-31T00:00:00.000Z",
      "evidence": { "comparables": 11, "submarket": "Wake County, NC" },
      "notes": "Eleven office trades in the trailing two quarters."
    }
  ]
}
```

Up to 200 proposals in one call, applied in a single transaction. A source
reporting a model's worth of assumptions has a coherent view of it; half of that
view landing would be a position nobody holds.

Posting is **not** refused on an approved or published model. A source may well
have something to say about a frozen model's exit yield — that is a reason
somebody would clone it. Only the acceptance, which writes, is refused there.

### The fields

**`target`** — a dotted path in the platform's own terms. Three shapes:

- `valuation.<field>` — `valuation.terminalCapRate`, `valuation.discountRate`
- `vacancy.<field>` — `vacancy.generalVacancyRate`, `vacancy.creditLossRate`
- `<collection>.<code>.<field>` — `marketLeasing.MLA-OFF.marketRent`,
  `expenses.OPEX-INS.amount`, `debt.SENIOR.spread`

The collections are `marketLeasing`, `expenses`, `capital`, `debt`,
`otherRevenue`, `growthCurves` and `leases`. The code is the row's code as it
appears in the model, not a database identifier.

The path is **not validated against the model on arrival**. A proposal about a
lease that has not been entered yet is still worth keeping, and refusing it
would make the contract depend on the order two systems happen to run in. A
target this release cannot locate at all is still stored and still shown — see
*Gaps*, below.

**`value`** — a **decimal string**, like every other number in this system, so a
rate arriving from outside cannot lose precision on its way in. Null is allowed
and means the proposal is a remark rather than a figure: *"three competing
developments are in planning in this submarket"* is worth recording against a
rent-growth assumption without proposing a number for it. Such a proposal can be
rejected or noted but not applied — there is nothing to apply.

**`sourceKind`** — one of `user`, `imported`, `historical`, `market_data`,
`calculated`, `recommended`.

**`sourceName`** — the system or person, named so a reader can weigh it. It is
also the **supersession key**: see below.

**`confidence`** — 0 to 1, when the source can state one. Absent rather than
defaulted, because most sources cannot state one and a default of 1 would assert
a certainty nobody claimed. The screen prints "Not stated".

**`observedAt`** — when the source *observed* this, which is not when it said so.
A March comparable is a March comparable in July.

**`evidence`** — any JSON object. Rendered as given and never parsed for meaning,
so a source can show its working — comparables, a sample size, a methodology
note — without this contract having to know the shape in advance.

### Supersession

A source may hold **one live proposal per target per model**. Posting a second
marks the first `superseded` and returns a count of how many were replaced.

A source that reports monthly is stating its current view, not adding to a pile.
Left to stack, an analyst returning after a quarter would be asked to decide
between four versions of one opinion, three of which the source no longer holds.
The superseded rows are kept — what a source said in March is still what it said
in March — but only the newest is presented as a decision to make.

A proposal from a **different** source on the same target supersedes nothing.
Two services disagreeing about market rent is information, and collapsing them to
whichever wrote last would destroy it.

This is enforced by a partial unique index on `(model_id, target, source_name)
WHERE status = 'pending'`, so a bug in the supersession logic fails loudly rather
than quietly duplicating.

## Reading

`GET` returns each proposal with two fields the poster did not send:

- **`current`** — the model's own value for the same target, resolved from the
  assembled `ModelInput` rather than from a table, because the input is what the
  engine reads. Comparing against anything else would compare against a number
  the model does not use.
- **`applicable`** / **`applicableReason`** — whether accepting could write
  anything, and if not, why.

Undecided proposals sort first: the list exists to be worked through, and a
decided proposal is history rather than a task.

## Deciding

```json
{ "decision": "accepted", "note": "Comparables are convincing." }
```

`accepted` applies the value; `rejected` records that it did not. Both are
final — a proposal is decided once, and a second decision is refused with a 400.
That is not pedantry: accepting applies a value, so a second acceptance would
write it again and report a change that had already happened, which is how two
people looking at the same list end up disagreeing about what the model says.

The decision and the write share **one transaction**. Splitting them would allow
a proposal marked accepted whose value never reached the model — a lie that is
invisible on both screens that would show it.

An acceptance goes through the same validated write path a typed edit uses: for a
collection row, the proposed field is merged onto the stored row and passed to
the collection's own `upsert`. So an accepted proposal cannot clear a recovery
structure, a draw schedule or a monthly profile that this contract knows nothing
about, and an invalid value is refused by the collection's schema rather than
landing in a column.

Accepting is refused on an approved or published model, for the same reason a
typed edit is: clone it, or move it back to draft.

## What an acceptance can and cannot write

**Can** — every field named in `packages/domain-models/src/assumption-targets.ts`,
which is the single list this contract's decision route and the PDF-assumption
import pipeline both consult (see `docs/claude-assumption-import.md`). That
covers the model-level valuation and vacancy assumptions, and any scalar field
of a row in `expenses`, `otherRevenue`, `capital`, `debt`, `growthCurves` or
`marketLeasing` — including, since the value type was widened, fields that
are not decimals: `valuation.terminalNoiBasis` and `valuation.saleMonth`, a
debt facility's `fundingDate`, an expense's `method`. `value` is still always
a single string; `valueType` says which of `decimal`, `integer`, `date`,
`boolean`, `string` or `enum` it has to parse as, checked by
`validateTypedValue` before it is ever accepted. A proposal that omits
`valueType` defaults to `decimal`, so nothing posted before this widening
changed behaviour.

**Cannot — lease terms.** A lease is a document, and a change to one is a change
to what was signed. `leases.*` proposals are stored and shown, and applied by
hand on the rent roll.

**Cannot — growth-curve and index-curve cross-references, or display order.**
`growthCurveId`-style fields read and write under different names on this
release (a read/write mismatch already in the schema, not introduced by this
contract) and are excluded rather than risk a wrong mapping; `sortOrder` is
display-only and does not reach the calculation engine either way.

In every case the proposal is still kept, the difference is still shown, and
rejecting it still records that it was considered. Only the **Apply** button is
disabled, with the reason next to it.

## Gaps

A proposal whose target this release cannot locate — `dataCentre.powerCostPerKw`,
say — is **stored and shown**, not rejected.

A source with a view on something the product does not model is telling us
something true about a gap in the product. Validating targets against the current
schema would silently discard exactly the proposals worth reading, and would make
the contract a moving target every time the model grows a field.

## What is recorded

Every post and every decision writes to the audit log:
`assumption_proposal.received`, `assumption_proposal.accepted`,
`assumption_proposal.rejected` — with the target, the source, the previous value
and the note.

The proposal row itself keeps `decided_by`, `decided_at` and `decision_note`
permanently, in every status. Nothing on this path is ever deleted by the
application.

## Where it lives

| Layer | File |
| --- | --- |
| Contract and value resolution | `packages/domain-models/src/assumption-proposals.ts` |
| Writable-target registry | `packages/domain-models/src/assumption-targets.ts` |
| Storage | `packages/database/migrations/0013_assumption_provenance.sql`, `0015_assumption_import.sql`, `packages/database/src/repositories/assumption-proposals.ts` |
| Endpoints and application | `apps/api/src/routes/assumption-proposals.ts`, `apps/api/src/assumption-write.ts` |
| Screen | `apps/web/src/pages/ProvenanceTab.tsx` |
| Tests | `packages/domain-models/src/assumption-proposals.test.ts`, `assumption-targets.test.ts`, `tests/assumption-proposals.test.ts`, `e2e/provenance.spec.ts` |

## The PDF-assumption import pipeline

A Claude Skill that has read a document — an offering memorandum, an
appraisal, a term sheet — is one more source under this same contract, not a
parallel one. It never writes to a model directly either: what it produces is
a versioned JSON document (`cre-assumption-import`, described in full at
`docs/claude-assumption-import.md`) that an analyst pastes in, reviews, and
selectively applies. "Applying" still means an `assumption_proposals` row,
already decided, written through the identical `applyAssumption` path this
page describes — the safety boundary is unchanged. What is different is
upstream of that boundary: a deterministic analyzer compares the paste
against the model before anything becomes a proposal, so an analyst reviews a
formatted difference rather than forty raw rows. See
`docs/claude-assumption-import.md` for the full format, and
`apps/web/src/pages/AssumptionImportTab.tsx` for the screen.

## What does not exist yet

Stated plainly, because a contract document that implies more than the code does
is worse than none:

- **No machine authentication.** A source authenticates with an ordinary session
  and needs `model:write`. There are no API keys or service accounts; issuing a
  dedicated account for an integration is the current answer.
- **No push.** Nothing notifies a source that its proposal was decided. The
  decision is readable through `GET`, and there is no webhook.
- **No scheduled polling of an external source.** This platform receives; it does
  not fetch. That is also what keeps it free to run — see
  `docs/zero-cost-operation.md`.
- **No cross-model targeting.** Each proposal names one model. A source with a
  submarket-wide view posts it once per model it applies to.
