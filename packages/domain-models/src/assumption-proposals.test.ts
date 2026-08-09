import { describe, expect, it } from 'vitest';
import {
  assumptionProposalBatchSchema,
  assumptionProposalInputSchema,
  resolveAssumptionValue,
} from './assumption-proposals.js';

/**
 * The assumption input contract.
 *
 * Two things are worth pinning here, and they pull in opposite directions.
 *
 * The contract is deliberately *loose* about what a source may talk about: an
 * unknown target is information about a gap in the product and dropping it
 * would be the worst available option. It is deliberately *strict* about the
 * value, which is a decimal string like every other number in this system,
 * because a rate that loses precision on the way in is worse than one that is
 * refused at the door.
 *
 * `resolveAssumptionValue` is the piece the screen depends on: it finds the
 * number the model actually uses, so a proposal can be shown beside it. A bug
 * here shows an analyst a difference that does not exist.
 */

const MODEL = {
  valuation: {
    discountRate: '0.0825',
    terminalCapRate: '0.0625',
    acquisitionPrice: '48500000',
    saleMonth: 60,
    grossSalePriceOverride: null,
  },
  vacancy: { generalVacancyRate: '0.05', creditLossRate: '0' },
  marketLeasingProfiles: [
    { id: 'MLA-OFF', marketRent: '38.50', renewalProbability: '0.7' },
    { id: 'MLA-RET', marketRent: '52.00', renewalProbability: '0.6' },
  ],
  expenses: [{ id: 'OPEX-INS', amount: '145000' }],
  leases: [{ id: 'L-001', baseRent: '36.00' }],
};

describe('resolveAssumptionValue', () => {
  it('finds a model-level assumption', () => {
    expect(resolveAssumptionValue(MODEL, 'valuation.terminalCapRate')).toBe('0.0625');
    expect(resolveAssumptionValue(MODEL, 'vacancy.generalVacancyRate')).toBe('0.05');
  });

  it('finds a row of a collection by its code', () => {
    expect(resolveAssumptionValue(MODEL, 'marketLeasing.MLA-RET.marketRent')).toBe('52.00');
    expect(resolveAssumptionValue(MODEL, 'expenses.OPEX-INS.amount')).toBe('145000');
    expect(resolveAssumptionValue(MODEL, 'leases.L-001.baseRent')).toBe('36.00');
  });

  it('maps the contract’s collection name to the engine’s', () => {
    /*
     * The contract says `marketLeasing`; the input calls the array
     * `marketLeasingProfiles`. Renaming either would be worse than mapping
     * them: the contract's name is the one an analyst would use, the input's is
     * the one the engine reads, and both are correct in their own place.
     */
    expect(resolveAssumptionValue(MODEL, 'marketLeasing.MLA-OFF.renewalProbability')).toBe('0.7');
  });

  it('returns null rather than guessing when it cannot find the target', () => {
    // Each of these is a real case: a section that does not exist, a field that
    // does not, a row code that does not, and a path with no field at all.
    expect(resolveAssumptionValue(MODEL, 'hotel.adr')).toBeNull();
    expect(resolveAssumptionValue(MODEL, 'valuation.notAField')).toBeNull();
    expect(resolveAssumptionValue(MODEL, 'expenses.NOPE.amount')).toBeNull();
    expect(resolveAssumptionValue(MODEL, 'valuation')).toBeNull();
  });

  it('distinguishes an absent value from a null one', () => {
    /*
     * Both come back as null, which is right — there is nothing to compare
     * against either way — but they are different facts, and the screen says
     * "—" rather than "0" for both. Zero would be a claim.
     */
    expect(resolveAssumptionValue(MODEL, 'valuation.grossSalePriceOverride')).toBeNull();
  });

  it('stringifies a numeric field without going through a float', () => {
    // `saleMonth` is a whole number on the input, not a decimal string. It is
    // still addressable, and still comes back as text.
    expect(resolveAssumptionValue(MODEL, 'valuation.saleMonth')).toBe('60');
  });
});

describe('the proposal schema', () => {
  const base = {
    target: 'valuation.terminalCapRate',
    sourceKind: 'market_data' as const,
    sourceName: 'test3',
  };

  it('keeps a value as a string', () => {
    const parsed = assumptionProposalInputSchema.parse({ ...base, value: '0.0575' });
    expect(parsed.value).toBe('0.0575');
    // The point of the whole exercise. A number here would already have lost
    // whatever the source's last digits were worth.
    expect(typeof parsed.value).toBe('string');
  });

  it('accepts a proposal with no value at all', () => {
    /*
     * "Three competing developments are in planning in this submarket" has no
     * number in it and is worth recording against the rent growth assumption.
     * The decision route refuses to *apply* one, which is a different thing.
     */
    const parsed = assumptionProposalInputSchema.parse({
      ...base,
      value: null,
      notes: 'Three competing developments in planning.',
    });
    expect(parsed.value).toBeNull();
  });

  it('leaves confidence absent rather than defaulting it', () => {
    const parsed = assumptionProposalInputSchema.parse({ ...base, value: '0.03' });
    // A default of 1 would assert a certainty nobody claimed; a default of 0
    // would assert the opposite. Absent is the honest answer.
    expect(parsed.confidence).toBeUndefined();
  });

  it('refuses a confidence outside 0 to 1', () => {
    expect(() =>
      assumptionProposalInputSchema.parse({ ...base, value: '0.03', confidence: 81 }),
    ).toThrow();
  });

  it('accepts a target this release does not model', () => {
    /*
     * Deliberate. A source with a view on data-centre power costs is telling us
     * something true about a gap in the product, and validating targets against
     * the current schema would silently discard exactly the proposals worth
     * reading.
     */
    expect(() =>
      assumptionProposalInputSchema.parse({
        ...base,
        target: 'dataCentre.powerCostPerKw',
        value: '0.11',
      }),
    ).not.toThrow();
  });

  it('refuses a target that is not a path', () => {
    // Not schema validation of the model — just enough to keep a free-text
    // field from carrying a sentence, a URL or an injection attempt.
    expect(() =>
      assumptionProposalInputSchema.parse({ ...base, target: 'rent growth, probably' }),
    ).toThrow();
  });

  it('defaults evidence to an object so a reader never has to null-check it', () => {
    expect(assumptionProposalInputSchema.parse({ ...base, value: '0.03' }).evidence).toEqual({});
  });

  it('bounds a batch', () => {
    const one = { ...base, value: '0.03' };
    expect(() => assumptionProposalBatchSchema.parse({ proposals: [] })).toThrow();
    expect(() =>
      assumptionProposalBatchSchema.parse({ proposals: Array.from({ length: 201 }, () => one) }),
    ).toThrow();
    expect(assumptionProposalBatchSchema.parse({ proposals: [one] }).proposals).toHaveLength(1);
  });
});
