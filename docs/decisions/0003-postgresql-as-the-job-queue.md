# ADR 0003 — PostgreSQL as the job queue

**Status:** Accepted · 2026-08-04

## Context

Imports, exports, report rendering, portfolio aggregation and batch scenario
runs must not block a request. The platform already depends on PostgreSQL.

## Decision

A `jobs` table consumed with `FOR UPDATE SKIP LOCKED`. Any number of workers can
poll the same queue; each transaction claims rows no other worker holds.

## Consequences

Good: no second piece of infrastructure to operate, back up, secure or monitor;
jobs are transactional with the data they touch; the queue is inspectable with
SQL and visible in the interface.

Bad: polling rather than push (2s idle, 50ms busy — invisible at this scale);
throughput is bounded by the database; a very high job rate would eventually
need something purpose-built.

Mitigations already in place: a partial index on ready jobs; exponential backoff
on failure with an attempt ceiling, after which a job stays `failed` for an
operator rather than retrying forever; a reaper that releases jobs whose worker
died mid-run.

`packages/database/src/repositories/jobs.ts` is the seam to replace if
throughput ever demands it.

## Alternatives

**Redis, BullMQ, SQS** — more capability than the platform needs, at the cost of
another production dependency. Revisit when measurements, not speculation, say
the database queue is the bottleneck.
