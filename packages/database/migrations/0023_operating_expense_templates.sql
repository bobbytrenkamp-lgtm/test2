-- Organization-level operating expense library, the third reusable
-- assumption family after growth curves (migration 0020) and market leasing
-- profiles (migration 0022). Same shape, same reasoning: an operating
-- expense (migration 0003) has always been model-scoped, so a firm's normal
-- tax, insurance, utilities, management fee, repairs, payroll and CAM
-- structures get re-typed by hand into every new acquisition.
--
-- Mirrors operating_expenses column-for-column, minus model_id (this lives
-- under organization_id instead), minus sort_order (a template has no
-- position among a model's other expenses until it is applied to one), and
-- minus the model-scoped version/optimistic-locking column, which a template
-- with no concurrent editors racing against a save has no use for.
--
-- growth_curve is kept as a plain code, exactly as it is on the model-level
-- table: it is validated nowhere at the database layer today (a model's own
-- expense can already name a growth curve that does not exist, caught only
-- by the engine's GROWTH_CURVE_NOT_FOUND diagnostic at calculate time), so a
-- template does not invent a stricter rule than the row it is templating.

CREATE TABLE operating_expense_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code              text NOT NULL,
  name              text NOT NULL,
  category          text NOT NULL DEFAULT 'operating',
  account_code      text,
  method            text NOT NULL DEFAULT 'fixed_annual',
  amount            numeric(20, 6) NOT NULL DEFAULT 0,
  growth_curve      text,
  recoverable_share numeric(9, 8) NOT NULL DEFAULT 0,
  variable_share    numeric(9, 8) NOT NULL DEFAULT 0,
  monthly_schedule  jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_capitalized    boolean NOT NULL DEFAULT false,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Mirrors operating_expenses' own expenses_shares_range constraint
  -- (migration 0003): the same defense-in-depth the model-level table
  -- already applies, so a template cannot store a share the row it seeds
  -- would itself be refused for.
  CONSTRAINT expense_templates_shares_range
    CHECK (recoverable_share BETWEEN 0 AND 1 AND variable_share BETWEEN 0 AND 1),
  UNIQUE (organization_id, code)
);

-- Traceability, built in from the start (growth curves got this as a
-- follow-up in migration 0021; market leasing profiles got it from the
-- start in migration 0022): which library entry an expense was seeded from,
-- and what it was called at that moment. A plain snapshot, not a foreign
-- key -- editing or deleting the template afterward must not reach back
-- into a model that already applied it.
ALTER TABLE operating_expenses
  ADD COLUMN source_template_code text,
  ADD COLUMN source_template_name text;
