-- ---------------------------------------------------------------------------
-- 0003_models
--
-- Models are scenarios for a property. Every assumption that a scenario can
-- vary hangs off model_id, so cloning a model copies only these tables.
--
-- model_versions holds immutable snapshots: the exact ModelInput that was
-- calculated, the result, and the engine version that produced it. Approved
-- versions are never rewritten, which is what makes a stored valuation
-- reproducible and defensible.
-- ---------------------------------------------------------------------------

CREATE TABLE models (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id          uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  classification       text NOT NULL CHECK (classification IN (
                         'acquisition', 'valuation', 'budget', 'reforecast',
                         'business_plan', 'base_case', 'upside_case',
                         'downside_case', 'lender_case', 'appraisal_case',
                         'development_case', 'disposition_case')),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN (
                         'draft', 'analyst_review', 'manager_review', 'approved',
                         'published', 'superseded', 'archived')),
  owner_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  valuation_date       date NOT NULL,
  forecast_start_date  date NOT NULL,
  forecast_months      integer NOT NULL CHECK (forecast_months BETWEEN 1 AND 600),
  fiscal_year_start_month integer NOT NULL DEFAULT 1
                         CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  proration_convention text NOT NULL DEFAULT 'actual_days'
                         CHECK (proration_convention IN ('actual_days', 'thirty_360', 'full_month')),
  currency             char(3) NOT NULL DEFAULT 'USD',
  area_unit            text NOT NULL DEFAULT 'sqft' CHECK (area_unit IN ('sqft', 'sqm')),
  assumption_date      date,
  notes                text,
  -- Assumptions that are single-valued for the model.
  discount_rate            numeric(12, 8),
  discounting_convention   text NOT NULL DEFAULT 'end_of_period'
                             CHECK (discounting_convention IN ('end_of_period', 'mid_period')),
  terminal_cap_rate        numeric(12, 8),
  terminal_noi_basis       text NOT NULL DEFAULT 'forward_12'
                             CHECK (terminal_noi_basis IN ('forward_12', 'trailing_12')),
  sale_cost_percent        numeric(12, 8) NOT NULL DEFAULT 0,
  sale_month               integer,
  gross_sale_price_override numeric(20, 2),
  direct_cap_rate          numeric(12, 8),
  direct_cap_noi_basis     text NOT NULL DEFAULT 'year_1'
                             CHECK (direct_cap_noi_basis IN ('year_1', 'stabilized', 'trailing_12')),
  direct_cap_adjustments   numeric(20, 2) NOT NULL DEFAULT 0,
  acquisition_price        numeric(20, 2),
  acquisition_costs        numeric(20, 2) NOT NULL DEFAULT 0,
  acquisition_date         date,
  general_vacancy_rate     numeric(12, 8) NOT NULL DEFAULT 0,
  net_against_modelled_vacancy boolean NOT NULL DEFAULT true,
  credit_loss_rate         numeric(12, 8) NOT NULL DEFAULT 0,
  default_market_leasing_profile_id uuid,
  equity_structure         jsonb NOT NULL DEFAULT '{"partners":[],"tiers":[],"fees":[]}'::jsonb,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE INDEX models_property_idx ON models (property_id) WHERE deleted_at IS NULL;
CREATE INDEX models_org_status_idx ON models (organization_id, status);

CREATE TABLE growth_curves (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id      uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  code          text NOT NULL,
  name          text NOT NULL,
  default_rate  numeric(12, 8) NOT NULL DEFAULT 0,
  by_year       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, code)
);

CREATE TABLE market_leasing_profiles (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id                 uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
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
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mlp_probability_range CHECK (renewal_probability >= 0 AND renewal_probability <= 1),
  UNIQUE (model_id, code)
);

CREATE TABLE leases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id            uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code                text NOT NULL,
  status              text NOT NULL CHECK (status IN (
                        'occupied', 'future', 'vacant', 'month_to_month', 'holdover',
                        'expired', 'terminated', 'pending', 'proposed', 'sublease')),
  area                numeric(18, 4) NOT NULL DEFAULT 0,
  unit_count          integer NOT NULL DEFAULT 0,
  execution_date      date,
  possession_date     date,
  commencement_date   date NOT NULL,
  rent_start_date     date,
  expiration_date     date NOT NULL,
  base_rent           numeric(20, 6) NOT NULL DEFAULT 0,
  base_rent_basis     text NOT NULL DEFAULT 'per_area_per_year',
  escalation          jsonb NOT NULL DEFAULT '{}'::jsonb,
  free_rent           jsonb NOT NULL DEFAULT '[]'::jsonb,
  percentage_rent     jsonb NOT NULL DEFAULT '{}'::jsonb,
  recovery            jsonb NOT NULL DEFAULT '{}'::jsonb,
  options             jsonb NOT NULL DEFAULT '[]'::jsonb,
  leasing_costs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  other_revenue       jsonb NOT NULL DEFAULT '[]'::jsonb,
  security_deposit    numeric(20, 2),
  market_leasing_profile_id uuid REFERENCES market_leasing_profiles(id) ON DELETE SET NULL,
  exclude_from_rollover boolean NOT NULL DEFAULT false,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leases_dates_ordered CHECK (expiration_date >= commencement_date),
  CONSTRAINT leases_area_non_negative CHECK (area >= 0),
  UNIQUE (model_id, code)
);
CREATE INDEX leases_model_idx ON leases (model_id);
CREATE INDEX leases_tenant_idx ON leases (tenant_id);
CREATE INDEX leases_expiry_idx ON leases (model_id, expiration_date);

CREATE TABLE lease_spaces (
  lease_id uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  PRIMARY KEY (lease_id, space_id)
);

CREATE TABLE lease_rent_steps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id   uuid NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  amount     numeric(20, 6) NOT NULL,
  basis      text NOT NULL DEFAULT 'per_area_per_year',
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (lease_id, start_date)
);
CREATE INDEX lease_rent_steps_lease_idx ON lease_rent_steps (lease_id, start_date);

CREATE TABLE operating_expenses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id          uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  code              text NOT NULL,
  name              text NOT NULL,
  category          text NOT NULL,
  account_code      text,
  method            text NOT NULL,
  amount            numeric(20, 6) NOT NULL DEFAULT 0,
  growth_curve      text,
  recoverable_share numeric(9, 8) NOT NULL DEFAULT 0,
  variable_share    numeric(9, 8) NOT NULL DEFAULT 0,
  monthly_schedule  jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_capitalized    boolean NOT NULL DEFAULT false,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_shares_range CHECK (
    recoverable_share BETWEEN 0 AND 1 AND variable_share BETWEEN 0 AND 1),
  UNIQUE (model_id, code)
);
CREATE INDEX operating_expenses_model_idx ON operating_expenses (model_id);

CREATE TABLE other_revenue_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id           uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  code               text NOT NULL,
  name               text NOT NULL,
  category           text NOT NULL DEFAULT 'other',
  method             text NOT NULL,
  amount             numeric(20, 6) NOT NULL DEFAULT 0,
  growth_curve       text,
  vary_with_occupancy boolean NOT NULL DEFAULT false,
  monthly_schedule   jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, code)
);

CREATE TABLE capital_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id         uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  code             text NOT NULL,
  name             text NOT NULL,
  category         text NOT NULL,
  method           text NOT NULL,
  amount           numeric(20, 6) NOT NULL DEFAULT 0,
  start_date       date,
  end_date         date,
  growth_curve     text,
  monthly_schedule jsonb NOT NULL DEFAULT '[]'::jsonb,
  capitalized      boolean NOT NULL DEFAULT true,
  funding_source   text,
  approval_status  text NOT NULL DEFAULT 'proposed',
  useful_life_years integer,
  sort_order       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capital_dates_ordered CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  UNIQUE (model_id, code)
);

CREATE TABLE debt_facilities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id              uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  code                  text NOT NULL,
  name                  text NOT NULL,
  type                  text NOT NULL,
  commitment            numeric(20, 2) NOT NULL DEFAULT 0,
  initial_funding       numeric(20, 2) NOT NULL DEFAULT 0,
  funding_date          date NOT NULL,
  draws                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  rate_type             text NOT NULL DEFAULT 'fixed' CHECK (rate_type IN ('fixed', 'floating')),
  fixed_rate            numeric(12, 8) NOT NULL DEFAULT 0,
  index_curve           text,
  spread                numeric(12, 8) NOT NULL DEFAULT 0,
  rate_floor            numeric(12, 8),
  rate_cap              numeric(12, 8),
  interest_only_months  integer NOT NULL DEFAULT 0,
  amortization_months   integer NOT NULL DEFAULT 0,
  term_months           integer NOT NULL CHECK (term_months > 0),
  origination_fee_percent numeric(12, 8) NOT NULL DEFAULT 0,
  exit_fee_percent      numeric(12, 8) NOT NULL DEFAULT 0,
  unused_fee_percent    numeric(12, 8) NOT NULL DEFAULT 0,
  capitalize_interest   boolean NOT NULL DEFAULT false,
  minimum_dscr          numeric(12, 8),
  maximum_ltv           numeric(12, 8),
  maximum_ltc           numeric(12, 8),
  minimum_debt_yield    numeric(12, 8),
  repay_on_sale         boolean NOT NULL DEFAULT true,
  sort_order            integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT debt_commitment_non_negative CHECK (commitment >= 0),
  UNIQUE (model_id, code)
);

-- ---------------------------------------------------------------------------
-- Immutable versions and calculation results
-- ---------------------------------------------------------------------------

CREATE TABLE model_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id        uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  version_number  integer NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN (
                    'draft', 'submitted', 'approved', 'superseded', 'archived')),
  -- The exact engine input that was calculated. Never rewritten.
  input           jsonb NOT NULL,
  engine_version  text NOT NULL,
  label           text,
  notes           text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, version_number)
);
CREATE INDEX model_versions_model_idx ON model_versions (model_id, version_number DESC);

CREATE TABLE calculation_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id          uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  model_version_id  uuid REFERENCES model_versions(id) ON DELETE CASCADE,
  engine_version    text NOT NULL,
  status            text NOT NULL DEFAULT 'succeeded'
                      CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  -- Full engine output, including annual and monthly series.
  result            jsonb,
  diagnostics       jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message     text,
  duration_ms       integer,
  requested_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
CREATE INDEX calculation_runs_model_idx ON calculation_runs (model_id, created_at DESC);
CREATE INDEX calculation_runs_version_idx ON calculation_runs (model_version_id);

-- Calculation traces are large, so they are stored separately from the result
-- and fetched only when a user opens the calculation inspector.
CREATE TABLE calculation_traces (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calculation_run_id uuid NOT NULL REFERENCES calculation_runs(id) ON DELETE CASCADE,
  entries            jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calculation_traces_run_idx ON calculation_traces (calculation_run_id);

ALTER TABLE models
  ADD CONSTRAINT models_default_profile_fk
  FOREIGN KEY (default_market_leasing_profile_id)
  REFERENCES market_leasing_profiles(id) ON DELETE SET NULL;
