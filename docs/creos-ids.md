# CREOS universal entity IDs

This application is presented to CREOS Enterprise users as **CREOS
Underwrite** — one of three modules (alongside CREOS SiteIntel and
CREOS MarketSignal) in the CREOS commercial real estate platform. This
document is a pointer, not a new system: it exists so this repository,
`test1` (SiteIntel), and `test3` (MarketSignal) converge on the same
entity ID scheme as they start sharing data, instead of each inventing
one independently.

The authoritative definition lives in the CREOS Enterprise repository:
[`test4/docs/ARCHITECTURE.md`](https://github.com/bobbytrenkamp-lgtm/test4/blob/main/docs/ARCHITECTURE.md#future-entity-architecture).

## Summary

| Entity     | Future ID format     | Relevant to this app because...        |
| ---------- | --------------------- | ---------------------------------------- |
| `Property` | `CREOS-PROP-000001`   | Underwriting models attach to a property; this is that property's shared identity across CREOS. |
| `Deal`     | `CREOS-DEAL-000001`   | An underwriting analysis in this repo *is* a CREOS `Deal`. |
| `Market`   | `CREOS-MKT-XXXXX`     | Market assumptions here will eventually be sourced from a MarketSignal `Market` record. |
| `Report`   | `CREOS-REPORT-000001` | Generated underwriting packages/memos correspond to a CREOS `Report`. |

## Status

**Not implemented.** This repository's own identifiers (property IDs,
underwriting/model IDs — see `docs/domain-model.md`) remain the source
of truth today. Adopting the shared `CREOS-*` ID format is Phase 3 of
the CREOS Integration Roadmap
([`test4/docs/INTEGRATION_ROADMAP.md`](https://github.com/bobbytrenkamp-lgtm/test4/blob/main/docs/INTEGRATION_ROADMAP.md)),
which is not scheduled and requires its own design pass — this doc
does not change any schema, API, or migration.
