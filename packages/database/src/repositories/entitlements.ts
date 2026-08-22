import type { Entitlements, EntitlementPlan } from '@cre/domain-models';
import { DEFAULT_PLAN, DEFAULT_TRIAL_DAYS, PLAN_FEATURES } from '@cre/domain-models';
import type { Sql } from '../client.js';

/**
 * Organization entitlements: what a plan grants, and what state the
 * customer relationship is in. See `packages/domain-models/src/
 * entitlements.ts` for `canUseFeature` and why this is centralized rather
 * than scattered through the application.
 */

interface EntitlementsRow {
  organization_id: string;
  plan: EntitlementPlan;
  status: Entitlements['status'];
  max_users: number | null;
  max_properties: number | null;
  features: string[];
  trial_ends_at: string | null;
}

function toEntitlements(row: EntitlementsRow): Entitlements {
  return {
    organizationId: row.organization_id,
    plan: row.plan,
    status: row.status,
    maxUsers: row.max_users,
    maxProperties: row.max_properties,
    features: row.features as Entitlements['features'],
    trialEndsAt: row.trial_ends_at,
  };
}

export async function getEntitlements(
  sql: Sql,
  organizationId: string,
): Promise<Entitlements | null> {
  const rows = (await sql`
    SELECT organization_id, plan, status, max_users, max_properties, features,
           to_char(trial_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS trial_ends_at
    FROM organization_entitlements
    WHERE organization_id = ${organizationId}
  `) as unknown as EntitlementsRow[];
  const row = rows[0];
  return row ? toEntitlements(row) : null;
}

/**
 * Creates the default trial entitlements row for a newly created
 * organization. Meant to run inside the same transaction as the
 * organization's own creation (`createOrganization`), so an organization
 * never exists even briefly without one — every caller of `getEntitlements`
 * is written on the assumption that a real organization has a row.
 */
export async function ensureEntitlements(
  sql: Sql,
  organizationId: string,
  plan: EntitlementPlan = DEFAULT_PLAN,
): Promise<Entitlements> {
  const rows = (await sql`
    INSERT INTO organization_entitlements (organization_id, plan, status, trial_ends_at)
    VALUES (
      ${organizationId}, ${plan}, 'trial',
      now() + (${DEFAULT_TRIAL_DAYS} || ' days')::interval
    )
    ON CONFLICT (organization_id) DO UPDATE SET organization_id = organization_entitlements.organization_id
    RETURNING organization_id, plan, status, max_users, max_properties, features,
              to_char(trial_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS trial_ends_at
  `) as unknown as EntitlementsRow[];
  return toEntitlements(rows[0] as EntitlementsRow);
}

/**
 * Changes plan and/or status. Deliberately narrow — this is the one write
 * path, so an eventual billing-provider webhook has exactly one function to
 * call rather than a choice of several ways to update the same row.
 *
 * A plan change also resets `features` to that plan's documented default
 * (`PLAN_FEATURES`). Without this, a caller that changed only `plan` would
 * leave the stored `features` array exactly as it was — the row would claim
 * `enterprise` while `canUseFeature` kept reading whatever the previous
 * plan had granted, silently locking out every feature the new plan is
 * supposed to include. `applyPlanDefaults` re-applies the same defaults on
 * their own, for a caller that only wants that; this is what keeps a plain
 * plan change from needing to know that second call exists at all.
 */
export async function updateEntitlements(
  sql: Sql,
  organizationId: string,
  changes: { plan?: EntitlementPlan; status?: Entitlements['status'] },
): Promise<Entitlements | null> {
  if (changes.plan === undefined && changes.status === undefined) {
    return getEntitlements(sql, organizationId);
  }
  const rows = (await sql`
    UPDATE organization_entitlements
    SET plan = COALESCE(${changes.plan ?? null}, plan),
        status = COALESCE(${changes.status ?? null}, status),
        features = ${
          changes.plan === undefined
            ? sql`features`
            : sql.json(PLAN_FEATURES[changes.plan] as never)
        },
        updated_at = now()
    WHERE organization_id = ${organizationId}
    RETURNING organization_id, plan, status, max_users, max_properties, features,
              to_char(trial_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS trial_ends_at
  `) as unknown as EntitlementsRow[];
  const row = rows[0];
  return row ? toEntitlements(row) : null;
}

/**
 * Sets a plan's feature list to its documented default
 * (`PLAN_FEATURES` in `@cre/domain-models`). Exists so changing plan and
 * granting that plan's features is one call rather than two call sites that
 * have to agree, which is exactly the drift `PLAN_FEATURES` being the one
 * definition of a plan is meant to prevent.
 */
export async function applyPlanDefaults(
  sql: Sql,
  organizationId: string,
  plan: EntitlementPlan,
): Promise<Entitlements | null> {
  const rows = (await sql`
    UPDATE organization_entitlements
    SET plan = ${plan}, features = ${sql.json(PLAN_FEATURES[plan] as never)}, updated_at = now()
    WHERE organization_id = ${organizationId}
    RETURNING organization_id, plan, status, max_users, max_properties, features,
              to_char(trial_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS trial_ends_at
  `) as unknown as EntitlementsRow[];
  const row = rows[0];
  return row ? toEntitlements(row) : null;
}
