-- Product entitlements and organization lifecycle state.
--
-- Purely additive: the previous release never reads or writes this table, so
-- every organization created before this migration behaves exactly as it did
-- before, once backfilled below. See scripts/check-migrations.mjs.

-- One row per organization. What a plan grants and what state the customer
-- relationship is in, kept apart from the operational data (models,
-- properties, memberships) that has nothing to do with billing or plan tier.
--
-- Deliberately not scattered as `if (plan === ...)` checks throughout the
-- application: `canUseFeature` (packages/domain-models/src/entitlements.ts)
-- is the one place a feature name is checked against this row, and nothing
-- here is coupled to a payment provider. See docs/commercial-gap-analysis.md
-- and docs/commercial-product-strategy.md.
CREATE TABLE organization_entitlements (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

  -- What was sold, or would be. Not priced anywhere in this schema — see
  -- docs/commercial-product-strategy.md's "Commercial plans" milestone,
  -- which is explicit that pricing is documentation before it is code.
  plan            text NOT NULL DEFAULT 'starter'
                    CHECK (plan IN ('starter', 'professional', 'enterprise', 'internal')),

  -- The customer relationship's own lifecycle, independent of any one
  -- model's status. A model moves through draft/review/approved; an
  -- organization moves through trial/active/suspended — the two systems
  -- were never meant to be the same one and are not merged here.
  --
  -- 'trial' and 'internal' both grant full access regardless of `features`
  -- below, by design: a prospect experiences the whole product during a
  -- trial rather than a crippled preview of it, and an internal
  -- organization (demos, development) has no reason to be limited by a
  -- plan nobody sold it.
  status          text NOT NULL DEFAULT 'trial'
                    CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled', 'internal')),

  max_users       integer,
  max_properties  integer,

  -- The named features this plan grants, checked only when `status` is
  -- 'active' or 'past_due' — see `canUseFeature`. An empty array for a
  -- trial or internal organization is not a lockout, because those two
  -- statuses do not consult it.
  features        jsonb NOT NULL DEFAULT '[]'::jsonb,

  trial_ends_at   timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Every organization that existed before this migration gets a trial row,
-- rather than being left without one: `getEntitlements` is written to treat
-- a missing row as "not found" and every caller has to decide what that
-- means, which is a worse default than simply ensuring the row exists.
INSERT INTO organization_entitlements (organization_id, plan, status)
SELECT id, 'starter', 'trial' FROM organizations
ON CONFLICT (organization_id) DO NOTHING;
