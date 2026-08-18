# Repository assessment

**Date:** 2026-08-04
**Assessed by:** platform build, initial engagement
**Verdict:** Build in place. No migration, no separate repository.

## What was here

The audit was short because the repository was empty.

```
$ git log --oneline
4576eb6 Initial commit

$ find . -path ./.git -prune -o -type f -print
./README.md
```

`README.md` contained seven bytes: `# test2`.

| Question | Finding |
| --- | --- |
| Framework | None. No package manifest, no source, no configuration. |
| Static or full stack | Neither. There was no application. |
| Dependencies | None to install. |
| Build / lint / typecheck / tests | None existed, so none could be run or fail. |
| Deployment method | None configured. |
| Data sources | None. |
| Authentication | None. |
| Reusable components | None. |
| Licence | No licence file. Owner-controlled repository, no conflict. |
| AI context files, docs, datasets | None present. Nothing to preserve. |

Because there was no prior application, the instruction to preserve existing
functionality had nothing to act on, and the instruction to document failures
before changing architecture had no failures to document. Nothing was deleted
or moved; the original `README.md` was rewritten in place to describe what the
repository now contains, and no `legacy/` directory was needed.

## Environment observed during the audit

| Item | State |
| --- | --- |
| Node | 22.22.2 |
| Package managers | pnpm and npm available; pnpm chosen |
| PostgreSQL | Client and server binaries 16 present; no server running at audit time |
| Docker | CLI present, daemon not running |
| Network | npm registry reachable through the configured proxy |

A PostgreSQL cluster was started locally during the build so that migrations,
seeding and the integration tests could be exercised against a real database
rather than a mock. The Docker daemon was unavailable, so the Compose files in
`infrastructure/` are written but have **not** been executed; that is recorded
honestly in `docs/feature-status.md` and `docs/deployment-guide.md`.

## Decision

**Continue in this repository, building the platform in place.**

The decision criteria in the brief resolve as follows.

*Reasons a separate repository would have been required — none apply:*

- Repository permissions do not prevent development; commits and pushes work.
- The repository contains no unrelated or confidential material.
- There is no licence conflict.
- There is no existing structure that migration could endanger.
- The owner has not asked for a separate repository.

*Reasons the existing application would have been extended rather than
replaced — none apply either,* because there was no existing application. The
choice was therefore not "keep or replace" but simply "what to build".

A monorepo was chosen over a single application because the calculation engine
must be independently testable and independently versioned. The engine is the
component whose correctness matters most and whose outputs must be reproducible
years after they were produced; isolating it in a package with no dependency on
the database, the HTTP layer or the browser is what makes that possible. The
structure follows the layout suggested in the brief:

```
apps/
  api/        Fastify application API
  web/        React analyst client
  worker/     Background job consumer
packages/
  calculation-engine/  Deterministic financial engine (no I/O)
  database/            Migrations, repositories, seed data
  domain-models/       Schemas, types, permission model
  reporting/           Imports, report definitions, export renderers
docs/
infrastructure/
tests/
```

There is no `packages/ui` or `packages/validation`: the design system is a
single stylesheet plus a small component module inside `apps/web`, and
validation lives in `packages/domain-models` next to the schemas it validates.
Splitting either into its own package would add a build boundary without a
second consumer to justify it. If a second client appears, that changes.

## Risks accepted

| Risk | Mitigation |
| --- | --- |
| Compose files unverified because no Docker daemon was available | Local development was proven instead against a directly installed PostgreSQL 16; the Compose stack itself was later built and run end to end by a `docker` job in CI (see `docs/feature-status.md` and `docs/deployment-guide.md`) |
| A hand-written SQL migration runner instead of an ORM's generator | Migrations are reviewable in the diff, checksummed, and applied in a transaction; an edited applied migration is refused rather than skipped |
| Engine methodology decisions (rollover weighting, preferred-return accrual, percentage-rent timing) are judgement calls | Each is documented in `docs/calculation-specification.md` with its rationale, and covered by a regression fixture |

## Alternatives considered

**A single Next.js application.** Rejected: it would have placed the
calculation engine inside the web framework's module graph, making it harder to
version the engine independently and tempting future contributors to reach for
a request context from inside a financial calculation.

**Prisma or Drizzle with generated migrations.** Rejected in favour of
hand-written SQL. The schema carries constraints that express domain rules —
ownership between 0 and 1, expiration on or after commencement, recoverable and
variable shares within range — and those read more clearly as SQL than as ORM
decorators. The cost is that the repository layer is written by hand.

**A separate repository for the engine.** Deferred, not rejected. If the engine
is ever licensed or consumed independently it should move; until then, keeping
it in the monorepo means a change to a shared type is typechecked against every
consumer in one command.
