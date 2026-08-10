import { z } from 'zod';

/**
 * Product entitlements.
 *
 * What a plan grants, and what state the customer relationship is in — kept
 * as one small, centralized thing an application checks
 * (`canUseFeature(entitlements, feature)`) rather than scattered as
 * `if (plan === '...')` checks throughout the routes and the UI. See
 * `docs/commercial-gap-analysis.md` (Milestone 12) and
 * `docs/commercial-product-strategy.md`.
 *
 * ## Deliberately not coupled to a payment provider
 *
 * Nothing here names Stripe or any other vendor, and nothing here is priced.
 * `docs/commercial-product-strategy.md` states plainly that plans are
 * documentation before they are code, and that a payment button does not
 * make software commercially ready — entitlements exist so that when a
 * billing provider is eventually wired in, it is an adapter that writes to
 * this row, not a rewrite of every feature check in the application.
 */

/**
 * Named product capabilities a plan may grant. A fixed, closed list — the
 * same shape decision `packages/domain-models/src/permissions.ts` makes for
 * role capabilities, and for the same reason: an open-ended feature string
 * checked ad hoc at each call site is how "if (plan === ...)" ends up
 * scattered through an application. Add to this list, not around it.
 */
export const ENTITLEMENT_FEATURES = [
  'portfolio_analytics',
  'excel_live_model_export',
  'assumption_import',
  'research_intelligence',
  'custom_templates',
  'advanced_audit_history',
  'api_access',
  'sso',
] as const;
export type EntitlementFeature = (typeof ENTITLEMENT_FEATURES)[number];

export const entitlementFeatureEnum = z.enum(ENTITLEMENT_FEATURES);

export const entitlementPlanEnum = z.enum(['starter', 'professional', 'enterprise', 'internal']);
export type EntitlementPlan = z.infer<typeof entitlementPlanEnum>;

/**
 * The customer relationship's own lifecycle — independent of any one
 * model's status. A model moves through draft/review/approved; an
 * organization moves through trial/active/suspended, and the two are not
 * the same system. See `docs/commercial-gap-analysis.md` Milestone 6, which
 * is explicit that the model-status lifecycle already built for PR #42 is
 * not to be duplicated or confused with this one.
 */
export const entitlementStatusEnum = z.enum([
  'trial',
  'active',
  'past_due',
  'suspended',
  'cancelled',
  'internal',
]);
export type EntitlementStatus = z.infer<typeof entitlementStatusEnum>;

export const entitlementsSchema = z.object({
  organizationId: z.string().uuid(),
  plan: entitlementPlanEnum,
  status: entitlementStatusEnum,
  maxUsers: z.number().int().min(1).nullable(),
  maxProperties: z.number().int().min(1).nullable(),
  features: z.array(entitlementFeatureEnum),
  trialEndsAt: z.string().datetime().nullable(),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

/**
 * What a new organization starts with: a trial, on the plan whose feature
 * set it will fall back to once the trial ends without the relationship
 * having been decided otherwise. `starter` is the honest default — nobody
 * has been sold `professional` merely by signing up for a trial of it.
 */
export const DEFAULT_TRIAL_DAYS = 14;
export const DEFAULT_PLAN: EntitlementPlan = 'starter';

/**
 * What each plan grants, stated once so a plan's definition lives in one
 * place rather than being reconstructed at every call site. Matches
 * `docs/commercial-product-strategy.md`'s plan descriptions exactly —
 * changing what a plan includes means changing it here, not in prose that
 * can drift from what the code actually enforces.
 */
export const PLAN_FEATURES: Record<EntitlementPlan, readonly EntitlementFeature[]> = {
  starter: [],
  professional: [
    'portfolio_analytics',
    'assumption_import',
    'research_intelligence',
    'custom_templates',
  ],
  enterprise: [
    'portfolio_analytics',
    'assumption_import',
    'research_intelligence',
    'custom_templates',
    'advanced_audit_history',
    'api_access',
    'sso',
  ],
  // Internal organizations (demos, development, this platform's own team)
  // are not sold a plan and are not limited by one — `canUseFeature` grants
  // everything to `internal` status regardless of this list.
  internal: [],
};

// `excel_live_model_export` is deliberately on every plan, `starter`
// included: docs/commercial-product-strategy.md lists it as core to the
// flagship acquisition-underwriting workflow, not an upsell.
const UNIVERSAL_FEATURES: readonly EntitlementFeature[] = ['excel_live_model_export'];

/**
 * Whether an organization's entitlements grant a named feature.
 *
 * `trial` and `internal` grant everything: a prospect experiences the whole
 * product during a trial, and this platform's own internal organizations
 * have no reason to be limited by a plan nobody sold them. `suspended` and
 * `cancelled` grant nothing gated by this function — see
 * `isAccessSuspended` for what that means for writes generally, which is a
 * separate, broader question this function does not answer. `active` and
 * `past_due` are gated by the plan's own feature list — a lapsed payment is
 * a grace period, not an immediate lockout, so it is treated the same as
 * `active` here.
 */
export function canUseFeature(entitlements: Entitlements, feature: EntitlementFeature): boolean {
  if (UNIVERSAL_FEATURES.includes(feature)) return true;
  if (entitlements.status === 'trial' || entitlements.status === 'internal') return true;
  if (entitlements.status === 'suspended' || entitlements.status === 'cancelled') return false;
  return entitlements.features.includes(feature);
}

/**
 * Whether an organization's writes should be refused generally, independent
 * of any one named feature. A suspended or cancelled relationship keeps its
 * data readable and exportable — see `docs/commercial-gap-analysis.md`
 * Milestone 15 — and only state-changing requests are affected.
 */
export function isAccessSuspended(entitlements: Entitlements): boolean {
  return entitlements.status === 'suspended' || entitlements.status === 'cancelled';
}
