# ADR 0002 — Decimal arithmetic from engine to screen

**Status:** Accepted · 2026-08-04

## Context

Binary floating point cannot represent most decimal fractions. `0.1 + 0.2 !==
0.3`. In a model with hundreds of leases over hundreds of periods, the drift
accumulates and shows up as a cash flow that does not tie out — the single
fastest way to lose an analyst's trust.

## Decision

`decimal.js` throughout the engine, configured once: 34 significant digits,
`ROUND_HALF_EVEN`. Intermediate results are never rounded; rounding happens once
at the boundary (2 dp for currency, 8 for rates, 4 for areas).

Values travel as **decimal strings** everywhere else. The PostgreSQL driver is
configured to return `numeric` columns as strings rather than coercing them to
JavaScript numbers. The API returns strings. The web client converts to `Number`
only inside formatting functions, for display.

## Consequences

Good: no drift; the cash-flow statement reconciles exactly; a stored result
matches to the cent on recalculation.

Bad: decimal arithmetic is slower than native floats (irrelevant at this scale
— a 120-month model calculates in well under a second); string values need
explicit conversion for display; a contributor must resist writing `a + b` on
two money values.

`ROUND_HALF_EVEN` was chosen over half-up because a long chain of half-up
roundings drifts systematically upward, which on a rent roll means quietly
overstating revenue.

## Alternatives

**BigInt minor units** were rejected: rates, areas and per-area rents are not
integers, and the engine divides constantly. Fixed-point integers would push
scaling decisions into every formula.
