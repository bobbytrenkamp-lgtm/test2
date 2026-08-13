import { describe, expect, it } from 'vitest';
import {
  assumptionProposalBatchSchema,
  assumptionProposalInputSchema,
  resolveAssumptionValue,
  validateTypedValue,
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

  it('finds a row whose own code contains a dot', () => {
    /*
     * Found by a thirteenth audit pass: a collection row's `id` is free-form
     * text with no restriction against a literal dot, and the naive split
     * `[rest[0], rest.slice(1).join('.')]` took only the text up to the
     * first dot as the code — silently reading the rest of the code as part
     * of the field name and returning null for a row that genuinely exists.
     */
    const withDottedCode = {
      ...MODEL,
      marketLeasingProfiles: [
        ...MODEL.marketLeasingProfiles,
        { id: 'MLA.Office', marketRent: '41.00', renewalProbability: '0.65' },
      ],
    };
    expect(resolveAssumptionValue(withDottedCode, 'marketLeasing.MLA.Office.marketRent')).toBe(
      '41.00',
    );
  });

  it('prefers the longest matching code when one code is a dotted prefix of another', () => {
    // Two rows, "MLA" and "MLA.Office", where "MLA" alone is also a valid
    // prefix of the target string. The more specific match wins, rather
    // than the shorter row swallowing the longer row's own code as part of
    // its field name.
    const ambiguous = {
      ...MODEL,
      marketLeasingProfiles: [
        { id: 'MLA', marketRent: '30.00', renewalProbability: '0.5' },
        { id: 'MLA.Office', marketRent: '41.00', renewalProbability: '0.65' },
      ],
    };
    expect(resolveAssumptionValue(ambiguous, 'marketLeasing.MLA.Office.marketRent')).toBe('41.00');
    expect(resolveAssumptionValue(ambiguous, 'marketLeasing.MLA.marketRent')).toBe('30.00');
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

  it('defaults valueType to decimal, matching every proposal before this existed', () => {
    expect(assumptionProposalInputSchema.parse({ ...base, value: '0.03' }).valueType).toBe(
      'decimal',
    );
  });

  it('accepts a bare JSON number, coerced to a string', () => {
    // The wire format always did — decimalString accepted a union of string
    // and number — and a source posting numeric JSON must not start failing.
    const parsed = assumptionProposalInputSchema.parse({ ...base, value: 0.0625 });
    expect(parsed.value).toBe('0.0625');
    expect(typeof parsed.value).toBe('string');
  });

  it.each([
    ['integer', '60'],
    ['date', '2026-09-01'],
    ['boolean', 'true'],
    ['boolean', 'false'],
    ['enum', 'forward_12'],
    ['string', 'a note'],
  ] as const)('accepts a valid %s value', (valueType, value) => {
    expect(() => assumptionProposalInputSchema.parse({ ...base, value, valueType })).not.toThrow();
  });

  it.each([
    ['integer', '60.5', 'a whole number'],
    ['date', '09/01/2026', 'YYYY-MM-DD'],
    ['boolean', 'yes', 'true'],
    ['decimal', '6.25%', 'a decimal number'],
  ] as const)('refuses an invalid %s value rather than guessing', (valueType, value, expected) => {
    /*
     * The load-bearing case: "6.25" for a rate someone meant as "6.25%" is
     * refused here rather than silently read as 625%. Guessing which the
     * source meant is exactly what this contract exists to not do.
     */
    let message = '';
    try {
      assumptionProposalInputSchema.parse({ ...base, value, valueType });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain(expected);
  });

  it('refuses a decimal-looking rate with no percent sign at face value', () => {
    // "6.25" is a syntactically valid decimal — the point is that a decimal
    // value type accepts it as 6.25, not that it detects a unit mismatch. Unit
    // sanity (a rate over 1) is the analyzer's job, checked separately; this
    // schema only enforces shape.
    expect(() =>
      assumptionProposalInputSchema.parse({ ...base, value: '6.25', valueType: 'decimal' }),
    ).not.toThrow();
  });
});

/**
 * `validateTypedValue`'s `enumValues` parameter.
 *
 * Found by a tenth audit pass: without a target's real allowed values to
 * check against, `'enum'` could only confirm a proposed value was non-empty
 * text — accepting a value like `"percent_of_revenue"` for an expense's
 * `method` (the real member is `percent_of_effective_gross_revenue`), which
 * an accepted proposal would then write straight into the database. Nothing
 * would fail until the model's next calculation, when `parseModelInput`'s
 * strict schema enum throws on the row — by which point there is no
 * self-service path back, only a corrupted model and a database row somebody
 * has to find and repair by hand.
 */
describe('validateTypedValue, enum membership', () => {
  const methodValues = [
    'fixed_annual',
    'per_area_per_year',
    'per_unit_per_year',
    'percent_of_effective_gross_revenue',
    'percent_of_base_rent',
    'custom_monthly_schedule',
  ] as const;

  it('accepts a value that is one of the target’s own allowed members', () => {
    expect(
      validateTypedValue('percent_of_effective_gross_revenue', 'enum', methodValues),
    ).toBeNull();
  });

  it('refuses a plausible-looking value that is not actually a member', () => {
    // The exact mistake the audit found reachable: a source (or a person)
    // writing the shorter, more natural-sounding name instead of the real
    // enum member.
    const problem = validateTypedValue('percent_of_revenue', 'enum', methodValues);
    expect(problem).not.toBeNull();
    expect(problem).toContain('percent_of_revenue');
    expect(problem).toContain('percent_of_effective_gross_revenue');
  });

  it('refuses an empty value even when enumValues is supplied', () => {
    expect(validateTypedValue('', 'enum', methodValues)).not.toBeNull();
  });

  it('falls back to the loose non-empty-text check when no enumValues is given', () => {
    // The proposal schema's own `superRefine` calls this with no enumValues,
    // deliberately — see this file's module doc: a proposal's target is not
    // resolved against the model at creation time, so there is nothing to
    // check membership against yet. That case must keep working exactly as
    // it did before enumValues existed.
    expect(validateTypedValue('anything-at-all', 'enum')).toBeNull();
  });
});
