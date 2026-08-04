# ADR 0004 — Probability-weighted rollover

**Status:** Accepted · 2026-08-04

## Context

When a lease expires inside a forecast, the space either renews or re-lets to
someone new after a period of downtime. Market leasing assumptions state a
renewal *probability*, not an outcome.

## Decision

Generate **both** branches, each weighted:

- Renewal, weight `p`, commencing the day after expiry.
- New lease, weight `1 − p`, commencing after the profile's downtime.

Each branch carries its own term, free rent, TI and commission, and all its cash
flows and occupied area are scaled by its weight. Branches chain forward,
bounded by a 40-generation ceiling and a 0.0001 weight floor.

## Consequences

Good: value moves **smoothly** with the renewal probability, which is what an
assumption that is genuinely a probability should do; downtime is captured for
exactly the share of outcomes that incur it; the result is a single
deterministic cash flow, not a distribution needing simulation.

Bad: the lease list contains fractional occurrences, which reads oddly at first;
branch count grows until pruning bites; no single branch is "the" outcome, so a
user asking "what happens if they renew?" needs a scenario, not this.

## Alternatives

**Threshold branching** (renew if `p > 0.5`) was rejected: it makes value
discontinuous — 49% and 51% give very different answers, which is indefensible
in front of an investment committee.

**Monte Carlo** was rejected: it sacrifices determinism, needs far more compute,
and answers a question about distribution that this platform is not being asked.
