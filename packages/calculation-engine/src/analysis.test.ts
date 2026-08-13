import { describe, expect, it } from 'vitest';
import { ALL_FIXTURES } from './__fixtures__/properties.js';
import { baseModel, extendModel } from './__fixtures__/builders.js';
import { calculate } from './engine.js';
import { assessHealth } from './health.js';
import { DRIVER_KEYS, rankDrivers } from './drivers.js';
import type { ModelInput, ModelResult } from '@cre/domain-models';

/**
 * Underwriting health and driver ranking.
 *
 * Both are analysis over the engine rather than part of it, and both are pure,
 * so they are tested against the regression fixtures directly. The standard
 * applied is the same one the findings themselves claim: a rule must fire when
 * the condition holds and stay quiet when it does not, and it must be possible
 * to make it fire on purpose.
 */

function fixture(name: keyof typeof ALL_FIXTURES): { input: ModelInput; result: ModelResult } {
  const build = ALL_FIXTURES[name];
  if (!build) throw new Error(`No fixture named ${String(name)}`);
  const input = build();
  return { input, result: calculate(input) };
}

const find = (report: ReturnType<typeof assessHealth>, id: string) =>
  report.findings.find((finding) => finding.id === id);

describe('underwriting health', () => {
  it('produces findings for every fixture without throwing', () => {
    for (const name of Object.keys(ALL_FIXTURES)) {
      const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
      const report = assessHealth(input, result);
      expect(report.findings.length, `${name} produced no findings at all`).toBeGreaterThan(0);
      for (const finding of report.findings) {
        expect(finding.title, `${name}/${finding.id} has no title`).toBeTruthy();
        expect(finding.detail, `${name}/${finding.id} has no explanation`).toBeTruthy();
      }
    }
  });

  it('gives no overall score, deliberately', () => {
    /*
     * Pinned as a design decision. A model reduced to "72 out of 100" invites
     * an argument about the 72 and hides the four things that matter, and the
     * weighting would be an opinion presented as a measurement.
     */
    const { input, result } = fixture('multiTenantOffice');
    const report = assessHealth(input, result);
    expect(Object.keys(report).sort()).toEqual(['findings', 'notes', 'passes', 'warnings']);
  });

  it('states the threshold it applied, so a reader can disagree with it', () => {
    const { input, result } = fixture('multiTenantOffice');
    const concentration = find(assessHealth(input, result), 'tenant.concentration');
    expect(concentration).toBeDefined();
    // Whichever way it came out, the figure and the bar are both stated.
    expect(concentration?.detail).toMatch(/%/);
  });

  it('flags a tenant that dominates the rent roll', () => {
    // A single-tenant industrial building is, by construction, wholly
    // concentrated. If the rule did not fire there it would never fire.
    const industrial = fixture('singleTenantIndustrial');
    const loud = find(assessHealth(industrial.input, industrial.result), 'tenant.concentration');
    expect(loud?.severity).toBe('warning');
    expect(loud?.title).toMatch(/100\.0% of year-one base rent/);
    expect(loud?.link?.tab).toBe('rent-roll');
  });

  it('stays quiet on a rent roll that is genuinely spread', () => {
    /*
     * None of the fixtures is diversified — the largest tenant is 48% on the
     * grocery-anchored centre and 53% on the office, which is realistic for a
     * three-tenant demonstration and above the threshold. So the quiet branch
     * is exercised against a rent roll built to be spread, rather than by
     * lowering the bar until a fixture slips under it.
     */
    const { input } = fixture('multiTenantOffice');
    const template = input.leases[0];
    expect(template).toBeDefined();
    const spread: ModelInput = {
      ...input,
      tenants: Array.from({ length: 10 }, (_, i) => ({
        id: `T-${i}`,
        name: `Tenant ${i}`,
        isAnchor: false,
      })),
      leases: Array.from({ length: 10 }, (_, i) => ({
        ...(template as NonNullable<typeof template>),
        id: `L-${i}`,
        tenantId: `T-${i}`,
        spaceIds: [],
        area: '4000',
        baseRent: '30',
      })),
    };
    const finding = find(assessHealth(spread, calculate(spread)), 'tenant.concentration');
    expect(finding?.severity).toBe('pass');
  });

  it('flags an exit cap rate compressed below the going-in rate', () => {
    const { input, result } = fixture('multiTenantOffice');
    expect(find(assessHealth(input, result), 'valuation.capSpread')?.severity).toBe('pass');

    /*
     * Compressed below the *going-in* rate, which on this fixture is 2.97% —
     * the office is priced high against year-one NOI because 42% of its area
     * rolls inside two years. Picking a round 3% would not have been
     * compression at all, which is exactly the sort of thing the rule exists
     * to make visible.
     */
    const compressed = { ...input, valuation: { ...input.valuation, terminalCapRate: '0.02' } };
    const finding = find(assessHealth(compressed, calculate(compressed)), 'valuation.capSpread');
    expect(finding?.severity).toBe('warning');
    expect(finding?.title).toMatch(/bps below the going-in rate/);
  });

  it('reports a missing valuation input rather than letting it read as zero', () => {
    const { input } = fixture('multiTenantOffice');
    // Cast through `unknown`: the schema types these as present, and the point
    // of the rule is what happens when a stored model does not have them.
    const stripped = {
      ...input,
      valuation: { ...input.valuation, discountRate: null, acquisitionPrice: null },
    } as unknown as ModelInput;
    const finding = find(assessHealth(stripped, calculate(stripped)), 'valuation.inputs');
    expect(finding?.severity).toBe('warning');
    expect(finding?.title).toContain('a discount rate');
    expect(finding?.title).toContain('a purchase price');
  });

  it('notices when space area does not reconcile to the building', () => {
    /*
     * The space list is the denominator for every pro-rata recovery share, so
     * a gap here misstates what every tenant reimburses.
     */
    const { input, result } = fixture('multiTenantOffice');
    expect(find(assessHealth(input, result), 'area.reconciles')?.severity).toBe('pass');

    const shrunk: ModelInput = {
      ...input,
      property: { ...input.property, rentableArea: '10000' },
    };
    const finding = find(assessHealth(shrunk, result), 'area.reconciles');
    expect(finding?.severity).toBe('warning');
    expect(finding?.detail).toContain('denominator');
  });

  it('reports covenant breaches where the engine found them', () => {
    const { input, result } = fixture('cashTrapOnBreach');
    const finding = find(assessHealth(input, result), 'debt.covenant');
    expect(finding?.severity).toBe('warning');
    expect(finding?.title).toMatch(/covenant breach/);
  });

  it('confirms the debt is retired when it is', () => {
    const { input, result } = fixture('refinanceScenario');
    expect(find(assessHealth(input, result), 'debt.retired')?.severity).toBe('pass');
  });

  it('says nothing about a facility the engine refused to model, rather than reading its absence as fully repaid', () => {
    /*
     * Found by a thirteenth audit pass. `computeDebt` refuses a facility
     * funded before the forecast start outright (`DEBT_FUNDED_BEFORE_FORECAST`)
     * and never pushes a schedule for it — `debtRetired` summed
     * `result.debtSchedules`, which is simply empty for a wholly-refused
     * facility, and read that empty sum as a zero balance: "Debt is fully
     * repaid," a false all-clear for a facility whose real balance is
     * unknown, not zero, and whose debt service never touched the levered
     * return this same health panel reports elsewhere.
     */
    const model = extendModel(baseModel(), {
      debt: [
        {
          id: 'D-PRE',
          name: 'Existing first mortgage',
          type: 'permanent',
          commitment: '5000000',
          initialFunding: '5000000',
          fundingDate: '2025-01-01', // baseModel's forecast starts 2026-01-01.
          rateType: 'fixed',
          fixedRate: '0.06',
          interestOnlyMonths: 0,
          amortizationMonths: 360,
          termMonths: 120,
        },
      ],
    });
    const result = calculate(model);
    expect(result.debtSchedules).toHaveLength(0);
    expect(find(assessHealth(model, result), 'debt.retired')).toBeUndefined();
    // The engine's own error finding is what actually surfaces the problem.
    expect(find(assessHealth(model, result), 'engine.errors')?.severity).toBe('warning');
  });

  it('measures expiry on a rolling window, not by calendar year', () => {
    /*
     * The reason the rule is written this way: 19% expiring in December and
     * 19% the following January is 38% in two months, and a per-year view
     * reports two unremarkable years.
     */
    const { input, result } = fixture('multiTenantOffice');
    const base = find(assessHealth(input, result), 'expiry.concentration');
    expect(base).toBeDefined();

    // Move every lease to expire inside one window and the rule must fire.
    const cliff: ModelInput = {
      ...input,
      leases: input.leases.map((lease) => ({ ...lease, expirationDate: '2027-06-30' })),
    };
    const finding = find(assessHealth(cliff, calculate(cliff)), 'expiry.concentration');
    expect(finding?.severity).toBe('warning');
    expect(finding?.title).toMatch(/of area expires within 24 months/);
  });

  it('counts what it found', () => {
    const { input, result } = fixture('multiTenantOffice');
    const report = assessHealth(input, result);
    expect(report.warnings + report.notes + report.passes).toBe(report.findings.length);
  });
});

describe('driver ranking', () => {
  it('ranks by measured effect, using the real engine', () => {
    const { input, result } = fixture('multiTenantOffice');
    const report = rankDrivers(input, result, 'unleveredIrr');

    expect(report.drivers.length).toBeGreaterThan(3);
    // Sorted, largest swing first.
    for (let i = 1; i < report.drivers.length; i += 1) {
      expect((report.drivers[i - 1] as { swing: number }).swing).toBeGreaterThanOrEqual(
        (report.drivers[i] as { swing: number }).swing,
      );
    }
  });

  it('reports both directions, because a variable can be asymmetric', () => {
    const { input, result } = fixture('multiTenantOffice');
    const report = rankDrivers(input, result, 'unleveredIrr', {
      only: ['valuation.terminalCapRate'],
    });
    const driver = report.drivers[0];
    expect(driver?.low).not.toBeNull();
    expect(driver?.high).not.toBeNull();
    // A lower exit cap rate is a higher sale price, so a higher return.
    expect(Number(driver?.low)).toBeGreaterThan(Number(driver?.high));
  });

  it('puts the exit cap rate near the top of an unlevered return', () => {
    /*
     * Not an arbitrary expectation: the terminal value is NOI divided by the
     * cap rate, so the metric is arithmetically very sensitive to it. If this
     * stopped being true, either the ranking or the engine would have changed
     * in a way somebody should look at.
     */
    const { input, result } = fixture('multiTenantOffice');
    const report = rankDrivers(input, result, 'unleveredIrr');
    const positions = report.drivers.map((driver) => driver.key);
    expect(positions.indexOf('valuation.terminalCapRate')).toBeLessThan(3);
  });

  it('counts its engine runs, so the cost is visible', () => {
    const { input, result } = fixture('multiTenantOffice');
    let runs = 0;
    const report = rankDrivers(input, result, 'unleveredIrr', {
      only: ['valuation.terminalCapRate', 'operatingExpenses'],
      run: (candidate) => {
        runs += 1;
        return calculate(candidate);
      },
    });
    expect(runs).toBe(4);
    expect(report.runs).toBe(4);
  });

  it('leaves out a driver the model has nothing to move', () => {
    // A model with no debt has no debt rate. That is a driver that does not
    // apply, not one measured at zero — listing it at zero would say the
    // opposite of the truth.
    const { input, result } = fixture('multiTenantOffice');
    expect(input.debt).toHaveLength(0);
    const report = rankDrivers(input, result, 'unleveredIrr');
    expect(report.drivers.map((driver) => driver.key)).not.toContain('debtRate');
  });

  it('includes the debt rate when there is debt to move', () => {
    const { input, result } = fixture('refinanceScenario');
    const report = rankDrivers(input, result, 'leveredIrr', { only: ['debtRate'] });
    expect(report.drivers[0]?.key).toBe('debtRate');
    expect(report.drivers[0]?.swing).toBeGreaterThan(0);
    // More expensive debt is a worse levered return.
    expect(Number(report.drivers[0]?.high)).toBeLessThan(Number(report.drivers[0]?.low));
  });

  it('keeps a renewal probability inside its bounds', () => {
    /*
     * A probability is a fraction. Pushing one past 1 would make the engine
     * reject the input, and the driver would report "no sensitivity" for a
     * variable that has plenty.
     */
    const { input, result } = fixture('multiTenantOffice');
    const report = rankDrivers(input, result, 'unleveredIrr', { only: ['renewalProbability'] });
    expect(report.drivers[0]?.partial).toBe(false);
    expect(report.drivers[0]?.low).not.toBeNull();
    expect(report.drivers[0]?.high).not.toBeNull();
  });

  it('answers for each metric it offers', () => {
    const { input, result } = fixture('refinanceScenario');
    for (const metric of [
      'leveredIrr',
      'unleveredIrr',
      'equityMultiple',
      'netPresentValue',
      'year1Noi',
      'minimumDscr',
    ] as const) {
      const report = rankDrivers(input, result, metric, { only: ['operatingExpenses'] });
      expect(report.metric, `${metric} did not come back`).toBe(metric);
      expect(report.drivers).toHaveLength(1);
    }
  });

  it('exposes its candidate keys, so a caller can validate a request', () => {
    expect(DRIVER_KEYS).toContain('valuation.terminalCapRate');
    expect(DRIVER_KEYS).toContain('debtRate');
    expect(new Set(DRIVER_KEYS).size).toBe(DRIVER_KEYS.length);
  });

  it('does not alter the model it was asked about', () => {
    // The perturbations clone. A driver run that mutated the input would leave
    // the caller holding a model nobody edited.
    const { input, result } = fixture('multiTenantOffice');
    const before = JSON.stringify(input);
    rankDrivers(input, result, 'unleveredIrr');
    expect(JSON.stringify(input)).toBe(before);
  });
});
