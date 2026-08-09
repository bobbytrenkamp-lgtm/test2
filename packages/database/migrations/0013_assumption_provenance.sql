-- Assumption provenance, and proposals from outside the platform.
--
-- Two related things, both about where a number came from.
--
-- Purely additive, so the previous release runs against this schema unchanged:
-- it never reads either table and never writes to them, which leaves every
-- model behaving exactly as it does today. See scripts/check-migrations.mjs.

-- A value somebody or something outside this model suggests for an assumption.
--
-- A *proposal*, deliberately, not a value. Nothing here reaches the calculation
-- engine and nothing is applied automatically: an external market-data service
-- can say "rent growth in this submarket is 2.7%", and the analyst decides
-- whether their 3.0% should change. Silently replacing somebody's underwriting
-- with a third party's number would be indefensible whatever the third party's
-- accuracy, because the analyst is the one who has to defend the model.
CREATE TABLE assumption_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_id        uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,

  -- What the proposal is about, in the platform's own terms: a dotted path
  -- such as `valuation.terminalCapRate` or `marketLeasing.MLA-OFF.marketRent`.
  -- Text rather than an enumeration, because the set of addressable
  -- assumptions is the model's shape and grows with it; an unrecognised path
  -- is shown to the analyst rather than rejected, since a proposal about
  -- something this release cannot locate is still information.
  target          text NOT NULL,

  -- The suggested value, as a decimal string, matching every other numeric
  -- value in this system. Nullable for a proposal that is a comment rather
  -- than a figure.
  value           text,

  -- Where it came from. Free text rather than an enumeration for the same
  -- reason as `target`: the point is to record a real provenance, and a
  -- closed list would force a new source to masquerade as an old one.
  source_kind     text NOT NULL,
  source_name     text NOT NULL,

  -- How sure the source is, 0 to 1, when it can say. Nullable because most
  -- sources cannot, and a default of 1 would assert certainty nobody claimed.
  confidence      numeric(5, 4),

  -- When the source observed what it is reporting, which is not when it told
  -- us. A rent comparable from March is a March comparable in July.
  observed_at     timestamptz,

  -- Whatever the source wants to show its working: comparables, a sample size,
  -- a methodology note. Rendered as-is and never parsed for meaning.
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,

  notes           text,

  -- The analyst's decision. `pending` until somebody looks; `accepted` records
  -- that they applied it, `rejected` that they considered and kept their own.
  -- Both decisions are worth keeping: "we saw the market number and stayed at
  -- 3.0%" is a defensible position, and only recorded if rejection is a state
  -- rather than a delete.
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  decision_note   text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL
);

-- The list is read per model, newest first, and filtered by status on the
-- screen that shows it.
CREATE INDEX assumption_proposals_model_idx
  ON assumption_proposals (model_id, status, created_at DESC);

-- A source may only have one live proposal per target per model. A second one
-- supersedes the first rather than stacking, so an analyst is never asked to
-- decide between two versions of the same opinion.
CREATE UNIQUE INDEX assumption_proposals_live_idx
  ON assumption_proposals (model_id, target, source_name)
  WHERE status = 'pending';
