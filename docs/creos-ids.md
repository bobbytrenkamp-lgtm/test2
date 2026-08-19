# CREOS universal entity IDs

This application is presented to CREOS Enterprise users as **CREOS
Underwrite** — one of three modules (alongside CREOS SiteIntel and
CREOS MarketSignal) in the CREOS commercial real estate platform. This
document is a pointer, not a new system: it exists so this repository,
`test1` (SiteIntel), and `test3` (MarketSignal) converge on the same
entity ID scheme as they start sharing data, instead of each inventing
one independently.

The authoritative definition lives in the CREOS Enterprise repository:
[`test4/src/domain/ids.ts`](https://github.com/bobbytrenkamp-lgtm/test4/blob/main/src/domain/ids.ts)
and [`test4/docs/ARCHITECTURE.md`](https://github.com/bobbytrenkamp-lgtm/test4/blob/main/docs/ARCHITECTURE.md#entity-architecture-superseded-id-format--read-this).

> **Correction (Phase 4):** the table below previously showed
> `CREOS-PROP-000001`-style sequential display IDs as the *real*
> identifier. That was wrong and is now superseded in test4's own
> architecture doc — sequential counters collide across independently
> operated apps. The **real** identifier is a 26-character ULID
> (collision-safe, sortable by creation time); `CREOS-PROP-XXXXX`
> (last 5 characters of the ULID, not a running count) is only a
> human-facing display form derived from it.

## Summary

| Entity     | Real ID     | Display ID form       | Relevant to this app because...        |
| ---------- | ------------ | ----------------------- | ---------------------------------------- |
| `Property` | 26-char ULID | `CREOS-PROP-XXXXX`      | Underwriting models attach to a property; this is that property's shared identity across CREOS. |
| `Deal`     | 26-char ULID | `CREOS-DEAL-XXXXX`      | An underwriting analysis in this repo *is* a CREOS `Deal`. |
| `Market`   | 26-char ULID | `CREOS-MKT-XXXXX`       | Market assumptions here will eventually be sourced from a MarketSignal `Market` record. |
| `Report`   | 26-char ULID | `CREOS-REPORT-XXXXX`    | Generated underwriting packages/memos correspond to a CREOS `Report`. |

## Status

**Utility available; consumed by the Phase 5/6 CREOS handoff importer.**
`packages/domain-models/src/creos-ids.ts` (Phase 4) implements the
generator/validator side of this scheme as Zod-branded IDs
(`CreosPropertyId`, `CreosDealId`, `CreosMarketId`, `CreosReportId`) — a
hand-ported, test-verified copy of test4's own spec-compliant algorithm
(see that file's header comment and `creos-ids.test.ts`, which
re-checks the same known-timestamp vectors test4 verified independently
against the ULID spec, 31/31 passing). This repository's own
identifiers (property IDs, underwriting/model IDs — see
`docs/domain-model.md`, `packages/database`'s schema) remain the sole
source of truth for everything this app does internally — no migration
ran, no existing ID was touched or replaced.

As of Phase 5 (`test4/docs/INTEGRATION_ROADMAP.md`), the unbranded
`CreosUlidSchema` from this file is used by
`packages/domain-models/src/creos-handoff-import.ts` to validate the
`handoffId`/`assumptionId`/`propertyId` fields of an incoming
`creos-handoff-v1` payload — the first real consumer of this utility.
See that file's header comment and `docs/claude-assumption-import.md`
for how a handoff reaches this app: a `.json` file downloaded from
SiteIntel's or (as of Phase 6) MarketSignal's "Send to Underwrite"
action, imported via `AssumptionImportTab.tsx`'s file picker, translated
into a `cre-assumption-import` v1 document (`translateCreosHandoff`,
generalized in Phase 6 to route a handoff's facts differently depending
on `sourceModule` — a MarketSignal forecast can name a real underwriting
target where a SiteIntel fact never can, see that function's own module
doc), and reviewed through the exact same deterministic analyze/
accept-by-hand path any other import uses — nothing is written
automatically.
