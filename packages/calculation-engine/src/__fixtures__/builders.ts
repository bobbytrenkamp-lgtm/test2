import { type ModelInput, type ModelInputDraft, parseModelInput } from '@cre/domain-models';

/**
 * Fixture helpers.
 *
 * Every regression fixture is a fictional property. Expected results are
 * derived independently of the engine — either stated as closed-form
 * arithmetic in the test file or recomputed there by a different method — so
 * that the tests cannot pass merely because the engine agrees with itself.
 */
export function buildModel(draft: ModelInputDraft): ModelInput {
  return parseModelInput(draft);
}

/**
 * Re-parses an already-valid model with overrides applied. Parsed output is
 * itself valid input, so this is a safe way to derive a focused fixture from a
 * fuller one without restating every field.
 */
export function extendModel(base: ModelInput, overrides: Partial<ModelInputDraft>): ModelInput {
  return parseModelInput({ ...(base as unknown as ModelInputDraft), ...overrides });
}

/** A minimal but valid model, used as the base for focused fixtures. */
export function baseModel(overrides: Partial<ModelInputDraft> = {}): ModelInput {
  return buildModel({
    modelId: 'fixture',
    modelName: 'Fixture model',
    currency: 'USD',
    areaUnit: 'sqft',
    forecast: {
      startDate: '2026-01-01',
      months: 12,
      fiscalYearStartMonth: 1,
      proration: 'actual_days',
    },
    property: {
      id: 'P1',
      name: 'Fixture Property',
      propertyType: 'office',
      rentableArea: '100000',
      unitCount: 0,
      ownershipPercent: '1',
    },
    valuation: {
      discountRate: '0.08',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
    },
    ...overrides,
  });
}
