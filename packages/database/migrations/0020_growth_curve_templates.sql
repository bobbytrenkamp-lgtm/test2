-- Organization-level growth curve library.
--
-- Growth curves (migration 0003) have always been model-scoped only: every
-- model that wants the same "3% CPI, stepping to 2.5% after year five" rate
-- path re-enters the same by_year list by hand, with no way to keep them in
-- step across a portfolio. This is Argus's "Global Value File" concept for
-- reusable rate assumptions -- one named library entry per organization, and
-- an explicit "apply to this model" action writes a concrete copy into the
-- model's own growth_curves row through the existing upsert path. A template
-- is a starting point, not a live reference: a model's curve never re-reads
-- the template after it is applied, matching how this schema treats every
-- other assumption as a value the model owns once written.
--
-- New table, purely additive: nothing in the previous release reads or
-- writes it.

CREATE TABLE growth_curve_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code            text NOT NULL,
  name            text NOT NULL,
  default_rate    numeric(12, 8) NOT NULL DEFAULT 0,
  by_year         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);
