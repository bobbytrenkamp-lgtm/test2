-- ---------------------------------------------------------------------------
-- 0011 - Recorded server faults
--
-- Forward-only. One new table.
-- ---------------------------------------------------------------------------

-- Unhandled failures went to the process log and nowhere else. On a machine
-- that is not being watched, that means nobody learns a calculation is failing
-- for one organization until somebody complains — which on a valuation platform
-- may be after the number has been relied on.
--
-- This is deliberately a table and not a hosted service. It costs nothing, it
-- keeps failure detail inside the same database as everything else it refers
-- to, and it can be replaced later by anything that reads it. See
-- `docs/zero-cost-operation.md`.
--
-- What is NOT recorded matters as much as what is. No request body, no query
-- string values, no headers, no session token, and no model or tenant figures:
-- an error store is a copy of production data with weaker access controls
-- unless it is disciplined about that. The fingerprint, the route and the stack
-- are enough to find a fault; reproducing it needs the model, which is still
-- where it always was.
CREATE TABLE error_events (
  id              bigserial PRIMARY KEY,
  -- A stable hash of the fault's identity, so repeats group instead of
  -- flooding. Same route, same message shape, same top frame.
  fingerprint     text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  -- Nullable: a failure before the session is resolved has neither.
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  method          text NOT NULL,
  -- The route pattern (`/models/:id/calculate`), never the resolved path, so
  -- identifiers do not accumulate in a table nobody thinks of as sensitive.
  route           text NOT NULL,
  status_code     integer NOT NULL,
  error_name      text NOT NULL,
  message         text NOT NULL,
  stack           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX error_events_recent_idx ON error_events (occurred_at DESC, id DESC);
CREATE INDEX error_events_fingerprint_idx ON error_events (fingerprint, occurred_at DESC);
CREATE INDEX error_events_org_idx ON error_events (organization_id, occurred_at DESC);
