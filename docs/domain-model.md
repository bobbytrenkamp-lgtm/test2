# Domain model

## Hierarchy

```
Organization                    tenancy boundary; every query filters on it
  Workspace                     optional grouping inside an organization
    Portfolio / Fund            reporting and aggregation grouping
      Property                  the physical asset
        Building                one or more per property
          Space                 suite, unit, parcel, pad, bay — the leasable unit
        Model                   one scenario for the property
          Lease                 an occupancy within a model
            Rent step
          Market leasing profile
          Operating expense
          Other revenue item
          Capital item
          Debt facility
          Growth curve
          Model version         immutable snapshot of the engine input
            Calculation run     stored result
              Calculation trace
```

## The central distinction

**Physical structure is shared. Scenario data is not.**

`properties`, `buildings` and `spaces` describe the asset and belong to the
property. `leases`, `operating_expenses`, `capital_items`, `debt_facilities`,
`growth_curves` and `market_leasing_profiles` describe a *view* of the asset and
belong to a model.

This is what makes scenarios cheap. Cloning a model copies a handful of
scenario rows and shares the building, so an upside case, a downside case and a
lender case can coexist without three copies of the rent roll's physical
context.

## Spaces are the source of truth for area

The space list — not `properties.rentable_area` — drives:

- occupancy (occupied area ÷ total revenue-producing area)
- the pro-rata denominator for recoveries
- market rent on vacant space

When the property's stated rentable area disagrees with the space list by more
than 1%, the engine raises `AREA_MISMATCH` and uses the space list, because that
is the figure the mathematics actually depends on.

A lease with no space assignment gets a space synthesised from its own area, with
an informational diagnostic, so occupancy and the recovery denominator still
reconcile rather than quietly excluding it.

## Identifiers: UUIDs outside, codes inside

Database rows carry UUID primary keys. The engine works in stable
human-meaningful **codes** — `SUITE-1200`, `L-CASCADE`, `MLA-OFF` — so a trace
entry reads `lease:L-CASCADE` rather than a UUID.

`buildModelInput` maps UUID references onto codes as it assembles the engine
input. Codes are unique within their scope (`UNIQUE (model_id, code)`), which
also makes an idempotent import possible: re-importing a rent roll updates
leases by code instead of duplicating them.

## Non-office asset classes

Nothing forces a property into an office rent-roll shape.

| Asset class | How it is modelled |
| --- | --- |
| Multifamily | One space with `unit_count`; rent on `per_unit_per_month`; parking, pet and utility income as other revenue varying with occupancy |
| Self-storage, parking | Same unit-based pattern |
| Industrial | One or more building-sized spaces, triple net recoveries |
| Retail | Anchor and inline spaces, percentage rent with natural breakpoints, admin fees and recovery caps |
| Hotel | Modelled through other-revenue formulas; **no dedicated departmental structure** |
| Data centre | Power and interconnection as other revenue; **no dedicated capacity model** |
| Land, ground lease | A single space with ground rent |
| Development | Capital draw schedules, a construction facility with capitalised interest, a future lease for delivery |
| Mixed use | Spaces of different types, each with its own market leasing profile |

Hotel and data-centre specifics are honestly partial: the common engine handles
them through generic revenue mechanisms, not through departmental or capacity
models. See `docs/feature-status.md`.

## Lease statuses

`occupied`, `future`, `vacant`, `month_to_month`, `holdover`, `expired`,
`terminated`, `pending`, `proposed`, `sublease`.

`vacant` and `terminated` leases are excluded from the forecast entirely; the
space they would have occupied is picked up by speculative lease-up instead.

## Model lifecycle

```
draft ──► analyst_review ──► manager_review ──► approved ──► published
  ▲             │                   │              │            │
  └─────────────┴───────────────────┘              │            ├─► superseded ─► archived
                                                    └────────────┴─► archived
```

Transitions are defined once, in `packages/domain-models/src/permissions.ts`,
each naming the capability required to travel it. Reaching `approved` snapshots
the model's exact engine input and locks the model against edits — an approval
that could be edited out from under is not an approval.

## Retention

Properties and models are **soft-deleted**. Audit entries, valuations and stored
calculations reference them and must stay explainable after an asset leaves the
portfolio. Child rows cascade on hard delete; nothing in the application issues
one.
