# ADR 0005 — Hand-written SQL migrations, no ORM

**Status:** Accepted · 2026-08-04

## Context

The schema carries domain rules as constraints: ownership between 0 and 1,
expiration on or after commencement, recoverable and variable shares within
range, positive debt terms, non-negative areas.

## Decision

Migrations are hand-written SQL in `packages/database/migrations`, applied by a
small runner that wraps each file in a transaction and records a SHA-256
checksum. An already-applied migration whose contents changed is **refused**.

Queries use `postgres.js` tagged templates. There is no ORM.

## Consequences

Good: the exact statements applied to production are reviewable in the diff;
constraints read as SQL, which is where a reviewer expects them; no generated
migration to inspect for surprises; full access to `SKIP LOCKED`, partial
indexes, array and JSONB operators.

Bad: the repository layer is written by hand; no automatic type generation from
the schema — row shapes are declared in TypeScript and kept honest by the
integration tests, which run every query against a real database.

The checksum rule is deliberately strict. Editing an applied migration is how
environments silently diverge; refusing it forces the correct habit of adding a
new one.

## Alternatives

**Prisma** — a generated client and migrations, at the cost of a binary engine,
a second schema language, and generated SQL to audit.

**Drizzle** — closer to SQL and a reasonable choice; rejected mainly to keep the
constraint definitions in plain SQL where a database reviewer will look for them.
