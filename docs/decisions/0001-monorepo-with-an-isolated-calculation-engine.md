# ADR 0001 — Monorepo with an isolated calculation engine

**Status:** Accepted · 2026-08-04

## Context

The repository was empty, so the structure was a free choice. The platform's
most important property is that a valuation produced today can be reproduced and
explained years from now.

## Decision

A pnpm monorepo. `packages/calculation-engine` holds every financial
calculation and depends only on `packages/domain-models` and `decimal.js`. It
performs no I/O and has no access to the database, the HTTP layer, the
filesystem or the network.

## Consequences

Good: the engine is versioned independently and testable without any
infrastructure; a shared type change is typechecked against every consumer in
one command; the engine could later be extracted or licensed without unpicking
it from a web framework.

Bad: an extra build boundary; assembling engine input from the database is
explicit work (`buildModelInput`) rather than something an ORM does implicitly.

That explicitness is a feature. `buildModelInput` is the single place the
database becomes an engine input, which is exactly what makes a stored version
recalculable without touching a live table.

## Alternatives

**A single Next.js application** would have put the engine inside the web
framework's module graph, making independent versioning awkward and tempting
future contributors to reach for a request context inside a financial
calculation.

**A separate repository for the engine** is deferred, not rejected. It should
move if it is ever consumed independently.
