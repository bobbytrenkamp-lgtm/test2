-- ---------------------------------------------------------------------------
-- 0002_property_domain
--
-- Physical assets, portfolios and the tenant registry.
--
-- Physical structure (property, building, space) is shared across every model
-- of a property. Scenario-specific data lives in 0003 and hangs off a model, so
-- cloning a model never duplicates the building.
-- ---------------------------------------------------------------------------

CREATE TABLE workspaces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, name)
);

CREATE TABLE properties (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id        uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  name                text NOT NULL,
  property_type       text NOT NULL,
  property_subtype    text,
  address_line1       text,
  address_line2       text,
  city                text,
  state_region        text,
  postal_code         text,
  country             char(2) NOT NULL DEFAULT 'US',
  latitude            numeric(9, 6),
  longitude           numeric(9, 6),
  parcel_identifiers  text[],
  market              text,
  submarket           text,
  tax_jurisdiction    text,
  time_zone           text NOT NULL DEFAULT 'UTC',
  currency            char(3) NOT NULL DEFAULT 'USD',
  area_unit           text NOT NULL DEFAULT 'sqft' CHECK (area_unit IN ('sqft', 'sqm')),
  year_built          integer,
  year_renovated      integer,
  gross_building_area numeric(18, 4),
  rentable_area       numeric(18, 4),
  land_area           numeric(18, 4),
  building_count      integer NOT NULL DEFAULT 1,
  unit_count          integer NOT NULL DEFAULT 0,
  parking_count       integer NOT NULL DEFAULT 0,
  ownership_percent   numeric(9, 8) NOT NULL DEFAULT 1,
  acquisition_date    date,
  acquisition_price   numeric(20, 2),
  tags                text[] NOT NULL DEFAULT '{}',
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT properties_ownership_range CHECK (ownership_percent >= 0 AND ownership_percent <= 1),
  CONSTRAINT properties_area_non_negative CHECK (rentable_area IS NULL OR rentable_area >= 0)
);
CREATE INDEX properties_org_idx ON properties (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX properties_type_idx ON properties (organization_id, property_type);
CREATE INDEX properties_market_idx ON properties (organization_id, market, submarket);

CREATE TABLE buildings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name          text NOT NULL,
  year_built    integer,
  floor_count   integer,
  rentable_area numeric(18, 4),
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX buildings_property_idx ON buildings (property_id);

CREATE TABLE spaces (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  building_id    uuid REFERENCES buildings(id) ON DELETE SET NULL,
  code           text NOT NULL,
  floor          text,
  space_type     text NOT NULL DEFAULT 'office',
  unit_type      text,
  area           numeric(18, 4) NOT NULL DEFAULT 0,
  unit_count     integer NOT NULL DEFAULT 0,
  is_non_revenue boolean NOT NULL DEFAULT false,
  notes          text,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spaces_area_non_negative CHECK (area >= 0),
  UNIQUE (property_id, code)
);
CREATE INDEX spaces_property_idx ON spaces (property_id);

CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id    uuid REFERENCES properties(id) ON DELETE CASCADE,
  name           text NOT NULL,
  parent_company text,
  guarantor      text,
  industry       text,
  credit_rating  text,
  is_public      boolean,
  risk_class     text,
  is_anchor      boolean NOT NULL DEFAULT false,
  contact_name   text,
  contact_email  text,
  contact_phone  text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenants_org_idx ON tenants (organization_id);
CREATE INDEX tenants_property_idx ON tenants (property_id);

CREATE TABLE portfolios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  strategy        text,
  -- A dynamic portfolio selects properties by saved filter rather than by list.
  is_dynamic      boolean NOT NULL DEFAULT false,
  filter_definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, name)
);

CREATE TABLE portfolio_properties (
  portfolio_id     uuid NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ownership_percent numeric(9, 8) NOT NULL DEFAULT 1,
  added_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (portfolio_id, property_id)
);

CREATE TABLE funds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  vintage_year    integer,
  committed_capital numeric(20, 2),
  currency        char(3) NOT NULL DEFAULT 'USD',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- Property-level access grants. A user with no explicit grant falls back to
-- their organization role; a grant narrows or widens access to one property.
CREATE TABLE property_access (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access      text NOT NULL CHECK (access IN ('read', 'write', 'none')),
  granted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, user_id)
);

CREATE TABLE portfolio_access (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access       text NOT NULL CHECK (access IN ('read', 'write', 'none')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, user_id)
);
