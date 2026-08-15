-- Organization-level debt facility library, the fourth reusable assumption
-- family after growth curves (migration 0020), market leasing profiles
-- (migration 0022) and operating expenses (migration 0023).
--
-- Unlike the first three families, a debt facility mixes genuinely reusable
-- structure (rate type, fee percentages, covenant thresholds, amortisation
-- shape -- "our lender's standard bridge loan terms") with fields that are
-- inherently deal-specific and cannot be templated meaningfully: commitment
-- (a dollar amount sized to one acquisition), funding_date (a closing date)
-- and term_months (tied to that deal's hold period). Those three are still
-- stored here, exactly as `market_leasing_profile_templates` already stores
-- deal-adjacent fields like market_rent, because the model-level schema
-- requires all three to be non-null and the alternative -- omitting them --
-- would mean the template cannot seed a valid row at all. They are
-- overwritten in the vast majority of real uses; the value of the template
-- is the fifteen-odd structural fields the analyst does not have to retype.
--
-- cash_trap is deliberately not a column here: the model-level
-- debt_facilities table has never had a cash_trap column either (it is a
-- ModelInput/engine-only concept today -- see debt.ts's own use of
-- `facility.cashTrap` -- with no API route, UI field or DB column reaching
-- it), so a template does not invent support for a field the row it seeds
-- cannot itself store.
--
-- index_curve is kept as a plain code, exactly as it is on the model-level
-- table and exactly as market_rent_growth_curve is on the market leasing
-- template: unvalidated at the database layer, matching the row it
-- templates.

CREATE TABLE debt_facility_templates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code                     text NOT NULL,
  name                     text NOT NULL,
  type                     text NOT NULL DEFAULT 'permanent',
  commitment               numeric(20, 2) NOT NULL DEFAULT 0,
  initial_funding          numeric(20, 2) NOT NULL DEFAULT 0,
  funding_date             date NOT NULL DEFAULT '2020-01-01',
  draws                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  rate_type                text NOT NULL DEFAULT 'fixed' CHECK (rate_type IN ('fixed', 'floating')),
  fixed_rate               numeric(12, 8) NOT NULL DEFAULT 0,
  index_curve              text,
  spread                   numeric(12, 8) NOT NULL DEFAULT 0,
  rate_floor               numeric(12, 8),
  rate_cap                 numeric(12, 8),
  interest_only_months     integer NOT NULL DEFAULT 0,
  amortization_months      integer NOT NULL DEFAULT 0,
  term_months              integer NOT NULL DEFAULT 120 CHECK (term_months > 0),
  origination_fee_percent  numeric(12, 8) NOT NULL DEFAULT 0,
  exit_fee_percent         numeric(12, 8) NOT NULL DEFAULT 0,
  unused_fee_percent       numeric(12, 8) NOT NULL DEFAULT 0,
  capitalize_interest      boolean NOT NULL DEFAULT false,
  minimum_dscr             numeric(12, 8),
  maximum_ltv              numeric(12, 8),
  maximum_ltc              numeric(12, 8),
  minimum_debt_yield       numeric(12, 8),
  repay_on_sale            boolean NOT NULL DEFAULT true,
  created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- Mirrors debt_facilities' own two data-layer guards: migration 0003's
  -- debt_commitment_non_negative and migration 0018's type-enum check.
  CONSTRAINT debt_facility_templates_commitment_non_negative CHECK (commitment >= 0),
  CONSTRAINT debt_facility_templates_type_check CHECK (type IN (
    'acquisition', 'permanent', 'construction', 'bridge', 'revolver',
    'mezzanine', 'preferred_equity', 'seller_financing', 'supplemental'
  )),
  UNIQUE (organization_id, code)
);

-- Traceability, built in from the start -- see migration 0022/0023's own
-- note on why growth curves alone needed a follow-up migration for this.
ALTER TABLE debt_facilities
  ADD COLUMN source_template_code text,
  ADD COLUMN source_template_name text;
