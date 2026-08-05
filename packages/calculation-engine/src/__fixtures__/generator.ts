import { type ModelInput, type ModelInputDraft, parseModelInput } from '@cre/domain-models';

/**
 * Randomly generated models, for property-based testing.
 *
 * The regression library is twenty properties designed by hand, and every
 * expected value in it was derived independently of the engine. That is the
 * right way to check *specific* arithmetic and it can only ever check the cases
 * somebody thought of. A generator explores the ones nobody did: a lease that
 * begins after the forecast ends, a free-rent period longer than the term, a
 * hundred leases on a building with room for ten.
 *
 * ## Reproducibility is the whole design
 *
 * A property test that fails on a random input nobody can regenerate is worse
 * than no test: it reports a defect and withholds the evidence. So the
 * generator is a pure function of a seed, the seed is printed with every
 * failure, and `pnpm vitest -t "seed 12345"` replays it exactly. No dependency
 * is involved — a 32-bit PRNG is eight lines, and adding one would be more code
 * to trust than it replaces.
 *
 * ## What is deliberately not generated
 *
 * Debt, waterfalls and lease options. Each has invariants of its own worth
 * testing this way, and each also has enough interacting configuration that a
 * naive generator would spend most of its draws on combinations the schema
 * rejects — which tests the schema, not the engine. They belong in a later
 * generator that understands their constraints, not bolted onto this one.
 */

/**
 * A small deterministic PRNG (mulberry32).
 *
 * Not cryptographic and does not need to be. What it needs is to give the same
 * sequence for the same seed on every machine, which `Math.random` does not.
 */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Draw {
  /** An integer in [min, max]. */
  int: (min: number, max: number) => number;
  /** A decimal string with `places` digits, in [min, max]. */
  decimal: (min: number, max: number, places?: number) => string;
  /** One of the given values. */
  pick: <T>(values: readonly T[]) => T;
  /** True with the given probability. */
  chance: (probability: number) => boolean;
}

function drawer(next: () => number): Draw {
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    int,
    decimal: (min, max, places = 2) => (min + next() * (max - min)).toFixed(places),
    pick: (values) => values[int(0, values.length - 1)] as never,
    chance: (probability) => next() < probability,
  };
}

/** A date `months` after 2026-01-01, as YYYY-MM-DD on the first of the month. */
function monthsFromStart(months: number): string {
  const year = 2026 + Math.floor(months / 12);
  const month = (months % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/*
 * Vocabularies and field names taken from the schema, not from memory.
 *
 * Both were guessed first and both were wrong, in two different ways worth
 * recording because only one of them announced itself.
 *
 * The enums were **loudly** wrong: `contract` is not a lease status, `net` is
 * not a recovery method, and 285 of the first 300 seeds failed to parse.
 *
 * The field names were **silently** wrong, which is far worse. The draft said
 * `operatingExpenses` and put the vacancy rates at the top level; the schema
 * calls the array `expenses` and nests the rates under `vacancy`. Zod strips
 * unknown keys without complaint, so every model parsed, every property passed,
 * and general vacancy, credit loss, operating expenses and recoveries were zero
 * on all 1,251 generated rows. The suite was testing nothing and reporting
 * success.
 *
 * `properties.test.ts` now asserts its own coverage for exactly this reason.
 */
const PROPERTY_TYPES = ['office', 'industrial', 'retail', 'multifamily', 'mixed_use'] as const;
const LEASE_STATUSES = ['occupied', 'future', 'month_to_month', 'holdover'] as const;
const RECOVERY_METHODS = [
  'full_service_gross',
  'triple_net',
  'base_year',
  'expense_stop',
  'fixed_amount',
  'none',
] as const;
const EXPENSE_METHODS = [
  'fixed_annual',
  'per_area_per_year',
  'percent_of_effective_gross_revenue',
  'percent_of_base_rent',
] as const;

/**
 * One valid model, determined entirely by the seed.
 *
 * Every draw is inside the range the schema accepts, so `parseModelInput` is a
 * check that the generator is honest rather than a filter that quietly discards
 * most of what it produces. A generator whose output is mostly rejected tests
 * the validator and calls it engine coverage.
 */
export function generateModel(seed: number): ModelInput {
  const draw = drawer(rng(seed));

  const months = draw.int(12, 120);
  const rentableArea = draw.int(5_000, 500_000);
  const leaseCount = draw.int(0, 12);

  const leases = Array.from({ length: leaseCount }, (_, index) => {
    // Commencement is allowed before the forecast starts and after it ends.
    // Both are real — a sitting tenant, and a pre-let — and both are where
    // off-by-one errors in a calendar live.
    const startOffset = draw.int(-24, months + 6);
    const termMonths = draw.int(1, 180);
    const area = draw.int(100, Math.max(200, Math.floor(rentableArea / 2)));

    const recovery = draw.pick(RECOVERY_METHODS);
    const commencement = monthsFromStart(Math.max(0, startOffset + 24));
    return {
      id: `L${index}`,
      tenantId: `T${index}`,
      status: draw.pick(LEASE_STATUSES),
      area: String(area),
      commencementDate: commencement,
      expirationDate: monthsFromStart(Math.max(1, startOffset + 24 + termMonths)),
      baseRent: draw.decimal(5, 80),
      baseRentBasis: 'per_area_per_year' as const,
      // Free rent is allowed to run past the end of the term, which is invalid
      // as a lease and entirely possible as a data-entry mistake.
      freeRent: draw.chance(0.35)
        ? [{ startDate: commencement, months: draw.int(1, 18), abatementShare: draw.decimal(0, 1) }]
        : [],
      recovery: {
        method: recovery,
        ...(recovery === 'base_year' ? { baseYear: 2026 + draw.int(0, 2) } : {}),
        ...(recovery === 'expense_stop' ? { expenseStopPerArea: draw.decimal(1, 20) } : {}),
      },
      percentageRent: draw.chance(0.3)
        ? {
            enabled: true,
            breakpointType: 'natural' as const,
            overagePercent: draw.decimal(0.01, 0.1, 4),
            baseSales: String(draw.int(100_000, 20_000_000)),
          }
        : { enabled: false },
    };
  });

  const expenses = Array.from({ length: draw.int(0, 5) }, (_, index) => {
    const method = draw.pick(EXPENSE_METHODS);
    const isShare = method.startsWith('percent_of');
    return {
      id: `E${index}`,
      name: `Expense ${index}`,
      category: draw.pick(['operating', 'taxes', 'insurance', 'management'] as const),
      method,
      amount: isShare ? draw.decimal(0.01, 0.2, 4) : draw.decimal(0.5, 30_000),
      recoverableShare: draw.decimal(0, 1, 2),
      variableShare: draw.decimal(0, 1, 2),
    };
  });

  const draft: ModelInputDraft = {
    modelId: `generated-${seed}`,
    modelName: `Generated model ${seed}`,
    currency: 'USD',
    areaUnit: 'sqft',
    forecast: {
      startDate: '2026-01-01',
      months,
      fiscalYearStartMonth: draw.int(1, 12),
      proration: draw.pick(['actual_days', 'thirty_360', 'full_month'] as const),
    },
    property: {
      id: 'P1',
      name: `Generated property ${seed}`,
      propertyType: draw.pick(PROPERTY_TYPES),
      rentableArea: String(rentableArea),
      unitCount: draw.int(0, 200),
      ownershipPercent: draw.decimal(0.1, 1, 4),
    },
    valuation: {
      discountRate: draw.decimal(0.04, 0.15, 4),
      terminalCapRate: draw.decimal(0.03, 0.12, 4),
      saleCostPercent: draw.decimal(0, 0.06, 4),
      directCapAdjustments: '0',
      acquisitionCosts: '0',
    },
    vacancy: {
      generalVacancyRate: draw.decimal(0, 0.15, 4),
      creditLossRate: draw.decimal(0, 0.05, 4),
      netAgainstModelledVacancy: draw.chance(0.5),
    },
    ...(leases.length > 0 ? { leases } : {}),
    ...(expenses.length > 0 ? { expenses } : {}),
  } as ModelInputDraft;

  return parseModelInput(draft);
}
