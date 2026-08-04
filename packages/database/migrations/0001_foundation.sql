-- ---------------------------------------------------------------------------
-- 0001_foundation
--
-- Identity, organizations, permissions, sessions and the audit log.
--
-- Every tenant-scoped table carries organization_id and every query path is
-- expected to filter on it. Organization isolation is enforced in the API
-- authorization layer and covered by cross-organization access tests; the
-- foreign keys here make an orphaned or mis-scoped row impossible to write.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  base_currency char(3) NOT NULL DEFAULT 'USD',
  area_unit     text NOT NULL DEFAULT 'sqft' CHECK (area_unit IN ('sqft', 'sqm')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  -- scrypt hash; format "scrypt$N$r$p$salt$hash". Null when the account is
  -- provisioned through an external identity provider.
  password_hash  text,
  is_active      boolean NOT NULL DEFAULT true,
  mfa_enrolled   boolean NOT NULL DEFAULT false,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN (
                    'organization_owner', 'administrator', 'portfolio_manager',
                    'asset_manager', 'acquisitions', 'valuation', 'analyst',
                    'reviewer', 'read_only')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE organization_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           text NOT NULL,
  role            text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  invited_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_invitations_org_idx ON organization_invitations (organization_id);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only the hash of the session token is stored, so a database disclosure
  -- does not hand over live sessions.
  token_hash      text NOT NULL UNIQUE,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  user_agent      text,
  ip_address      inet,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only from the application's point of view: the API grants no UPDATE
-- or DELETE on this table to ordinary roles.
CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       text,
  property_id     uuid,
  model_id        uuid,
  previous_value  jsonb,
  new_value       jsonb,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address      inet,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_time_idx ON audit_log (organization_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_model_idx ON audit_log (model_id, occurred_at DESC);
