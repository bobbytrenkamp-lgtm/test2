import { describe, expect, it } from 'vitest';
import {
  canUseFeature,
  ENTITLEMENT_FEATURES,
  isAccessSuspended,
  PLAN_FEATURES,
  type Entitlements,
  type EntitlementPlan,
} from './entitlements.js';

/**
 * `canUseFeature`/`isAccessSuspended` are the one place a route or the web
 * client is meant to ask "can this organization do X" — see the doc comment
 * at the top of `entitlements.ts`. These tests are pure and need no
 * database; the integration surface (the entitlements row actually being
 * created, read, and updated) is covered in `tests/entitlements.test.ts`.
 */

function entitlements(overrides: Partial<Entitlements> = {}): Entitlements {
  return {
    organizationId: '00000000-0000-0000-0000-000000000000',
    plan: 'starter',
    status: 'active',
    maxUsers: null,
    maxProperties: null,
    features: [],
    trialEndsAt: null,
    ...overrides,
  };
}

describe('canUseFeature', () => {
  it('grants a universal feature regardless of plan or status', () => {
    expect(
      canUseFeature(
        entitlements({ plan: 'starter', status: 'suspended' }),
        'excel_live_model_export',
      ),
    ).toBe(true);
  });

  it('grants everything to a trial organization, regardless of its fallback plan', () => {
    const trial = entitlements({ plan: 'starter', status: 'trial', features: [] });
    for (const feature of ENTITLEMENT_FEATURES) {
      expect(canUseFeature(trial, feature)).toBe(true);
    }
  });

  it('grants everything to an internal organization', () => {
    const internal = entitlements({ plan: 'internal', status: 'internal', features: [] });
    for (const feature of ENTITLEMENT_FEATURES) {
      expect(canUseFeature(internal, feature)).toBe(true);
    }
  });

  it('denies a non-universal feature to a suspended organization', () => {
    const suspended = entitlements({
      plan: 'enterprise',
      status: 'suspended',
      features: [...PLAN_FEATURES.enterprise],
    });
    expect(canUseFeature(suspended, 'assumption_import')).toBe(false);
  });

  it('denies a non-universal feature to a cancelled organization', () => {
    const cancelled = entitlements({
      plan: 'enterprise',
      status: 'cancelled',
      features: [...PLAN_FEATURES.enterprise],
    });
    expect(canUseFeature(cancelled, 'assumption_import')).toBe(false);
  });

  it('gates an active organization by its plan feature list', () => {
    const starter = entitlements({
      plan: 'starter',
      status: 'active',
      features: [...PLAN_FEATURES.starter],
    });
    expect(canUseFeature(starter, 'assumption_import')).toBe(false);

    const professional = entitlements({
      plan: 'professional',
      status: 'active',
      features: [...PLAN_FEATURES.professional],
    });
    expect(canUseFeature(professional, 'assumption_import')).toBe(true);
  });

  it('treats past_due the same as active: a grace period, not a lockout', () => {
    const pastDue = entitlements({
      plan: 'professional',
      status: 'past_due',
      features: [...PLAN_FEATURES.professional],
    });
    expect(canUseFeature(pastDue, 'assumption_import')).toBe(true);
    expect(canUseFeature(pastDue, 'sso')).toBe(false);
  });

  it.each(Object.keys(PLAN_FEATURES) as EntitlementPlan[])(
    'the %s plan grants exactly its documented feature list when active',
    (plan) => {
      const active = entitlements({ plan, status: 'active', features: [...PLAN_FEATURES[plan]] });
      for (const feature of ENTITLEMENT_FEATURES) {
        const expected =
          PLAN_FEATURES[plan].includes(feature) || feature === 'excel_live_model_export';
        expect(canUseFeature(active, feature)).toBe(expected);
      }
    },
  );
});

describe('isAccessSuspended', () => {
  it('is false for trial, active, past_due and internal', () => {
    for (const status of ['trial', 'active', 'past_due', 'internal'] as const) {
      expect(isAccessSuspended(entitlements({ status }))).toBe(false);
    }
  });

  it('is true for suspended and cancelled', () => {
    for (const status of ['suspended', 'cancelled'] as const) {
      expect(isAccessSuspended(entitlements({ status }))).toBe(true);
    }
  });
});
