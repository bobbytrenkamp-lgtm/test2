-- The PDF-to-assumption import pipeline: sessions, and typed proposal values.
--
-- Purely additive, so the previous release runs against this schema unchanged:
-- it never reads either new thing and never writes to them, which leaves every
-- model behaving exactly as it does today. See scripts/check-migrations.mjs.

-- One extraction, grouped.
--
-- A single PDF commonly produces dozens of individual assumption proposals.
-- Each proposal already stands on its own — it has its own target, its own
-- value, its own decision — but a reviewer asking "what did that Raleigh
-- Industrial OM actually change" wants the batch, not forty unrelated rows.
-- This is the grouping, nothing more: it does not gate, validate or apply
-- anything that `assumption_proposals` does not already gate, validate or
-- apply on its own.
CREATE TABLE import_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_id        uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,

  -- Where the structured data said it came from. Free text, matching
  -- assumption_proposals.source_name/source_kind, for the same reason: the
  -- set of extraction tools is not this schema's to enumerate.
  source_system   text,
  source_skill    text,
  document_name   text,
  document_date   date,

  -- Counts as reported by the analyzer at the moment the session was created,
  -- so a session's own summary does not depend on rows that could later be
  -- edited elsewhere. What each proposal now says is still readable from
  -- assumption_proposals itself.
  received_count    integer NOT NULL DEFAULT 0,
  recognized_count  integer NOT NULL DEFAULT 0,
  applied_count     integer NOT NULL DEFAULT 0,
  kept_count        integer NOT NULL DEFAULT 0,
  unresolved_count  integer NOT NULL DEFAULT 0,
  unsupported_count integer NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX import_sessions_model_idx
  ON import_sessions (model_id, created_at DESC);

-- Which proposals a session produced, so the provenance screen can expand one
-- session into the individual field decisions inside it without a second
-- grouping mechanism. Nullable and unconstrained on the other side: a
-- proposal posted directly through the assumption contract (not through an
-- import) has no session, and that is the ordinary case, not an error one.
ALTER TABLE assumption_proposals
  ADD COLUMN import_session_id uuid REFERENCES import_sessions(id) ON DELETE SET NULL;

CREATE INDEX assumption_proposals_import_session_idx
  ON assumption_proposals (import_session_id)
  WHERE import_session_id IS NOT NULL;

-- What shape `value` is in, so a decision can apply it correctly.
--
-- `value` has been a decimal string since 0013, because every assumption the
-- contract carried was a rate, an amount or a share. The import pipeline
-- widens that to the CRE-assumption-import value types — a sale month is an
-- integer, a funding date is a date, an accrual convention is one of a fixed
-- set of words — without turning the column into a bag of arbitrary JSON: it
-- is still exactly one scalar, serialised as text, with this column saying
-- how to read it back. Existing rows default to 'decimal', which is what
-- every one of them already is.
ALTER TABLE assumption_proposals
  ADD COLUMN value_type text NOT NULL DEFAULT 'decimal'
    CHECK (value_type IN ('decimal', 'integer', 'date', 'boolean', 'string', 'enum'));
