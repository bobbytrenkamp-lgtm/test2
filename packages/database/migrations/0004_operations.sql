-- ---------------------------------------------------------------------------
-- 0004_operations
--
-- Background jobs, spreadsheet imports, uploaded documents, budgets and
-- actuals, collaboration and saved dashboards.
-- ---------------------------------------------------------------------------

-- A PostgreSQL-backed job queue. Using the database the application already
-- depends on avoids a second piece of infrastructure until the throughput
-- genuinely warrants one; SKIP LOCKED gives safe concurrent consumption.
CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority        integer NOT NULL DEFAULT 100,
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  run_after       timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  locked_by       text,
  result          jsonb,
  error_message   text,
  requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs (status, run_after, priority)
  WHERE status = 'queued';
CREATE INDEX jobs_org_idx ON jobs (organization_id, created_at DESC);

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id     uuid REFERENCES properties(id) ON DELETE CASCADE,
  model_id        uuid REFERENCES models(id) ON DELETE SET NULL,
  filename        text NOT NULL,
  content_type    text NOT NULL,
  byte_size       bigint NOT NULL,
  checksum_sha256 text NOT NULL,
  -- Opaque key resolved by the storage driver, never a public URL.
  storage_key     text NOT NULL,
  storage_driver  text NOT NULL DEFAULT 'local',
  scan_status     text NOT NULL DEFAULT 'pending'
                    CHECK (scan_status IN ('pending', 'clean', 'infected', 'skipped', 'failed')),
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_size_positive CHECK (byte_size > 0)
);
CREATE INDEX documents_property_idx ON documents (property_id);

CREATE TABLE import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_id        uuid REFERENCES models(id) ON DELETE CASCADE,
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  kind            text NOT NULL DEFAULT 'rent_roll',
  status          text NOT NULL DEFAULT 'uploaded' CHECK (status IN (
                    'uploaded', 'analyzed', 'mapped', 'validated', 'importing',
                    'imported', 'failed', 'rolled_back')),
  source_filename text NOT NULL,
  sheet_name      text,
  header_row      integer,
  detected_columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  mapping         jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count       integer NOT NULL DEFAULT 0,
  imported_count  integer NOT NULL DEFAULT 0,
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX import_batches_model_idx ON import_batches (model_id, created_at DESC);

-- Reusable column-mapping templates, so the second rent roll from the same
-- source does not have to be mapped by hand again.
CREATE TABLE import_mapping_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'rent_roll',
  mapping         jsonb NOT NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- ---------------------------------------------------------------------------
-- Budgets, actuals and variance
-- ---------------------------------------------------------------------------

CREATE TABLE budget_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id     uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  model_id        uuid REFERENCES models(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN (
                    'original_budget', 'approved_budget', 'revised_budget', 'actual',
                    'current_forecast', 'prior_forecast', 'business_plan', 'reforecast')),
  fiscal_year     integer NOT NULL,
  label           text NOT NULL,
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, kind, fiscal_year, label)
);

CREATE TABLE budget_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_period_id uuid NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
  account_code     text NOT NULL,
  account_name     text NOT NULL,
  -- First day of the month the amount belongs to.
  period_month     date NOT NULL,
  amount           numeric(20, 2) NOT NULL DEFAULT 0,
  building_id      uuid REFERENCES buildings(id) ON DELETE SET NULL,
  tenant_id        uuid REFERENCES tenants(id) ON DELETE SET NULL,
  capital_item_id  uuid REFERENCES capital_items(id) ON DELETE SET NULL,
  department       text,
  commentary       text,
  UNIQUE (budget_period_id, account_code, period_month, building_id, tenant_id)
);
CREATE INDEX budget_entries_period_idx ON budget_entries (budget_period_id, period_month);

CREATE TABLE variance_commentary (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  fiscal_year      integer NOT NULL,
  period_month     date NOT NULL,
  account_code     text NOT NULL,
  commentary       text NOT NULL,
  author_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX variance_commentary_property_idx ON variance_commentary (property_id, period_month);

-- ---------------------------------------------------------------------------
-- Collaboration
-- ---------------------------------------------------------------------------

CREATE TABLE comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  body            text NOT NULL,
  mentions        uuid[] NOT NULL DEFAULT '{}',
  author_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_entity_idx ON comments (entity_type, entity_id, created_at DESC);

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
  due_date        date,
  property_id     uuid REFERENCES properties(id) ON DELETE CASCADE,
  model_id        uuid REFERENCES models(id) ON DELETE CASCADE,
  assignee_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_id, status);

CREATE TABLE model_approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id         uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  model_version_id uuid REFERENCES model_versions(id) ON DELETE CASCADE,
  from_status      text NOT NULL,
  to_status        text NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('submitted', 'approved', 'rejected', 'withdrawn')),
  comment          text,
  actor_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_approvals_model_idx ON model_approvals (model_id, created_at DESC);

-- Warnings a reviewer has consciously accepted. Critical errors are never
-- acknowledgeable; the API rejects an attempt to acknowledge one.
CREATE TABLE diagnostic_acknowledgements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id      uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  code          text NOT NULL,
  subject       text,
  justification text NOT NULL,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, code, subject)
);

CREATE TABLE dashboards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (scope IN ('organization', 'portfolio', 'fund', 'property', 'model')),
  scope_id        uuid,
  name            text NOT NULL,
  layout          jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  is_shared       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dashboards_scope_idx ON dashboards (organization_id, scope, scope_id);

CREATE TABLE saved_views (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  surface         text NOT NULL,
  name            text NOT NULL,
  definition      jsonb NOT NULL,
  is_shared       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
