import { describe, expect, it } from 'vitest';
import { analyzeImport } from './assumption-import-analyze.js';
import { creAssumptionImportSchema, type CreAssumptionImportInput } from './cre-assumption-import.js';
import { type ModelInput, type ModelInputDraft, parseModelInput } from './model-input.js';

/**
 * The deterministic analyzer.
 *
 * These tests build a small, self-contained model — not the calculation
 * engine's own fixtures, since this package sits below that one — and check
 * that `analyzeImport` classifies every case the import contract's own tests
 * (`cre-assumption-import.test.ts`) established as legal input: new values,
 * changed values, agreement, duplicates, conflicts, missing collection
 * records, unsupported targets, and type mismatches the schema layer alone
 * cannot see (because it only checks a value's own declared shape, never
 * whether that shape is the one the target actually needs).
 */

function model(overrides: Partial<ModelInputDraft> = {}): ModelInput {
  return parseModelInput({
    modelId: 'fixture',
    modelName: 'Raleigh Industrial Center',
    currency: 'USD',
    areaUnit: 'sqft',
    forecast: { startDate: '2026-01-01', months: 12, fiscalYearStartMonth: 1, proration: 'actual_days' },
    property: {
      id: 'P1',
      name: 'Raleigh Industrial Center',
      propertyType: 'industrial',
      rentableArea: '250000',
      unitCount: 0,
      ownershipPercent: '1',
    },
    valuation: {
      discountRate: '0.08',
      terminalCapRate: '0.065',
      saleCostPercent: '0',
      directCapAdjustments: '0',
      acquisitionCosts: '0',
    },
    vacancy: { generalVacancyRate: '0.05' },
    marketLeasingProfiles: [
      {
        id: 'INDUSTRIAL_STD',
        name: 'Industrial Standard',
        marketRent: '11.00',
        marketRentBasis: 'per_area_per_year',
      },
    ],
    expenses: [{ id: 'OPEX-INS', name: 'Insurance', category: 'insurance', method: 'fixed_annual', amount: '140000' }],
    ...overrides,
  });
}

function doc(overrides: Partial<CreAssumptionImportInput> = {}) {
  return creAssumptionImportSchema.parse({
    format: 'cre-assumption-import',
    version: 1,
    source: { kind: 'imported', system: 'Claude Skill', documentName: 'Raleigh Industrial OM.pdf' },
    ...overrides,
  });
}

describe('analyzeImport: model-level assumptions', () => {
  it('classifies a target with no current value as new', () => {
    const analysis = analyzeImport(
      doc({
        assumptions: [
          { target: 'valuation.acquisitionPrice', value: '48500000', valueType: 'decimal' },
        ],
      }),
      model(),
    );
    expect(analysis.items).toHaveLength(1);
    expect(analysis.items[0]).toMatchObject({
      status: 'new',
      currentValue: null,
      extractedValue: '48500000',
    });
  });

  it('classifies a target whose value differs from the model as changed', () => {
    const analysis = analyzeImport(
      doc({
        assumptions: [{ target: 'valuation.terminalCapRate', value: '0.0625', valueType: 'decimal' }],
      }),
      model(),
    );
    expect(analysis.items[0]).toMatchObject({ status: 'changed', currentValue: '0.065', extractedValue: '0.0625' });
  });

  it('classifies a target whose value matches the model as same, not a failure', () => {
    const analysis = analyzeImport(
      doc({
        assumptions: [{ target: 'valuation.terminalCapRate', value: '0.065', valueType: 'decimal' }],
      }),
      model(),
    );
    expect(analysis.items[0]?.status).toBe('same');
    expect(analysis.summary.same).toBe(1);
  });

  it('refuses to guess a rate left as a whole number', () => {
    // "6.25" for terminalCapRate is a syntactically valid decimal, but nobody
    // underwrites a 625% exit cap rate — flagged for review rather than
    // silently applied.
    const analysis = analyzeImport(
      doc({ assumptions: [{ target: 'valuation.terminalCapRate', value: '6.25', valueType: 'decimal' }] }),
      model(),
    );
    expect(analysis.items[0]?.status).toBe('needsReview');
    expect(analysis.items[0]?.reason).toContain('unusually large');
  });

  it('marks an inferred value as needing review even when it would otherwise be new', () => {
    const analysis = analyzeImport(
      doc({
        assumptions: [
          {
            target: 'valuation.acquisitionPrice',
            value: '48500000',
            valueType: 'decimal',
            extraction: { method: 'inferred', derivation: 'Implied by the stated cap rate and NOI.' },
          },
        ],
      }),
      model(),
    );
    expect(analysis.items[0]?.status).toBe('needsReview');
    expect(analysis.items[0]?.reason).toContain('inferred');
  });

  it('does not flag an explicit value the same way, even if unusually large for its unit', () => {
    // Sanity check on the inferred-only branch above: explicit extraction of
    // an in-range rate is not review-flagged by the extraction-method check.
    const analysis = analyzeImport(
      doc({
        assumptions: [
          { target: 'valuation.terminalCapRate', value: '0.07', valueType: 'decimal', extraction: { method: 'explicit' } },
        ],
      }),
      model(),
    );
    expect(analysis.items[0]?.status).toBe('changed');
  });

  it('shows a value-only note as needing review, not as new or invalid', () => {
    const analysis = analyzeImport(
      doc({
        assumptions: [
          { target: 'valuation.discountRate', value: null, valueType: 'decimal', notes: 'Three competing developments in planning.' },
        ],
      }),
      model(),
    );
    expect(analysis.items[0]).toMatchObject({ status: 'needsReview', extractedValue: null });
    expect(analysis.items[0]?.notes).toContain('competing developments');
  });

  it('flags a target this release does not model as unsupported, never dropping it', () => {
    const analysis = analyzeImport(
      doc({ assumptions: [{ target: 'tenant_credit_score', value: '82', valueType: 'integer' }] }),
      model(),
    );
    expect(analysis.items[0]?.status).toBe('unsupported');
    expect(analysis.summary.unsupported).toBe(1);
    expect(analysis.summary.recognized).toBe(0);
  });

  it('flags lease terms as unsupported through the generic importer, by name', () => {
    const analysis = analyzeImport(
      doc({ assumptions: [{ target: 'leases.L-001.baseRent', value: '38.00', valueType: 'decimal' }] }),
      model(),
    );
    expect(analysis.items[0]?.status).toBe('unsupported');
    expect(analysis.items[0]?.reason).toContain('rent roll');
  });

  it('treats a zero-padded stored decimal as the same value, not a change', () => {
    // A real Postgres numeric column returns a fixed-scale string —
    // "0.065" stored comes back "0.06500000" — and a naive string
    // comparison would report every untouched rate as changed.
    const analysis = analyzeImport(
      doc({ assumptions: [{ target: 'valuation.terminalCapRate', value: '0.065', valueType: 'decimal' }] }),
      model({ valuation: { discountRate: '0.08', terminalCapRate: '0.06500000', saleCostPercent: '0', directCapAdjustments: '0', acquisitionCosts: '0' } }),
    );
    expect(analysis.items[0]?.status).toBe('same');
  });

  it('flags a declared type that does not match the real target type as invalid', () => {
    // saleMonth is an integer on the real target; a decimal declaration for it
    // is a mismatch even though "60" alone would satisfy either shape.
    const analysis = analyzeImport(
      doc({ assumptions: [{ target: 'valuation.saleMonth', value: '60', valueType: 'decimal' }] }),
      model(),
    );
    expect(analysis.items[0]?.status).toBe('invalid');
    expect(analysis.items[0]?.reason).toContain('integer');
  });
});

describe('analyzeImport: duplicates and conflicts', () => {
  it('merges the same value reported on two pages into one item with combined evidence', () => {
    const analysis = analyzeImport(
      doc({
        assumptions: [
          {
            target: 'valuation.terminalCapRate',
            value: '0.0625',
            valueType: 'decimal',
            evidence: [{ page: 8, label: 'Summary' }],
          },
          {
            target: 'valuation.terminalCapRate',
            value: '0.0625',
            valueType: 'decimal',
            evidence: [{ page: 42, label: 'Investment Summary' }],
          },
        ],
      }),
      model(),
    );
    expect(analysis.items).toHaveLength(1);
    expect(analysis.items[0]?.status).toBe('changed');
    expect(analysis.items[0]?.evidence.map((e) => e.page)).toEqual([8, 42]);
  });

  it('shows a conflict, rather than choosing between two different values for the same target', () => {
    const analysis = analyzeImport(
      doc({
        assumptions: [
          { target: 'valuation.terminalCapRate', value: '0.0625', valueType: 'decimal', evidence: [{ page: 8 }] },
          { target: 'valuation.terminalCapRate', value: '0.06', valueType: 'decimal', evidence: [{ page: 42 }] },
        ],
      }),
      model(),
    );
    expect(analysis.items).toHaveLength(1);
    expect(analysis.items[0]?.status).toBe('conflict');
    expect(analysis.items[0]?.extractedValue).toBeNull();
    expect(analysis.items[0]?.conflictingValues).toHaveLength(2);
    expect(analysis.summary.conflicts).toBe(1);
  });
});

describe('analyzeImport: record bundles', () => {
  it('flattens a bundle for an existing record into per-field changes, each with its own evidence', () => {
    const analysis = analyzeImport(
      doc({
        records: [
          {
            collection: 'marketLeasing',
            code: 'INDUSTRIAL_STD',
            name: 'Industrial Standard',
            fields: { marketRent: '12.50', renewalProbability: '0.70' },
            evidence: { marketRent: [{ page: 28, sourceValue: '$12.50/SF' }] },
          },
        ],
      }),
      model(),
    );
    expect(analysis.items).toHaveLength(2);
    const rent = analysis.items.find((i) => i.target === 'marketLeasing.INDUSTRIAL_STD.marketRent');
    expect(rent).toMatchObject({ status: 'changed', currentValue: '11.00', extractedValue: '12.50' });
    expect(rent?.evidence).toHaveLength(1);
    const renewal = analysis.items.find((i) => i.target === 'marketLeasing.INDUSTRIAL_STD.renewalProbability');
    expect(renewal?.evidence).toEqual([]);
  });

  it('reports a bundle for a code that does not exist as a missing collection record, not a silent create', () => {
    const analysis = analyzeImport(
      doc({
        records: [
          {
            collection: 'marketLeasing',
            code: 'RETAIL_SMALL_SHOP',
            fields: { marketRent: '24.00' },
            evidence: {},
          },
        ],
      }),
      model(),
    );
    expect(analysis.missingCollectionRecords).toHaveLength(1);
    expect(analysis.missingCollectionRecords[0]).toMatchObject({
      collection: 'marketLeasing',
      code: 'RETAIL_SMALL_SHOP',
    });
    expect(analysis.items[0]).toMatchObject({ status: 'missingTarget' });
    expect(analysis.summary.missingTarget).toBe(1);
  });

  it('marks every field of a bundle for an unrecognized collection as unsupported', () => {
    const analysis = analyzeImport(
      doc({
        records: [{ collection: 'dataCentre', code: 'HALL-1', fields: { powerCostPerKw: '0.11' }, evidence: {} }],
      }),
      model(),
    );
    expect(analysis.items[0]?.status).toBe('unsupported');
    expect(analysis.missingCollectionRecords).toHaveLength(0);
  });
});

describe('analyzeImport: property mismatch', () => {
  it('warns, but does not block, when the document names a different property', () => {
    const analysis = analyzeImport(
      doc({ property: { name: 'A Completely Different Warehouse' } }),
      model(),
    );
    expect(analysis.propertyMismatch).toBe(true);
  });

  it('does not warn when the document names the same property this model is open on', () => {
    const analysis = analyzeImport(doc({ property: { name: 'Raleigh Industrial Center' } }), model());
    expect(analysis.propertyMismatch).toBe(false);
  });

  it('does not warn when the document states no property at all', () => {
    const analysis = analyzeImport(doc(), model());
    expect(analysis.propertyMismatch).toBe(false);
  });
});

describe('analyzeImport: zero writes', () => {
  it('is safe to call repeatedly and returns the same result each time', () => {
    const input = doc({
      assumptions: [{ target: 'valuation.terminalCapRate', value: '0.0625', valueType: 'decimal' }],
    });
    const m = model();
    const first = analyzeImport(input, m);
    const second = analyzeImport(input, m);
    expect(second).toEqual(first);
  });
});
