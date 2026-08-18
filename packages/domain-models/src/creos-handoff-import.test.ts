import { describe, expect, it } from 'vitest';
import { generateCreosUlid } from './creos-ids.js';
import {
  parseCreosHandoffPayload,
  translateSiteIntelHandoff,
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

describe('translateSiteIntelHandoff', () => {
  const parsed = parseCreosHandoffPayload(JSON.stringify(fixtureHandoff()));
  if (!parsed.ok) throw new Error('fixture must parse');
  const translated = translateSiteIntelHandoff(parsed.data);

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
    const again = translateSiteIntelHandoff(parsed.data);
    expect(again.assumptions.map((a) => [a.target, a.value])).toEqual(
      translated.assumptions.map((a) => [a.target, a.value]),
    );
  });
});

describe('translateSiteIntelHandoff — property with no name and no state observation', () => {
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
    const translated = translateSiteIntelHandoff(parsed.data);
    expect(translated.property.state).toBeNull();
    expect(translated.assumptions).toEqual([]);
  });
});
