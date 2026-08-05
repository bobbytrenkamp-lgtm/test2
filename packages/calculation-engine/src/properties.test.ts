import { describe, expect, it } from 'vitest';
import { calculate } from './engine.js';
import { generateModel } from './__fixtures__/generator.js';

/**
 * Property-based tests.
 *
 * The regression library checks twenty hand-designed properties against
 * arithmetic derived independently of the engine. That is the right way to
 * establish that a specific number is correct, and it can only ever cover the
 * cases somebody thought of.
 *
 * These check *invariants* — statements that must hold for every model, not for
 * one — over a few hundred generated ones. They cannot tell you that year three
 * rent is 636,540. They can tell you that no combination of inputs, including
 * ones nobody would design on purpose, makes occupancy exceed 100% or leaves
 * NOI failing to reconcile to its components.
 *
 * ## Failures are reproducible
 *
 * Every model is a pure function of its seed and the seed is in the test name.
 * A failure on seed 4,182 is replayed with:
 *
 *   pnpm vitest -t "seed 4182"
 *
 * A property test whose failing input cannot be regenerated reports a defect and
 * withholds the evidence, which is worse than not having run.
 *
 * ## Why the count is what it is
 *
 * 200 models, each a full engine run over up to ten years. Enough that a
 * one-in-fifty configuration shows up, few enough that the suite stays inside a
 * few seconds and nobody is tempted to skip it. The seeds are fixed rather than
 * random per run: a suite that tests something different on every CI build is
 * one that goes red for reasons unconnected to the change under review.
 */

const SEEDS = Array.from({ length: 200 }, (_, index) => index + 1);

/** How close two figures must be, in currency units, to count as reconciled. */
const TOLERANCE = 0.5;

/**
 * Every generated model, calculated once.
 *
 * Built lazily and shared across the properties below rather than recalculated
 * per assertion: two hundred full engine runs is the expensive part, and doing
 * it eight times over would make the suite slow enough that somebody eventually
 * skips it.
 */
const MODELS = SEEDS.map((seed) => {
  const input = generateModel(seed);
  return { seed, input, result: calculate(input) };
});

/**
 * Runs one property against every generated model.
 *
 * Structured this way rather than as a `describe` per seed for two reasons. It
 * reports **eight** tests rather than sixteen hundred, which is the honest
 * count — there are eight properties, checked two hundred times each, and a
 * suite that inflates its own total is doing the thing the documentation gate
 * exists to stop. And the seed reaches the failure message, so a red build names
 * the input that caused it.
 */
function forEveryModel(check: (model: (typeof MODELS)[number]) => void): void {
  for (const model of MODELS) {
    try {
      check(model);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `seed ${model.seed} failed this property.\n` +
          `Reproduce with: generateModel(${model.seed})\n\n${message}`,
      );
    }
  }
}

describe('engine invariants over generated models', () => {
  /**
   * The generator actually exercises the lines the properties below assert on.
   *
   * This test exists because the suite was, at first, entirely vacuous. Two
   * hundred models produced 1,251 annual rows in which general vacancy, credit
   * loss, operating expenses and recoveries were **all zero on every row** — the
   * draft named `operatingExpenses` and `generalVacancyRate` at the top level,
   * the schema calls them `expenses` and nests the rates under `vacancy`, and
   * zod strips unknown keys silently. Every property passed, over nothing.
   *
   * It was caught by deliberately inverting a sign convention in the engine and
   * finding that nothing failed. A property suite that cannot fail is a report
   * of safety, not evidence of it — so the coverage it depends on is now
   * asserted rather than assumed.
   */
  it('generates models that actually exercise every line under test', () => {
    const counts = {
      generalVacancy: 0,
      creditLoss: 0,
      operatingExpenses: 0,
      expenseRecoveries: 0,
      percentageRent: 0,
      freeRent: 0,
      scheduledBaseRent: 0,
    };
    let rows = 0;
    for (const { result } of MODELS) {
      for (const row of result.annual) {
        rows += 1;
        for (const line of Object.keys(counts) as Array<keyof typeof counts>) {
          if (Number(row.lines[line]) !== 0) counts[line] += 1;
        }
      }
    }

    expect(rows).toBeGreaterThan(500);
    // A tenth of rows is a low bar deliberately: the point is to catch a line
    // that is silently *always* zero, not to pin the generator's distribution,
    // which should be free to change without editing this number.
    for (const [line, hits] of Object.entries(counts)) {
      expect(hits / rows, `${line} was non-zero on ${hits} of ${rows} rows`).toBeGreaterThan(0.1);
    }
  });

  it('raises no error-severity diagnostic on a schema-valid model', () => {
    /*
     * A model the schema accepts may be commercially odd — free rent longer
     * than the term, a lease starting after the forecast ends — and the engine
     * must still produce a result rather than fail. Odd inputs are what a
     * warning is for; an error means the engine could not do its job.
     *
     * Written first as a filter for severity `critical`, which does not exist:
     * the severities are error, warning, informational and accepted_exception.
     * It passed two hundred times over while asserting nothing, and the
     * typechecker caught it — `TS2367: this comparison appears to be
     * unintentional`. A vacuous test is worse than a missing one, because it
     * occupies the space where somebody would have written a real one.
     */
    forEveryModel(({ result }) => {
      const errors = result.diagnostics.filter((entry) => entry.severity === 'error');
      expect(errors.map((entry) => `${entry.code}: ${entry.message}`)).toEqual([]);
    });
  });

  it('is deterministic', () => {
    forEveryModel(({ seed, result }) => {
      // The engine's central promise. If this breaks, every stored valuation
      // in the platform stops being reproducible.
      const again = calculate(generateModel(seed));
      expect(again.monthly).toEqual(result.monthly);
      expect(again.valuations).toEqual(result.valuations);
    });
  });

  it('reconciles every annual row to its components', () => {
    forEveryModel(({ result }) => {
      for (const row of result.annual) {
        const gpr = Number(row.lines.grossPotentialRevenue);
        const components =
          Number(row.lines.scheduledBaseRent) +
          Number(row.lines.percentageRent) +
          Number(row.lines.expenseRecoveries) +
          Number(row.lines.otherLeaseRevenue) +
          Number(row.lines.otherPropertyRevenue);
        expect(Math.abs(gpr - components)).toBeLessThan(TOLERANCE);

        const egr = Number(row.lines.effectiveGrossRevenue);
        expect(
          Math.abs(egr - (gpr + Number(row.lines.generalVacancy) + Number(row.lines.creditLoss))),
        ).toBeLessThan(TOLERANCE);

        expect(
          Math.abs(
            Number(row.lines.netOperatingIncome) - (egr + Number(row.lines.operatingExpenses)),
          ),
        ).toBeLessThan(TOLERANCE);

        expect(
          Math.abs(
            Number(row.lines.unleveredCashFlow) -
              (Number(row.lines.netOperatingIncome) +
                Number(row.lines.tenantImprovements) +
                Number(row.lines.leasingCommissions) +
                Number(row.lines.capitalExpenditures)),
          ),
        ).toBeLessThan(TOLERANCE);
      }
    });
  });

  it('keeps occupancy inside the building', () => {
    forEveryModel(({ result }) => {
      for (const row of result.occupancy) {
        const occupied = Number(row.occupiedArea);
        const available = Number(row.availableArea);
        const total = Number(row.totalRentableArea);

        // Area cannot be negative, and the two parts must make the whole. A
        // lease larger than the building is a data error the engine should
        // report, not absorb by inventing floor space.
        expect(occupied).toBeGreaterThanOrEqual(0);
        expect(available).toBeGreaterThanOrEqual(0);
        expect(Math.abs(occupied + available - total)).toBeLessThan(1);

        const percent = Number(row.physicalOccupancyPercent);
        expect(percent).toBeGreaterThanOrEqual(0);
        expect(percent).toBeLessThanOrEqual(1);
      }
    });
  });

  it('never abates more rent than was contracted', () => {
    forEveryModel(({ result }) => {
      // Free rent is a deduction, so scheduled rent can fall to zero and no
      // further. A negative here means the engine gave a tenant money.
      for (const row of result.annual) {
        expect(Number(row.lines.freeRent)).toBeLessThanOrEqual(TOLERANCE);
        expect(Number(row.lines.scheduledBaseRent)).toBeGreaterThanOrEqual(-TOLERANCE);
        expect(Number(row.lines.potentialBaseRent)).toBeGreaterThanOrEqual(-TOLERANCE);
      }
    });
  });

  it('keeps deductions negative and revenue positive, by sign convention', () => {
    forEveryModel(({ result }) => {
      /*
       * The whole platform reads money-in as positive and money-out as
       * negative. A line that flips sign does not merely display oddly — it
       * reverses its own contribution to every subtotal above it, which is
       * exactly the failure that is invisible in a total.
       */
      for (const row of result.annual) {
        expect(Number(row.lines.generalVacancy)).toBeLessThanOrEqual(TOLERANCE);
        expect(Number(row.lines.creditLoss)).toBeLessThanOrEqual(TOLERANCE);
        expect(Number(row.lines.operatingExpenses)).toBeLessThanOrEqual(TOLERANCE);
        expect(Number(row.lines.expenseRecoveries)).toBeGreaterThanOrEqual(-TOLERANCE);
      }
    });
  });

  it('produces one annual row per fiscal year the forecast covers', () => {
    forEveryModel(({ input, result }) => {
      const months = result.monthly.netOperatingIncome.length;
      expect(months).toBe(input.forecast.months);
      // Annual rows are fiscal, so the count is the months spanned rounded up,
      // and never more than one row per twelve months plus a stub at each end.
      expect(result.annual.length).toBeGreaterThanOrEqual(Math.floor(months / 12));
      expect(result.annual.length).toBeLessThanOrEqual(Math.ceil(months / 12) + 1);
    });
  });

  it('reports every figure as a finite number', () => {
    forEveryModel(({ result }) => {
      // Decimal strings are the contract. A NaN or an Infinity reaching a
      // report is a number somebody could act on that means nothing.
      for (const row of result.annual) {
        for (const [line, value] of Object.entries(row.lines)) {
          expect(Number.isFinite(Number(value)), `${line} = ${value}`).toBe(true);
        }
      }
    });
  });
});
