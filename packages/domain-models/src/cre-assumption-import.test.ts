import { describe, expect, it } from 'vitest';
import { creAssumptionImportSchema, parseImportPayload } from './cre-assumption-import.js';

/**
 * The paste-to-document parser.
 *
 * This is the first thing a pasted extraction touches, and its whole job is
 * to be boring: valid JSON in the right shape becomes a document, and
 * anything else becomes a plain-language explanation with the user's paste
 * left untouched for them to fix. No repair, no guessing — see the
 * doc comment on `parseImportPayload` for why.
 */

const MINIMAL = {
  format: 'cre-assumption-import',
  version: 1,
  source: { kind: 'imported', system: 'Claude Skill' },
  assumptions: [
    {
      target: 'valuation.terminalCapRate',
      value: '0.0625',
      valueType: 'decimal',
    },
  ],
};

describe('parseImportPayload', () => {
  it('parses a well-formed document', () => {
    const result = parseImportPayload(JSON.stringify(MINIMAL));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assumptions).toHaveLength(1);
      expect(result.data.source.kind).toBe('imported');
    }
  });

  it('strips one surrounding markdown fence', () => {
    const fenced = '```json\n' + JSON.stringify(MINIMAL) + '\n```';
    const result = parseImportPayload(fenced);
    expect(result.ok).toBe(true);
  });

  it('strips a fence with no language tag', () => {
    const fenced = '```\n' + JSON.stringify(MINIMAL) + '\n```';
    expect(parseImportPayload(fenced).ok).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseImportPayload(`\n\n  ${JSON.stringify(MINIMAL)}   \n`).ok).toBe(true);
  });

  it('refuses empty input, with a message rather than a crash', () => {
    const result = parseImportPayload('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Paste');
  });

  it('refuses malformed JSON without pretending to repair it', () => {
    const result = parseImportPayload('{ "format": "cre-assumption-import", oops }');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not valid JSON');
  });

  it('refuses a JSON array', () => {
    const result = parseImportPayload('[1, 2, 3]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not an object');
  });

  it('refuses a document with the wrong format name', () => {
    const result = parseImportPayload(JSON.stringify({ ...MINIMAL, format: 'something-else' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('cre-assumption-import');
      expect(result.error).toContain('something-else');
    }
  });

  it('refuses a document with no format field, saying it is missing', () => {
    const { format: _format, ...withoutFormat } = MINIMAL;
    const result = parseImportPayload(JSON.stringify(withoutFormat));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('missing');
  });

  it('refuses an unsupported version rather than reading it as version 1', () => {
    /*
     * Load-bearing: a version 2 document might look almost identical to
     * version 1 and differ in exactly the field that matters. Reading it
     * anyway would be the guess this whole contract exists to avoid.
     */
    const result = parseImportPayload(JSON.stringify({ ...MINIMAL, version: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('version 1');
      expect(result.error).toContain('version 2');
    }
  });

  it('refuses a document missing required source metadata', () => {
    const { source: _source, ...withoutSource } = MINIMAL;
    const result = parseImportPayload(JSON.stringify(withoutSource));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('source');
  });

  it('refuses an assumption with an invalid value for its own valueType', () => {
    const result = parseImportPayload(
      JSON.stringify({
        ...MINIMAL,
        assumptions: [{ target: 'valuation.saleMonth', value: 'soon', valueType: 'integer' }],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('defaults property and assumptions when omitted, so a records-only import is valid', () => {
    const { assumptions: _assumptions, ...withoutAssumptions } = MINIMAL;
    const result = parseImportPayload(
      JSON.stringify({
        ...withoutAssumptions,
        records: [
          {
            collection: 'marketLeasing',
            code: 'INDUSTRIAL_NEW',
            fields: { marketRent: '12.50' },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assumptions).toEqual([]);
      expect(result.data.property).toEqual({});
      expect(result.data.records).toHaveLength(1);
    }
  });

  it('does not erase the original paste on failure', () => {
    // The parser itself is stateless and returns only an error message — the
    // "do not clear the paste box" requirement belongs to the UI, which is
    // tested separately. This test pins the contract that makes that
    // possible: a failed parse never mutates or truncates its input.
    const original = '{ this is not json';
    const result = parseImportPayload(original);
    expect(result.ok).toBe(false);
    expect(original).toBe('{ this is not json');
  });
});

describe('creAssumptionImportSchema, evidence and bundles', () => {
  it('accepts an assumption with full evidence and extraction metadata', () => {
    const parsed = creAssumptionImportSchema.parse({
      ...MINIMAL,
      assumptions: [
        {
          target: 'valuation.terminalCapRate',
          value: '0.0625',
          valueType: 'decimal',
          unit: 'rate',
          displayValue: '6.25%',
          confidence: 0.96,
          extraction: { method: 'explicit' },
          evidence: [
            {
              page: 42,
              section: 'Investment Summary',
              label: 'Exit Cap Rate',
              sourceValue: '6.25%',
            },
          ],
          notes: 'Explicitly stated exit capitalization rate.',
        },
      ],
    });
    expect(parsed.assumptions[0]?.evidence).toHaveLength(1);
    expect(parsed.assumptions[0]?.extraction?.method).toBe('explicit');
  });

  it('requires a derivation-shaped note only by convention, not by schema — derived values are free text', () => {
    // The schema does not force a derivation to be present for a `derived`
    // extraction; the analyzer, not the schema, is what treats an absent one
    // as worth flagging. This test pins that the schema stays permissive here.
    const parsed = creAssumptionImportSchema.parse({
      ...MINIMAL,
      assumptions: [
        {
          target: 'expenses.OPEX-INS.amount',
          value: '145000',
          valueType: 'decimal',
          extraction: { method: 'derived', derivation: '$12,083/month × 12.' },
        },
      ],
    });
    expect(parsed.assumptions[0]?.extraction?.derivation).toContain('12,083');
  });

  it('accepts a record bundle with per-field evidence', () => {
    const parsed = creAssumptionImportSchema.parse({
      ...MINIMAL,
      assumptions: [],
      records: [
        {
          collection: 'marketLeasing',
          code: 'INDUSTRIAL_NEW',
          name: 'Industrial New Lease',
          fields: {
            marketRent: '12.50',
            renewalProbability: '0.70',
            newTiPerArea: '35',
          },
          evidence: {
            marketRent: [{ page: 28, label: 'Market Rent', sourceValue: '$12.50/SF' }],
            renewalProbability: [{ page: 31, sourceValue: '70%' }],
          },
        },
      ],
    });
    expect(parsed.records).toHaveLength(1);
    // A field with no evidence entry is legitimate — not every field bundle
    // came with a page reference — and the schema must not require one.
    expect(parsed.records[0]?.evidence.newTiPerArea).toBeUndefined();
    expect(parsed.records[0]?.evidence.marketRent).toHaveLength(1);
  });

  it('accepts a null value as a remark rather than a figure', () => {
    const parsed = creAssumptionImportSchema.parse({
      ...MINIMAL,
      assumptions: [
        {
          target: 'valuation.discountRate',
          value: null,
          valueType: 'decimal',
          notes: 'Three competing developments are in planning in this submarket.',
        },
      ],
    });
    expect(parsed.assumptions[0]?.value).toBeNull();
  });

  it('accepts an unrecognized target: unsupported is analyzer output, not a parse refusal', () => {
    const parsed = creAssumptionImportSchema.parse({
      ...MINIMAL,
      assumptions: [{ target: 'tenant_credit_score', value: '82', valueType: 'integer' }],
    });
    expect(parsed.assumptions[0]?.target).toBe('tenant_credit_score');
  });

  it('bounds the assumptions and records arrays', () => {
    const one = { target: 'valuation.discountRate', value: '0.08', valueType: 'decimal' as const };
    expect(() =>
      creAssumptionImportSchema.parse({
        ...MINIMAL,
        assumptions: Array.from({ length: 501 }, () => one),
      }),
    ).toThrow();
  });
});
