# Product requirements

## Who this is for

Analysts, asset managers, acquisitions teams, valuers, portfolio managers and
their reviewers — people who spend the working day inside a cash-flow model and
have to defend every number in it to an investment committee, a lender or an
auditor.

## What it is

An original commercial real estate underwriting, valuation, cash-flow
forecasting, asset management, debt, scenario and portfolio platform, built from
generally accepted commercial real estate finance, accounting, valuation,
leasing and software-engineering principles.

It is **not** a reimplementation of any existing product. No proprietary source,
screen design, menu structure, wording, icon set, report layout, calculation
behaviour, documentation or branding has been copied, and no proprietary file
format is read or written. Where a modelling convention is a judgement call, the
choice and its reasoning are stated in `docs/calculation-specification.md`
rather than matched to any vendor's behaviour. No claim of numerical parity with
any other product is made.

## Product principles

1. **Every number is explainable.** Any material figure can be traced to the
   assumption and formula that produced it. Financial transparency outranks
   visual polish.
2. **Deterministic and reproducible.** The same inputs and engine version always
   produce the same outputs. An approved valuation is reproducible years later.
3. **Never a silent zero.** A missing critical input produces a diagnostic and an
   explicit "not available", never a plausible-looking zero.
4. **The server decides.** The client hides what a role cannot use; the server
   enforces it on every request.
5. **Built for the keyboard and the long session.** Dense tables, tabular
   figures, frozen columns, no decorative motion.
6. **Honest about what exists.** Documentation describes what is built and
   tested, and says plainly what is not.

## Functional scope

**Implemented and tested.** Organizations, roles and isolation; properties,
buildings and spaces; tenants, leases, rent steps, escalations, free rent,
percentage rent; market leasing assumptions with probability-weighted rollover
and speculative lease-up; operating expenses; recoveries across triple-net,
base-year, stop and fixed structures with gross-up, admin fees and caps; vacancy
and credit loss without double deduction; capital; debt including floating
rates, amortisation, refinancing and covenants; DCF and direct capitalisation;
the full return metric set; LP/GP waterfalls; portfolio aggregation; calculation
traces; immutable versions and an approval workflow; deterministic rent-roll
import; nine reports in four formats; an audit log.

Budgets, actuals and variance reporting; collaboration (comments, tasks,
mentions, notifications); configurable dashboards; document management;
portfolio reports; Excel import and export; server-side PDF; multi-factor
authentication; background jobs; sensitivity analysis; model cloning; and
portfolio roll-up are also implemented and tested — this list started as two
separate "not yet covered" and "designed, not built" buckets, both of which
have since emptied out as the corresponding work shipped.

**Designed, not built.** The optional AI assistant — provider-neutral,
disabled by default, no provider bundled (`docs/zero-cost-operation.md`).

**Explicit non-goals for now.** Hotel departmental modelling, data-centre
capacity modelling, yield capitalisation methods (term and reversion, hardcore,
equivalent yield), multi-currency translation, cash sweep (applying trapped
cash to loan principal, as opposed to withholding it from equity on a covenant
breach, which is modelled), advanced phased/multi-building development
underwriting, and any paid external data source.

`docs/feature-status.md` holds the authoritative matrix.

## Definition of done

A feature is complete only with: persistent storage, server-side authorization,
input validation, error handling, loading and empty states, responsive layout,
accessibility, automated tests, documentation, audit behaviour where required,
working import/export where applicable, no placeholder calculations, no fake
production data, and no non-functional controls.

By that standard the engine, the domain model, authentication and authorization,
and the import parser are done. Most of the web application is **not** — it
lacks automated tests. That is stated rather than glossed over.

## Quality bar

- Money never passes through binary floating point.
- Every protected route validates identity *and* authorization.
- Cross-organization access is proven impossible by test, not by inspection.
- Charts never truncate an axis; every chart has a table alternative.
- Confidential model data never leaves the deployment without explicit consent.
