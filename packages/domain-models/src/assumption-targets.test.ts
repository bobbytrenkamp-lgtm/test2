import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  COLLECTIONS,
  MODEL_SECTIONS,
  VACANCY_TARGETS,
  VALUATION_TARGETS,
  describeTarget,
} from './assumption-targets.js';
import {
  capitalItemSchema,
  debtFacilitySchema,
  growthCurveSchema,
  marketLeasingProfileSchema,
  operatingExpenseSchema,
  otherPropertyRevenueSchema,
  vacancySchema,
  valuationSchema,
} from './model-input.js';

/**
 * The registry against the schemas it claims to describe.
 *
 * `assumption-targets.ts` is a hand-written list, by its own admission — a
 * generic introspector could not tell a scalar field from a structured one,
 * or invent a human label. What keeps the list honest instead is this file:
 * every field it claims is writable has to actually exist, with the type
 * claimed, on the real `model-input.ts` schema. A field renamed in one place
 * and not the other fails here, not in front of an analyst mid-import.
 */

const SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  expenses: operatingExpenseSchema,
  otherRevenue: otherPropertyRevenueSchema,
  capital: capitalItemSchema,
  debt: debtFacilitySchema,
  marketLeasing: marketLeasingProfileSchema,
  growthCurves: growthCurveSchema,
};

describe('the collection target registry matches the real schemas', () => {
  for (const collection of COLLECTIONS) {
    const schema = SCHEMAS[collection.collection];

    it(`${collection.collection} is a known schema`, () => {
      expect(schema, `no schema mapped for ${collection.collection}`).toBeDefined();
    });

    for (const field of collection.fields) {
      it(`${collection.collection}.${field.field} exists on the real schema`, () => {
        expect(
          schema?.shape[field.field],
          `${collection.collection}.${field.field} is claimed as writable but is not a field ` +
            `of the real collection schema`,
        ).toBeDefined();
      });

      if (field.valueType === 'enum') {
        it(`${collection.collection}.${field.field} lists the schema's real enum values`, () => {
          const options = unwrapEnumOptions(schema?.shape[field.field]);
          expect(
            options,
            `${collection.collection}.${field.field} is claimed as an enum but the schema field ` +
              `is not one`,
          ).not.toBeNull();
          expect(new Set(field.enumValues)).toEqual(new Set(options));
        });
      }
    }
  }
});

describe('the model-level target registry matches the real schemas', () => {
  const sections: Record<string, z.ZodObject<z.ZodRawShape>> = {
    valuation: valuationSchema,
    vacancy: vacancySchema,
  };

  for (const [section, targets] of Object.entries(MODEL_SECTIONS)) {
    for (const target of targets) {
      it(`${section}.${target.field} exists on the real schema`, () => {
        expect(sections[section]?.shape[target.field]).toBeDefined();
      });
    }
  }

  it('lists every scalar field valuationSchema actually has, or explains the exclusion', () => {
    // Deliberately the other direction: every key on the real schema is
    // accounted for here, so a *new* field added to valuationSchema is
    // caught as missing from the registry rather than silently unwritable
    // through the import contract with nobody noticing.
    const claimed = new Set(VALUATION_TARGETS.map((entry) => entry.field));
    const missing = Object.keys(valuationSchema.shape).filter((key) => !claimed.has(key));
    expect(
      missing,
      `valuationSchema fields not represented in VALUATION_TARGETS: ${missing}`,
    ).toEqual([]);
  });

  it('lists every field vacancySchema actually has, except the structured one', () => {
    const claimed = new Set(VACANCY_TARGETS.map((entry) => entry.field));
    // `appliesTo` is an array of enum values, not a scalar — the one field on
    // this schema the import contract cannot express as a single value yet.
    const missing = Object.keys(vacancySchema.shape).filter(
      (key) => !claimed.has(key) && key !== 'appliesTo',
    );
    expect(missing).toEqual([]);
  });
});

describe('describeTarget', () => {
  it('resolves a real model-level target', () => {
    const result = describeTarget('valuation.terminalCapRate');
    expect(result.ok).toBe(true);
  });

  it('resolves a real collection target', () => {
    const result = describeTarget('debt.SENIOR.termMonths');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.collection).toBe('debt');
      expect(result.code).toBe('SENIOR');
    }
  });

  it('resolves a collection target whose own code contains a dot', () => {
    /*
     * Found by a thirteenth audit pass: a collection row's `id` is free-form
     * text with no restriction against a literal dot ("MLP.Office", copied
     * verbatim from a source document by an import). Splitting the target
     * forward from a fixed position — `parts.slice(2).join('.')` for the
     * field — read that dot as part of the field name instead, so a target
     * this dictionary genuinely supports was reported as unsupported. Field
     * names are a small known set with no dots in any of them, so matching
     * backward from the end against that set is what actually disambiguates
     * a dotted code from a dotted field.
     */
    const result = describeTarget('marketLeasing.MLP.Office.marketRent');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.collection).toBe('marketLeasing');
      expect(result.code).toBe('MLP.Office');
      expect(result.descriptor.field).toBe('marketRent');
    }
  });

  it('refuses a field this release does not write, with a reason', () => {
    const result = describeTarget('valuation.notAField');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('valuation');
  });

  it('refuses lease terms specifically, by name', () => {
    const result = describeTarget('leases.L-1.baseRent');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('rent roll');
  });

  it('refuses a target this release does not model at all', () => {
    const result = describeTarget('dataCentre.powerCostPerKw');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('does not model');
  });
});

/** Best-effort unwrap of a zod field to its enum's option list, or null. */
function unwrapEnumOptions(fieldSchema: unknown): string[] | null {
  let current = fieldSchema as {
    _def?: { typeName?: string; innerType?: unknown; values?: string[] };
  };
  for (let i = 0; i < 5 && current?._def; i += 1) {
    if (current._def.typeName === 'ZodEnum' && current._def.values) return current._def.values;
    if (current._def.innerType) {
      current = current._def.innerType as typeof current;
      continue;
    }
    break;
  }
  return null;
}
