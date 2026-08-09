# The `cre-assumption-import` contract

How a Claude Skill that has read a PDF — an offering memorandum, an appraisal,
a loan term sheet — tells this platform what it found, and what happens to
that afterwards.

## What this is not

This platform does not read PDFs. Nothing in `test2` opens a document, calls
an AI provider, or interprets anything. That work happens **entirely outside
this platform**, in a Claude Skill built and run separately. What crosses the
boundary is a single pasted JSON document in the format this page specifies.

```
PDF  →  Claude Skill  →  cre-assumption-import JSON  →  paste into test2
                                                              │
                                                              ▼
                                                    Analyze (zero writes)
                                                              │
                                                              ▼
                                                   Review: current vs extracted,
                                                   evidence, conflicts, gaps
                                                              │
                                                              ▼
                                              Analyst selects what to accept
                                                              │
                                                              ▼
                                        Apply → assumption_proposals, already
                                        decided, written through the same path
                                        a typed edit uses → recalculate
```

Every assumption that reaches a model does so as an `assumption_proposals`
row, through the exact acceptance step a proposal posted by any other source
goes through — see `docs/assumption-contract.md`. The paste endpoint never
writes to a model table directly, and `POST /assumption-import/analyze` is
read-only by construction, safe to call as many times as you like against the
same paste.

## The pipeline in code

| Step | Where |
| --- | --- |
| Parse the paste, validate the envelope | `packages/domain-models/src/cre-assumption-import.ts` |
| Resolve a target to what it means and whether it is writable | `packages/domain-models/src/assumption-targets.ts` |
| Compare, merge duplicates, detect conflicts, classify | `packages/domain-models/src/assumption-import-analyze.ts` |
| Target dictionary and analyze endpoints | `apps/api/src/routes/assumption-import.ts` (`GET /assumption-import/targets`, `POST /assumption-import/analyze`) |
| Apply: proposal creation, decision and the model write, one transaction | `apps/api/src/routes/assumption-import.ts` (`POST /assumption-import/apply`), `apps/api/src/assumption-write.ts` |
| Import sessions (grouping for provenance) | `packages/database/src/repositories/import-sessions.ts` |
| Review screen | `apps/web/src/pages/AssumptionImportTab.tsx` |

Five separate concerns, five separate files. No one function does parsing,
validation, comparison, mapping and writing at once.

## The envelope

```json
{
  "format": "cre-assumption-import",
  "version": 1,
  "source": {
    "kind": "imported",
    "system": "Claude Skill",
    "skill": "cre-underwriting-extractor",
    "documentName": "Raleigh Industrial OM.pdf",
    "documentDate": "2026-06-30",
    "extractedAt": "2026-08-09T22:00:00Z"
  },
  "property": {
    "name": "Raleigh Industrial Center",
    "assetType": "industrial",
    "market": "Raleigh-Durham",
    "state": "NC"
  },
  "assumptions": [ /* individual fields — §Assumptions */ ],
  "records": [ /* whole records — §Record bundles */ ]
}
```

`format` and `version` are both required literals, checked before anything
else. A document claiming a future version is refused with a clear message
rather than partially read — this page describes version **1** and nothing
about version 1's rules is assumed to carry forward. `source` is required;
`property` and both arrays default to empty, so a records-only or
assumptions-only document is valid.

**`property` is context, never a destination.** The model already open in
this platform is always what gets compared and would be written to,
regardless of what `property.name` says. If it looks like a different
property than the one open, the review screen shows a warning — never a
block, since a person can always tell whether it is the same asset under a
different name.

## Assumptions — one field at a time

```json
{
  "target": "valuation.terminalCapRate",
  "value": "0.0625",
  "valueType": "decimal",
  "unit": "rate",
  "displayValue": "6.25%",
  "confidence": 0.96,
  "extraction": { "method": "explicit" },
  "evidence": [
    { "page": 42, "section": "Investment Summary", "label": "Exit Cap Rate", "sourceValue": "6.25%" }
  ],
  "notes": "Explicitly stated exit capitalization rate."
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `target` | Yes | A dotted path — see *Targets*, below |
| `value` | Yes (nullable) | The machine-readable figure. **Authoritative.** Null means a remark, not a figure |
| `valueType` | Yes | `decimal` \| `integer` \| `date` \| `boolean` \| `string` \| `enum` |
| `unit` | No | Presentation only, never parsed to decide the value |
| `displayValue` | No | What the source showed a human, e.g. `"6.25%"`. **Never parsed.** See *Normalization* |
| `confidence` | No | 0 to 1: how sure the *extraction* is — see *Confidence is not a recommendation* |
| `extraction` | No | `{ method: "explicit" \| "derived" \| "inferred", derivation?: string }` |
| `evidence` | No | Up to 20 items — see *Evidence* |
| `notes` | No | Free text |

## Targets

A target addresses a real, writable field using business terms, never a
database identifier:

- `valuation.<field>` — `valuation.terminalCapRate`, `valuation.discountRate`
- `vacancy.<field>` — `vacancy.generalVacancyRate`
- `<collection>.<code>.<field>` — `marketLeasing.INDUSTRIAL_NEW.marketRent`,
  `expenses.RE_TAX.amount`, `debt.SENIOR.fixedRate`

Collections are `expenses`, `otherRevenue`, `capital`, `debt`,
`marketLeasing`, `growthCurves`. The `<code>` is the record's own business
code as it appears in the model (`SENIOR`, `INDUSTRIAL_NEW`, `RE_TAX`) — never
a UUID; a Claude Skill never sees or invents a database identifier.

**Get the real, current list rather than guessing.** `GET
/models/:id/assumption-import/targets` returns every writable target for the
model currently open, with its label, `valueType`, `unit`, and — for each
collection — the business codes that already exist on that model:

```json
{
  "modelLevel": [
    { "target": "valuation.terminalCapRate", "label": "Exit capitalization rate", "valueType": "decimal", "unit": "rate", "writable": true }
  ],
  "collections": [
    {
      "collection": "marketLeasing",
      "noun": "a market leasing profile",
      "codes": ["INDUSTRIAL_STD"],
      "fields": [
        { "target": "marketLeasing.<code>.marketRent", "field": "marketRent", "label": "Market rent", "valueType": "decimal", "unit": "currency", "writable": true }
      ]
    }
  ]
}
```

This list is generated from the same registry the write path itself
consults (`packages/domain-models/src/assumption-targets.ts`), checked in
both directions against the real model schemas by
`assumption-targets.test.ts` — it cannot silently drift out of what is
actually writable.

**An unrecognized target is not an error.** `tenant_credit_score`, a target
this release does not model at all — is accepted by the parser and shown to
the analyst as *unsupported*, with a note that this platform does not
currently model it. Silently dropping it would be the worst option: it is
still true information about a gap in the product.

**Lease terms are a separate safety class, never here.** `leases.*` is
recognized by name and refused by the write path with a message pointing at
the rent roll — see *Leases*, below.

## Value types and strict normalization

`value` is always the normalized, machine-readable figure. `displayValue` is
what the source printed and exists purely so a human can sanity-check the
figure against the page — it is never parsed to decide what the value
actually is.

| Source says | `valueType` | `value` |
| --- | --- | --- |
| "6.25%" | `decimal` | `"0.0625"` |
| "70%" | `decimal` | `"0.70"` |
| "$12.50/SF/year" | `decimal` | `"12.50"` |
| "6 months" | `integer` | `"6"` |
| "September 1, 2026" | `date` | `"2026-09-01"` |
| "Yes" / "No" | `boolean` | `"true"` / `"false"` |
| "Trailing 12" (an enum field) | `enum` | `"trailing_12"` |

**If a rate's unit is ambiguous, do not guess.** "6.25" with nothing else to
go on could mean 6.25% (`"0.0625"`) or a typo for 625%. Report it as
`needsReview`-worthy — set `extraction.method` to `"inferred"` and say so in
`notes` — rather than picking one. The analyzer refuses a bare `"6.25"` for a
rate target only when it can tell the shape is wrong; it cannot read your
mind about which convention the source used, so **you** are the one who
decides not to guess.

`decimal`, `integer`, `date` and `boolean` values are validated against a
strict shape (`validateTypedValue` in
`packages/domain-models/src/assumption-proposals.ts`) — `"6.25%"` for a
`decimal` field, `"60.5"` for an `integer` field, or `"09/01/2026"` for a
`date` field are all refused with a message explaining the expected shape,
rather than coerced.

## Record bundles — a whole record at once

For a leasing profile, a loan, or any other record with several fields on one
page:

```json
{
  "collection": "marketLeasing",
  "code": "INDUSTRIAL_NEW",
  "name": "Industrial New Lease",
  "fields": {
    "marketRent": "12.50",
    "marketRentBasis": "per_area_per_year",
    "renewalProbability": "0.70",
    "renewalTermMonths": 60,
    "newLeaseTermMonths": 84,
    "downtimeMonths": 6,
    "renewalFreeRentMonths": 0,
    "newFreeRentMonths": 4,
    "renewalTiPerArea": "10",
    "newTiPerArea": "35",
    "renewalLcPercent": "0.02",
    "newLcPercent": "0.04"
  },
  "evidence": {
    "marketRent": [{ "page": 28, "label": "Market Rent", "sourceValue": "$12.50/SF" }],
    "renewalProbability": [{ "page": 31, "label": "Renewal Probability", "sourceValue": "70%" }],
    "newTiPerArea": [{ "page": 31, "label": "New Tenant Improvements", "sourceValue": "$35/SF" }]
  }
}
```

`evidence` is keyed **by field name**, because a bundle's fields commonly come
from different pages. The analyzer flattens a bundle into individual
field-level changes and carries each field's own evidence onto its own
change — a field with no evidence entry legitimately has none; it never
inherits another field's page number. `fields` carries no `valueType` of its
own; each field's type comes from the target registry, so a bundle field is
checked against the real field's type the same way an individual assumption
is.

**If the record's business code does not exist in the model yet**, nothing is
created automatically. The review screen lists it as a record with no
matching profile, shows every field that was found, and offers to create it
(opening the existing structured editor, prefilled) or map it onto an
existing one by hand. See `docs/claude-assumption-import.md#leases` for why
records are never silently created.

## Evidence

```json
{ "page": 42, "section": "Investment Summary", "label": "Exit Cap Rate", "sourceValue": "6.25%", "note": "..." }
```

Deliberately thin — a page number, a section, a label, and the figure exactly
as printed. Not a document-management system: there is no field for a page's
full text, and this is not the place for a long excerpt. Enough to check a
claim against the original PDF by hand.

## Extraction method

`extraction.method` is one of:

- **`explicit`** — the source states the value directly ("Exit Cap Rate:
  6.25%"). The common case.
- **`derived`** — the source states enough to calculate the value
  arithmetically, and `extraction.derivation` states the arithmetic in words
  ("$12,083/month × 12"). Shown to the analyst so they can check the
  arithmetic, not just the answer.
- **`inferred`** — the value required interpretation beyond direct reading or
  arithmetic. **Always** shown as `needsReview` and **never** included by a
  bulk "select all ready"-style action, however high its confidence. If you
  are not sure whether something counts as inferred, it does.

## Confidence is not a recommendation

`confidence` (0 to 1) states how sure the **extraction** is that it read the
source correctly — not investment judgment, not a forecast confidence, not
"how good is this number." A confident misreading of a clearly printed 6.25%
as 6.35% is still a confident extraction; the confidence says nothing about
whether 6.25% is a good assumption to underwrite at.

Never omit it purely because you are unsure what to put — leave it out
entirely (`null`/absent) rather than asserting a number you do not mean. The
review screen shows "Not stated" for an absent confidence rather than
treating it as zero, which would be its own false claim.

## Duplicates and conflicts

**The same value, seen on more than one page**, is one fact stated twice —
merge it into one assumption with combined evidence ("Exit Cap Rate —
6.25% — pages 8, 42"), not two competing ones. If you emit it as two separate
entries anyway (one per mention), the analyzer merges them for you; either
way, do not report the same figure as if it were two different findings.

**Different values for the same target from different pages** are a real
disagreement in the source document. Report both — do not resolve this
yourself by picking whichever seems more authoritative, more recent in
document order, or higher confidence. The analyzer shows every distinct
value with its own evidence and refuses to auto-select any of them; an
analyst decides.

## Null values

A `value` of `null` with a `notes` field is a legitimate way to record a
qualitative remark against a target without proposing a number —
*"three competing developments are in planning in this submarket"* against
`valuation.discountRate`, say. The review screen shows it as worth a look,
not as a figure to accept.

## Unsupported and unknown assumptions

A target this release genuinely does not model (`tenant_credit_score`, a
data-center-only field on an industrial deal) is still useful information —
never omit it because you are not sure test2 has a place for it. Report it
plainly, with whatever evidence you have; the platform shows it labeled as
not currently modeled here, and keeps it in the import record rather than
discarding it. **Do not invent a nearby target to force a fit** — an
approximate mapping that turns out wrong is worse than an honest
"unsupported."

## Leases

**Do not use this contract to report contractual lease economics** — tenant
name, suite, area, commencement/expiration dates, contractual rent, rent
steps, renewal options. A lease is a signed document; the rent roll is where
a change to one belongs, made by a person who can see the amendment. If a
source document happens to describe lease terms, you may still report them
(`leases.<code>.<field>` is recognized and shown, linked to the rent roll for
comparison) — but the write path refuses to apply a `leases.*` target, by
name, every time. There is no bulk override. A future dedicated lease-import
workflow may handle this properly; this contract intentionally does not
attempt it.

## Applying: what actually happens

`POST /models/:id/assumption-import/apply` takes the same paste plus the list
of targets an analyst selected. It **re-analyzes the paste itself**, server
side — it does not trust a client-held preview that might be stale — then, in
one transaction:

1. Creates an `import_sessions` row recording the document, the source
   system/skill, and the analysis's own counts.
2. For each selected target, inserts an `assumption_proposals` row already in
   its decided (`accepted`) state, with `import_session_id` set, and applies
   the value through the exact same write path (`applyAssumption`) a
   person's typed edit or a single proposal's acceptance uses.
3. If **any** selected target turns out unwritable — its status is not
   `new`/`changed`/`needsReview`, or the record it names has since vanished —
   the **whole batch rolls back**. Nothing is half-applied; the exact failing
   target is named in the error.

A frozen or approved model refuses the whole request, the same way a typed
edit does. A read-only viewer can review and analyze but not apply — the
route requires `model:write`.

## Worked examples

### Industrial — an individual assumption

```json
{
  "target": "valuation.terminalCapRate",
  "value": "0.0625",
  "valueType": "decimal",
  "unit": "rate",
  "displayValue": "6.25%",
  "confidence": 0.96,
  "extraction": { "method": "explicit" },
  "evidence": [{ "page": 42, "section": "Investment Summary", "label": "Exit Cap Rate", "sourceValue": "6.25%" }]
}
```

### Office — a derived value

```json
{
  "target": "valuation.acquisitionCosts",
  "value": "1200000",
  "valueType": "decimal",
  "unit": "currency",
  "displayValue": "$1,200,000",
  "extraction": { "method": "derived", "derivation": "2.5% of the $48,000,000 purchase price, as stated in the OM's sources & uses." },
  "evidence": [{ "page": 6, "section": "Sources & Uses", "label": "Closing Costs", "sourceValue": "2.5% of purchase price" }]
}
```

### Retail — a market leasing record bundle

```json
{
  "collection": "marketLeasing",
  "code": "RETAIL_INLINE",
  "name": "Retail Inline Shop Space",
  "fields": {
    "marketRent": "28.00",
    "marketRentBasis": "per_area_per_year",
    "renewalProbability": "0.60",
    "newLeaseTermMonths": 60,
    "downtimeMonths": 9,
    "newTiPerArea": "20"
  },
  "evidence": {
    "marketRent": [{ "page": 19, "label": "Market Rent — Inline", "sourceValue": "$28.00/SF NNN" }],
    "newTiPerArea": [{ "page": 20, "sourceValue": "$20.00/SF" }]
  }
}
```

### Debt — a facility record bundle

```json
{
  "collection": "debt",
  "code": "SENIOR",
  "name": "Senior Acquisition Loan",
  "fields": {
    "type": "acquisition",
    "commitment": "29000000",
    "fundingDate": "2026-09-01",
    "rateType": "floating",
    "spread": "0.0225",
    "rateCap": "0.065",
    "interestOnlyMonths": 24,
    "termMonths": 60
  },
  "evidence": {
    "commitment": [{ "page": 3, "label": "Loan Amount", "sourceValue": "$29,000,000" }],
    "spread": [{ "page": 3, "label": "Spread", "sourceValue": "SOFR + 225bp" }],
    "rateCap": [{ "page": 3, "label": "Rate Cap", "sourceValue": "6.50%" }]
  }
}
```

### Operating expense — an individual assumption

```json
{
  "target": "expenses.RE_TAX.amount",
  "value": "412500",
  "valueType": "decimal",
  "unit": "currency",
  "displayValue": "$412,500",
  "confidence": 0.9,
  "extraction": { "method": "explicit" },
  "evidence": [{ "page": 14, "section": "Operating Expenses", "label": "Real Estate Taxes", "sourceValue": "$412,500" }]
}
```

### A conflict, reported honestly

```json
{
  "assumptions": [
    {
      "target": "valuation.discountRate", "value": "0.08", "valueType": "decimal",
      "evidence": [{ "page": 5, "label": "Assumptions Summary", "sourceValue": "8.0%" }]
    },
    {
      "target": "valuation.discountRate", "value": "0.0825", "valueType": "decimal",
      "evidence": [{ "page": 41, "label": "DCF Detail", "sourceValue": "8.25%" }]
    }
  ]
}
```

Two different figures for the same target, from two different pages of the
same document — reported as two entries rather than picked between. The
analyzer shows both; an analyst resolves it.

## The rules, restated

1. **Only report what the document actually supports.** Never fill a gap with
   a plausible-sounding number.
2. **Normalize strictly, and only when the unit is unambiguous.** `6.25%` →
   `0.0625` is normalization. `"6.25"` with no unit stated is not — flag it.
3. **Never resolve a conflict yourself.** Two different values for one target
   are two facts, not a tie to break.
4. **Never merge different targets to save space**, and never split one
   target's evidence across bundles that imply it came from several places
   when it did not.
5. **Never invent a database identifier.** Business codes only.
6. **Never bulk-report lease economics** as generic assumptions.
7. **An unsupported target is worth reporting anyway.** Silence is the worst
   answer.
8. **State your extraction method honestly.** `inferred` costs nothing —
   it just means a person looks before it is applied.

---

## COPY THIS INTO A CLAUDE SKILL

*The section below is written as a complete, standalone instruction to hand
to a Claude Skill that reads CRE underwriting documents and outputs
`cre-assumption-import` data. It restates the rules above in second person,
deliberately self-contained, so it can be pasted as-is into a skill's system
instructions without the reader needing the rest of this page.*

> You read commercial real estate documents — offering memoranda, appraisals,
> loan term sheets, rent rolls, operating statements — and output structured
> data in the **`cre-assumption-import`** format, **version 1**, and nothing
> else. You do not write prose commentary, a summary, or an opinion on the
> deal. Your entire output is one JSON object.
>
> **Follow the envelope exactly:**
>
> ```json
> {
>   "format": "cre-assumption-import",
>   "version": 1,
>   "source": { "kind": "imported", "system": "Claude Skill", "skill": "<your skill's name>", "documentName": "<filename or title>", "documentDate": "YYYY-MM-DD or omit", "extractedAt": "<ISO 8601 timestamp>" },
>   "property": { "name": "...", "assetType": "...", "market": "...", "state": "..." },
>   "assumptions": [ /* individual fields you found */ ],
>   "records": [ /* whole records — a leasing profile, a loan — you found together */ ]
> }
> ```
>
> **For every individual field**, use this shape:
>
> ```json
> {
>   "target": "<dotted path — see Targets below>",
>   "value": "<normalized machine-readable value, or null if this is a remark, not a figure>",
>   "valueType": "decimal" | "integer" | "date" | "boolean" | "string" | "enum",
>   "unit": "<optional, presentation only>",
>   "displayValue": "<what the document printed, e.g. \"6.25%\" — never used to derive value>",
>   "confidence": <0 to 1, or omit entirely if you cannot state one — never guess a number here>,
>   "extraction": { "method": "explicit" | "derived" | "inferred", "derivation": "<required prose if derived>" },
>   "evidence": [ { "page": <int>, "section": "...", "label": "...", "sourceValue": "<exact text from the document>" } ],
>   "notes": "<optional>"
> }
> ```
>
> **Targets** are dotted paths in the platform's own terms:
> `valuation.<field>` (e.g. `valuation.terminalCapRate`, `valuation.discountRate`,
> `valuation.acquisitionPrice`, `valuation.saleMonth`), `vacancy.<field>` (e.g.
> `vacancy.generalVacancyRate`), or `<collection>.<code>.<field>` where
> `<collection>` is one of `expenses`, `otherRevenue`, `capital`, `debt`,
> `marketLeasing`, `growthCurves` and `<code>` is a short business code you
> choose or that the document itself states (e.g. `SENIOR`, `RE_TAX`,
> `INDUSTRIAL_NEW`) — **never** a database ID; you will never see one and must
> never invent one. If the platform has told you its real target list and
> existing codes for this specific model (via `GET
> /models/:id/assumption-import/targets`), prefer matching against that list
> exactly. If you do not have it, use your best judgment on the target name
> and let the platform mark it `unsupported` if it does not exist — that is
> the correct, safe outcome, not a failure.
>
> **Normalize strictly, and only when unambiguous:**
> - A percentage becomes a decimal fraction: `6.25%` → `"0.0625"` (not
>   `"6.25"`).
> - A per-area rate becomes a bare number in the model's currency:
>   `$12.50/SF/year` → `"12.50"`.
> - A term in months becomes an integer: `6 months` → `6` (type `integer`).
> - A date becomes `YYYY-MM-DD`.
> - A yes/no becomes `"true"` / `"false"` (type `boolean`).
> - **If you cannot tell the unit or convention with confidence — a bare
>   number with no `%` sign, no currency mark, nothing to anchor it — do not
>   guess which convention the source meant.** Set `extraction.method` to
>   `"inferred"`, explain the ambiguity in `notes`, and let a person decide.
>
> **For a whole record** (a leasing profile, a loan) found together on one
> page or table, use a `records` entry instead of several `assumptions`
> entries:
>
> ```json
> {
>   "collection": "marketLeasing",
>   "code": "<short business code>",
>   "name": "<optional descriptive name>",
>   "fields": { "<field>": "<normalized value>", "...": "..." },
>   "evidence": { "<field>": [ { "page": <int>, "sourceValue": "..." } ] },
>   "notes": "<optional>"
> }
> ```
>
> Key `evidence` **by field name**. If two fields in one bundle came from
> different pages, say so — never let one field's evidence imply where a
> different field came from.
>
> **Absolute rules, no exceptions:**
>
> 1. **Never guess a value the document does not support.** No number is
>    better than a wrong one presented as read.
> 2. **Never resolve a conflict.** If the document states two different
>    figures for what is clearly the same thing (an executive summary and a
>    detailed schedule disagreeing, say), report **both** as separate entries
>    for the same `target` — do not decide which is correct.
> 3. **Never invent a database identifier.** You address a target and a
>    record by business terms only.
> 4. **Never report contractual lease economics** (tenant name, suite, area,
>    commencement/expiration, contractual rent, rent steps, renewal options)
>    as a generic `valuation`/`vacancy`/collection assumption. If you found
>    lease-level detail worth surfacing, use `leases.<code>.<field>` targets —
>    they are recognized and shown for comparison, but the platform will
>    never bulk-apply them, by design.
> 5. **Report something you cannot map, rather than omit it or force a
>    near-fit target.** An unsupported finding is useful; a wrong mapping is
>    not.
> 6. **State your extraction method honestly** — `explicit` only for a value
>    stated directly, `derived` with the arithmetic spelled out in
>    `derivation`, `inferred` for anything that required judgment beyond
>    reading or arithmetic. When genuinely unsure between `derived` and
>    `inferred`, choose `inferred` — it costs nothing but an extra review
>    click, and the alternative risks something being applied without one.
> 7. **`confidence` is about your extraction, not your investment opinion.**
>    Leave it out if you cannot state one; never use it to signal how good an
>    assumption you think the value makes.
> 8. **Cap evidence at what actually verifies the figure.** A page number, a
>    section, a label, the exact source text — never a long excerpt or the
>    surrounding paragraph.
>
> Output nothing but the JSON object. No markdown commentary outside of it,
> though a single ` ```json ... ``` ` fence around the whole object is fine —
> the platform strips exactly one.
