-- Organization-level market leasing profile library, the second reusable
-- assumption family after growth curves (migration 0020). Same shape and
-- same reasoning: a market leasing profile (migration 0003) has always been
-- model-scoped, so a firm's standard renewal/downtime/TI/LC assumptions get
-- re-typed by hand into every new deal.
--
-- Mirrors market_leasing_profiles column-for-column, minus model_id (this
-- lives under organization_id instead) and minus the model-scoped
-- version/optimistic-locking column, which a template with no concurrent
-- editors racing against a save has no use for.
--
-- market_rent_growth_curve is kept as a plain code, exactly as it is on the
-- model-level table: it is validated nowhere at the database layer today
-- (a model's own profile can already name a growth curve that does not
-- exist, caught only by the engine's GROWTH_CURVE_NOT_FOUND diagnostic at
-- calculate time), so a template does not invent a stricter rule than the
-- row it is templating.

CREATE TABLE market_leasing_profile_templates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code                     text NOT NULL,
  name                     text NOT NULL,
  market_rent              numeric(20, 6) NOT NULL DEFAULT 0,
  market_rent_basis        text NOT NULL DEFAULT 'per_area_per_year',
  market_rent_growth_curve text,
  renewal_probability      numeric(9, 8) NOT NULL DEFAULT 0.65,
  renewal_term_months      integer NOT NULL DEFAULT 60,
  new_lease_term_months    integer NOT NULL DEFAULT 60,
  downtime_months          numeric(8, 2) NOT NULL DEFAULT 6,
  renewal_free_rent_months numeric(8, 2) NOT NULL DEFAULT 0,
  new_free_rent_months     numeric(8, 2) NOT NULL DEFAULT 3,
  renewal_ti_per_area      numeric(20, 6) NOT NULL DEFAULT 0,
  new_ti_per_area          numeric(20, 6) NOT NULL DEFAULT 0,
  renewal_lc_percent       numeric(12, 8) NOT NULL DEFAULT 0,
  new_lc_percent           numeric(12, 8) NOT NULL DEFAULT 0,
  renewal_escalation       jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_escalation           jsonb NOT NULL DEFAULT '{}'::jsonb,
  recovery                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  precedence               integer NOT NULL DEFAULT 0,
  created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mlpt_probability_range CHECK (renewal_probability >= 0 AND renewal_probability <= 1),
  UNIQUE (organization_id, code)
);

-- Traceability, built in from the start this time (growth curves got this
-- as a follow-up in migration 0021): which library entry a profile was
-- seeded from, and what it was called at that moment. A plain snapshot, not
-- a foreign key -- editing or deleting the template afterward must not
-- reach back into a model that already applied it.
ALTER TABLE market_leasing_profiles
  ADD COLUMN source_template_code text,
  ADD COLUMN source_template_name text;
