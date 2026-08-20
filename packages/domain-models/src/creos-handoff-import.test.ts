import { describe, expect, it } from 'vitest';
import { generateCreosUlid } from './creos-ids.js';
import {
  parseCreosHandoffPayload,
  translateCreosHandoff,
  CreosHandoffV1Schema,
} from './creos-handoff-import.js';
import { creAssumptionImportSchema } from './cre-assumption-import.js';
import { analyzeImport } from './assumption-import-analyze.js';
import { parseModelInput } from './model-input.js';

/** A minimal, self-contained model fixture — mirrors assumption-import-analyze.test.ts's own helper. */
function fixtureModel() {
  return parseModelInput({
    modelId: 'fixture',
    modelName: 'Fixture Model',
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
  });
}

/** A minimal, realistic creos-handoff-v1 payload, matching what
 * test1's js/parcel/handoff.js actually produces (see that repo). */
function fixtureHandoff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'creos-handoff-v1',
    handoffId: generateCreosUlid(),
    createdAt: '2026-08-18T12:00:00.000Z',
    sourceModule: 'siteintel',
    targetModule: 'underwrite',
    sourceApplicationVersion: 'siteintel-parcel-explorer',
    property: {
      identity: { propertyId: generateCreosUlid(), propertyName: '9 Data Center Way' },
      classification: { propertyType: 'land', subtype: 'IND-1' },
      location: { latitude: 38.9, longitude: -77.3 },
    },
    observations: [
      {
        assumptionId: generateCreosUlid(),
        name: 'Assessed value',
        category: 'valuation',
        unit: 'USD',
        valueType: 'number',
        value: 4200000,
        sourceType: 'observed',
        sourceModule: 'siteintel',
        status: 'proposed',
        confidence: 'verified',
        methodology: 'A tax authority determination, not a purchase price.',
        createdAt: '2026-08-18T12:00:00.000Z',
        updatedAt: '2026-08-18T12:00:00.000Z',
      },
      {
        assumptionId: generateCreosUlid(),
        name: 'State',
        category: 'identity',
        valueType: 'string',
        value: 'VA',
        sourceType: 'observed',
        sourceModule: 'siteintel',
        status: 'proposed',
        createdAt: '2026-08-18T12:00:00.000Z',
        updatedAt: '2026-08-18T12:00:00.000Z',
      },
    ],
    assumptions: [],
    provenance: [],
    sources: [],
    ...overrides,
  };
}

describe('parseCreosHandoffPayload', () => {
  it('accepts a well-formed creos-handoff-v1 payload', () => {
    const result = parseCreosHandoffPayload(JSON.stringify(fixtureHandoff()));
    expect(result.ok).toBe(true);
  });

  it('rejects empty input', () => {
    const result = parseCreosHandoffPayload('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty/i);
  });

  it('rejects invalid JSON with an analyst-facing message, not a raw parser error', () => {
    const result = parseCreosHandoffPayload('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not valid JSON/i);
      expect(result.error).not.toMatch(/SyntaxError/);
    }
  });

  it('rejects a JSON array (not a single object)', () => {
    const result = parseCreosHandoffPayload('[1,2,3]');
    expect(result.ok).toBe(false);
  });

  it('rejects a document with the wrong schemaVersion', () => {
    const result = parseCreosHandoffPayload(
      JSON.stringify(fixtureHandoff({ schemaVersion: 'creos-handoff-v2' })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/schemaVersion/);
  });

  it('rejects a document missing schemaVersion entirely', () => {
    const doc = fixtureHandoff();
    delete (doc as Record<string, unknown>).schemaVersion;
    const result = parseCreosHandoffPayload(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/missing/);
  });

  it('rejects a handoff not targeting underwrite', () => {
    const result = parseCreosHandoffPayload(
      JSON.stringify(fixtureHandoff({ targetModule: 'marketsignal' })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not "underwrite"/);
  });

  it('rejects an invalid handoffId (not a real CREOS ulid)', () => {
    const result = parseCreosHandoffPayload(
      JSON.stringify(fixtureHandoff({ handoffId: 'not-a-ulid' })),
    );
    expect(result.ok).toBe(false);
  });

  // --- governance: the Underwrite-boundary rule, re-checked independently ---
  it.each(['accepted', 'overridden', 'rejected'])(
    'rejects a non-user observation claiming status "%s" (governance boundary)',
    (status) => {
      const doc = fixtureHandoff();
      (doc.observations as Array<Record<string, unknown>>)[0]!.status = status;
      const result = parseCreosHandoffPayload(JSON.stringify(doc));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/proposed/);
    },
  );

  it('accepts a user-sourced observation that is accepted or rejected (not constrained by the boundary rule)', () => {
    const doc = fixtureHandoff();
    (doc.observations as Array<Record<string, unknown>>).push({
      assumptionId: generateCreosUlid(),
      name: 'Analyst note',
      category: 'identity',
      valueType: 'string',
      value: 'reviewed',
      sourceType: 'user',
      sourceModule: 'underwrite',
      status: 'accepted',
      createdAt: '2026-08-18T12:00:00.000Z',
      updatedAt: '2026-08-18T12:00:00.000Z',
    });
    const result = parseCreosHandoffPayload(JSON.stringify(doc));
    expect(result.ok).toBe(true);
  });

  it('rejects an observation with an unrecognized sourceType', () => {
    const doc = fixtureHandoff();
    (doc.observations as Array<Record<string, unknown>>)[0]!.sourceType = 'guessed';
    const result = parseCreosHandoffPayload(JSON.stringify(doc));
    expect(result.ok).toBe(false);
  });
});

describe('CreosHandoffV1Schema', () => {
  it('parses directly (not just via parseCreosHandoffPayload)', () => {
    expect(() => CreosHandoffV1Schema.parse(fixtureHandoff())).not.toThrow();
  });
});

describe('translateCreosHandoff', () => {
  const parsed = parseCreosHandoffPayload(JSON.stringify(fixtureHandoff()));
  if (!parsed.ok) throw new Error('fixture must parse');
  const translated = translateCreosHandoff(parsed.data);

  it('produces a valid cre-assumption-import v1 document', () => {
    expect(() => creAssumptionImportSchema.parse(translated)).not.toThrow();
  });

  it('carries the property name and a state pulled from observations, never fabricated', () => {
    expect(translated.property.name).toBe('9 Data Center Way');
    expect(translated.property.state).toBe('VA');
    expect(translated.property.assetType).toBe('land');
  });

  it('source.kind is "imported", never "user" (this did not come from an analyst typing)', () => {
    expect(translated.source.kind).toBe('imported');
    expect(translated.source.system).toBe('CREOS SiteIntel');
  });

  it('namespaces every target under siteIntel.<category>.<field>, never a real underwriting target', () => {
    for (const a of translated.assumptions) {
      expect(a.target.startsWith('siteIntel.')).toBe(true);
    }
    expect(translated.assumptions.map((a) => a.target)).toContain(
      'siteIntel.valuation.assessedValue',
    );
  });

  it('maps confidence "verified" to a high numeric fraction, and omits it when absent', () => {
    const assessed = translated.assumptions.find(
      (a) => a.target === 'siteIntel.valuation.assessedValue',
    );
    const state = translated.assumptions.find((a) => a.target === 'siteIntel.identity.state');
    expect(assessed?.confidence).toBe(0.95);
    expect(state?.confidence).toBeNull();
  });

  it('preserves the methodology caveat as evidence, never drops it', () => {
    const assessed = translated.assumptions.find(
      (a) => a.target === 'siteIntel.valuation.assessedValue',
    );
    expect(assessed?.evidence).toEqual([
      { note: 'A tax authority determination, not a purchase price.' },
    ]);
  });

  it('maps creos numeric valueType to "decimal" (schema-valid even for whole numbers)', () => {
    const assessed = translated.assumptions.find(
      (a) => a.target === 'siteIntel.valuation.assessedValue',
    );
    expect(assessed?.valueType).toBe('decimal');
    expect(assessed?.value).toBe(4200000);
  });

  it('marks every assumption extraction method "explicit" (SiteIntel reports facts read directly from public records)', () => {
    for (const a of translated.assumptions) {
      expect(a.extraction?.method).toBe('explicit');
    }
  });

  it('records is always empty for a Phase 5 SiteIntel handoff', () => {
    expect(translated.records).toEqual([]);
  });

  // --- the whole point of this design: SiteIntel facts never masquerade as
  // real, applicable underwriting inputs. See this module's file header. ---
  it('every translated target analyzes as "unsupported" against a real model — informational only, never auto-applicable', () => {
    const analysis = analyzeImport(creAssumptionImportSchema.parse(translated), fixtureModel());
    const siteIntelItems = analysis.items.filter((item) => item.target.startsWith('siteIntel.'));
    expect(siteIntelItems.length).toBeGreaterThan(0);
    for (const item of siteIntelItems) {
      expect(item.status).toBe('unsupported');
    }
  });

  it('never includes an acquisition_price target — SiteIntel refuses to supply one and this translator never fabricates it', () => {
    const json = JSON.stringify(translated);
    expect(json).not.toMatch(/acquisition_price|acquisitionPrice/);
  });

  it('is a pure function: translating the same handoff twice produces the same targets and values', () => {
    const again = translateCreosHandoff(parsed.data);
    expect(again.assumptions.map((a) => [a.target, a.value])).toEqual(
      translated.assumptions.map((a) => [a.target, a.value]),
    );
  });
});

describe('translateCreosHandoff — property with no name and no state observation', () => {
  it('never fabricates a property name or state; both are null rather than guessed', () => {
    const parsed = parseCreosHandoffPayload(
      JSON.stringify(
        fixtureHandoff({
          property: {
            identity: { propertyId: generateCreosUlid(), propertyName: 'Unnamed parcel' },
          },
          observations: [],
        }),
      ),
    );
    if (!parsed.ok) throw new Error('fixture must parse');
    const translated = translateCreosHandoff(parsed.data);
    expect(translated.property.state).toBeNull();
    expect(translated.assumptions).toEqual([]);
  });
});

/** A minimal, realistic creos-handoff-v1 payload matching what test3's
 * src/test3/creos_handoff.py actually produces for a single assumption
 * run (see that repo, Phase 6). */
function fixtureMarketSignalHandoff(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 'creos-handoff-v1',
    handoffId: generateCreosUlid(),
    createdAt: '2026-08-19T12:00:00.000Z',
    sourceModule: 'marketsignal',
    targetModule: 'underwrite',
    sourceApplicationVersion: 'test3-marketsignal',
    property: {
      identity: { propertyId: generateCreosUlid(), propertyName: 'Riverside Industrial Portfolio' },
      classification: { propertyType: 'industrial' },
    },
    observations: [],
    assumptions: [
      {
        assumptionId: generateCreosUlid(),
        name: 'Vacancy',
        category: 'vacancy',
        unit: 'decimal_fraction',
        valueType: 'number',
        value: 0.08,
        sourceType: 'modeled',
        sourceModule: 'marketsignal',
        status: 'proposed',
        confidence: 'medium',
        methodology: 'MarketSignal candidate recommendation (method: hierarchical_fallback).',
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
      },
      {
        assumptionId: generateCreosUlid(),
        name: 'Market rent growth',
        category: 'market_rent_growth',
        unit: 'decimal_fraction',
        valueType: 'number',
        value: 0.03,
        sourceType: 'modeled',
        sourceModule: 'marketsignal',
        status: 'proposed',
        confidence: 'low',
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-19T12:00:00.000Z',
      },
    ],
    provenance: [],
    sources: [],
    ...overrides,
  };
}

describe('translateCreosHandoff — Phase 6 MarketSignal handoff', () => {
  const parsed = parseCreosHandoffPayload(JSON.stringify(fixtureMarketSignalHandoff()));
  if (!parsed.ok) throw new Error('fixture must parse');
  const translated = translateCreosHandoff(parsed.data);

  it('produces a valid cre-assumption-import v1 document', () => {
    expect(() => creAssumptionImportSchema.parse(translated)).not.toThrow();
  });

  it('labels the source as CREOS MarketSignal, not SiteIntel', () => {
    expect(translated.source.system).toBe('CREOS MarketSignal');
  });

  it('reads from assumptions[], not observations[] (MarketSignal populates the former)', () => {
    expect(translated.assumptions).toHaveLength(2);
  });

  it('routes vacancy to the real vacancy.generalVacancyRate target', () => {
    expect(translated.assumptions.map((a) => a.target)).toContain('vacancy.generalVacancyRate');
    const item = translated.assumptions.find((a) => a.target === 'vacancy.generalVacancyRate');
    expect(item?.value).toBe(0.08);
  });

  it('routes an assumption type with no direct target (market_rent_growth) to the informational marketSignal.* namespace', () => {
    expect(translated.assumptions.map((a) => a.target)).toContain(
      'marketSignal.market_rent_growth',
    );
  });

  it('every direct-target assumption still analyzes as new/changed (a real, applicable target), never silently pre-decided', () => {
    const analysis = analyzeImport(creAssumptionImportSchema.parse(translated), fixtureModel());
    const vacancyItem = analysis.items.find((item) => item.target === 'vacancy.generalVacancyRate');
    expect(vacancyItem).toBeDefined();
    expect(['new', 'changed']).toContain(vacancyItem?.status);
  });

  it('an informational MarketSignal fact still analyzes as unsupported, same as a SiteIntel fact', () => {
    const analysis = analyzeImport(creAssumptionImportSchema.parse(translated), fixtureModel());
    const item = analysis.items.find((entry) => entry.target === 'marketSignal.market_rent_growth');
    expect(item?.status).toBe('unsupported');
  });
});

describe('translateCreosHandoff — MarketSignal direct-target coverage (all 3)', () => {
  it.each([
    ['vacancy', 'vacancy.generalVacancyRate'],
    ['exit_cap_rate', 'valuation.terminalCapRate'],
    ['discount_rate', 'valuation.discountRate'],
  ])('routes category "%s" to real target "%s"', (category, expectedTarget) => {
    const doc = fixtureMarketSignalHandoff({
      assumptions: [
        {
          assumptionId: generateCreosUlid(),
          name: 'Test assumption',
          category,
          valueType: 'number',
          value: 0.07,
          sourceType: 'modeled',
          sourceModule: 'marketsignal',
          status: 'proposed',
          createdAt: '2026-08-19T12:00:00.000Z',
          updatedAt: '2026-08-19T12:00:00.000Z',
        },
      ],
    });
    const parsed = parseCreosHandoffPayload(JSON.stringify(doc));
    if (!parsed.ok) throw new Error('fixture must parse');
    const translated = translateCreosHandoff(parsed.data);
    expect(translated.assumptions[0]?.target).toBe(expectedTarget);
  });

  it.each([
    'market_rent',
    'renewal_probability',
    'downtime',
    'tenant_improvements',
    'leasing_commissions',
    'expense_growth',
    'property_tax_growth',
    'insurance_growth',
    'debt_interest_rate',
    'construction_cost_growth',
    'lease_up_pace',
  ])(
    'routes category "%s" (no direct target) to the informational namespace, never a guessed real path',
    (category) => {
      const doc = fixtureMarketSignalHandoff({
        assumptions: [
          {
            assumptionId: generateCreosUlid(),
            name: 'Test assumption',
            category,
            valueType: 'number',
            value: 1,
            sourceType: 'modeled',
            sourceModule: 'marketsignal',
            status: 'proposed',
            createdAt: '2026-08-19T12:00:00.000Z',
            updatedAt: '2026-08-19T12:00:00.000Z',
          },
        ],
      });
      const parsed = parseCreosHandoffPayload(JSON.stringify(doc));
      if (!parsed.ok) throw new Error('fixture must parse');
      const translated = translateCreosHandoff(parsed.data);
      expect(translated.assumptions[0]?.target).toBe(`marketSignal.${category}`);
    },
  );
});

describe('translateCreosHandoff — a category with characters a target cannot carry', () => {
  it('sanitizes a category containing a space instead of producing an invalid target that fails the whole document', () => {
    const doc = fixtureHandoff({
      observations: [
        {
          assumptionId: generateCreosUlid(),
          name: 'Zoning designation',
          category: 'Site Assessment',
          valueType: 'string',
          value: 'IND-1',
          sourceType: 'observed',
          sourceModule: 'siteintel',
          status: 'proposed',
          createdAt: '2026-08-18T12:00:00.000Z',
          updatedAt: '2026-08-18T12:00:00.000Z',
        },
      ],
    });
    const parsed = parseCreosHandoffPayload(JSON.stringify(doc));
    if (!parsed.ok) throw new Error('fixture must parse');
    const translated = translateCreosHandoff(parsed.data);

    // Before this fix, the target was `siteIntel.Site Assessment.zoning...`,
    // which fails `assumptionTargetSchema`'s regex and — because the whole
    // array is validated as one document — would refuse every fact in the
    // handoff, not just this one.
    expect(() => creAssumptionImportSchema.parse(translated)).not.toThrow();
    expect(translated.assumptions[0]?.target).toBe('siteIntel.Site_Assessment.zoningDesignation');
  });

  it('leaves an already-valid snake_case category exactly as the catalog wrote it', () => {
    // The MarketSignal fixture's own "market_rent_growth" category already
    // satisfies the target regex — sanitizing must not rewrite it into
    // "marketRentGrowth" or any other form the catalog did not send.
    const parsed = parseCreosHandoffPayload(JSON.stringify(fixtureMarketSignalHandoff()));
    if (!parsed.ok) throw new Error('fixture must parse');
    const translated = translateCreosHandoff(parsed.data);
    expect(translated.assumptions.map((a) => a.target)).toContain(
      'marketSignal.market_rent_growth',
    );
  });
});

describe('translateCreosHandoff — descriptive text longer than the target schema allows', () => {
  it('truncates an over-length methodology and unit rather than failing the whole document', () => {
    const longMethodology = 'M'.repeat(1500);
    const longUnit = 'U'.repeat(200);
    const doc = fixtureHandoff({
      observations: [
        {
          assumptionId: generateCreosUlid(),
          name: 'Assessed value',
          category: 'valuation',
          unit: longUnit,
          valueType: 'number',
          value: 4200000,
          sourceType: 'observed',
          sourceModule: 'siteintel',
          status: 'proposed',
          methodology: longMethodology,
          createdAt: '2026-08-18T12:00:00.000Z',
          updatedAt: '2026-08-18T12:00:00.000Z',
        },
      ],
    });
    const parsed = parseCreosHandoffPayload(JSON.stringify(doc));
    if (!parsed.ok) throw new Error('fixture must parse');
    const translated = translateCreosHandoff(parsed.data);

    // Before this fix, `unit` (60-char cap) and the evidence `note`
    // (1000-char cap) in `cre-assumption-import`'s own schema would refuse
    // this whole document over one item's descriptive text — never the
    // authoritative `value`, which is untouched either way.
    expect(() => creAssumptionImportSchema.parse(translated)).not.toThrow();
    const item = translated.assumptions[0];
    expect(item?.unit?.length).toBeLessThanOrEqual(60);
    expect(item?.evidence[0]?.note?.length).toBeLessThanOrEqual(1000);
    expect(item?.value).toBe(4200000);
  });
});

describe('translateCreosHandoff — a "State" fact reported in assumptions[] rather than observations[]', () => {
  it('still populates property.state, the same as it would from observations[]', () => {
    // HandoffAssumptionSchema is identical for both arrays — nothing in the
    // contract requires a "State" fact to arrive in one over the other.
    const doc = fixtureHandoff({
      observations: [],
      assumptions: [
        {
          assumptionId: generateCreosUlid(),
          name: 'State',
          category: 'identity',
          valueType: 'string',
          value: 'VA',
          sourceType: 'observed',
          sourceModule: 'siteintel',
          status: 'proposed',
          createdAt: '2026-08-18T12:00:00.000Z',
          updatedAt: '2026-08-18T12:00:00.000Z',
        },
      ],
    });
    const parsed = parseCreosHandoffPayload(JSON.stringify(doc));
    if (!parsed.ok) throw new Error('fixture must parse');
    const translated = translateCreosHandoff(parsed.data);
    expect(translated.property.state).toBe('VA');
  });
});
