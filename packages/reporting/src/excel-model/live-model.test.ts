import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { ALL_FIXTURES, calculate } from '@cre/calculation-engine';
import {
  parseModelInput,
  type CashFlowLine,
  type ModelInput,
  type ModelResult,
} from '@cre/domain-models';
import { buildLiveModel, liveModelFilename } from './build.js';
import { renderWorkbook } from './render.js';
import type { CellSpec, WorkbookModel } from './model.js';
import { FormulaEvaluator } from './evaluate.js';

/**
 * Phase 2 tests: the core property model.
 *
 * ## How reconciliation is done, and what it does not prove
 *
 * There are two layers here, and the first one alone was not enough.
 *
 * The *identity* tests check that the engine's own series satisfy the
 * relationships the formulas encode. They catch a misreading of the engine —
 * and they found one: the output series negate every deduction, so each
 * subtotal is an addition rather than a subtraction.
 *
 * They are not sufficient. Reintroducing a sign error on purpose (subtracting
 * free rent where the engine adds it) left every identity test passing, because
 * they assert about the engine, not about the formula text emitted.
 *
 * So the second layer *evaluates the emitted formulas* through the same
 * references Excel would follow (`FormulaEvaluator`) and compares the result to
 * the engine, cell by cell and period by period. Both probes above now fail
 * loudly, naming the cell and both values.
 *
 * What this still does not prove is that Excel itself evaluates identically.
 * The evaluator implements a small subset — arithmetic, references, SUM, MAX,
 * IF, IFERROR — and returns NaN for XIRR, XNPV and SUMIF, whose cells are
 * skipped rather than counted as checked. Opening the workbook in Excel remains
 * a manual step.
 */

const CENT = 0.01;

/**
 * Tolerance for an identity summing several engine lines.
 *
 * Each line is rounded to cents on its way out of the engine, so a sum of k
 * rounded lines can differ from the rounded sum by up to k/2 cents. Asserting
 * exact equality here would be asserting that rounding does not happen.
 */
const SUM_TOLERANCE = 0.05;

function fixture(name: keyof typeof ALL_FIXTURES): { input: ModelInput; result: ModelResult } {
  const build = ALL_FIXTURES[name];
  if (!build) throw new Error(`No fixture named ${String(name)}.`);
  const input = build();
  return { input, result: calculate(input) };
}

function series(result: ModelResult, line: CashFlowLine): number[] {
  return result.monthly[line].map(Number);
}

/** Finds a placed cell by its registry key. */
function cellFor(workbook: WorkbookModel, key: string): CellSpec & { sheet: string } {
  for (const sheet of workbook.sheets) {
    const found = sheet.cells.find((cell) => cell.key === key);
    if (found) return found;
  }
  throw new Error(`No cell registered under ${key}.`);
}

/** The formula text a cell would emit, resolved from its own sheet. */
function formulaFor(workbook: WorkbookModel, key: string): string {
  const cell = cellFor(workbook, key);
  if (cell.kind !== 'formula' || !cell.formula) {
    throw new Error(`${key} is ${cell.kind}, not a formula.`);
  }
  return cell.formula(workbook.resolver(cell.sheet));
}

describe('the workbook builds', () => {
  it('produces the phase 2 sheets and can be serialised and reopened', async () => {
    const { input, result } = fixture('multiTenantOffice');
    const { workbook, coverage } = buildLiveModel(input, result);

    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual([
      'Summary',
      'Assumptions',
      'Rent Roll',
      'Recoveries',
      'Revenue',
      'Expenses',
      'Cash Flow',
      'Returns',
    ]);

    const buffer = await renderWorkbook(workbook);
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(reopened.worksheets.map((sheet) => sheet.name)).toContain('Cash Flow');

    // The metric is only useful if it is not trivially 100%: the lease-engine
    // lines are meant to show up as gaps.
    expect(coverage.formulaCells).toBeGreaterThan(0);
    expect(coverage.staticDerivedCells).toBeGreaterThan(0);
    expect(coverage.formulaCoverage).toBeGreaterThan(0.5);
  });

  it('builds every regression fixture without a broken reference', () => {
    // A missing key throws at build time, so this is a structural check across
    // all twenty properties: no formula names a cell that does not exist.
    for (const name of Object.keys(ALL_FIXTURES)) {
      const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
      const { workbook } = buildLiveModel(input, result);
      for (const sheet of workbook.sheets) {
        for (const cell of sheet.cells) {
          if (cell.kind === 'formula' && cell.formula) {
            expect(() => cell.formula?.(workbook.resolver(sheet.name))).not.toThrow();
          }
        }
      }
    }
  });

  it('refuses a model with no periods rather than writing an empty workbook', () => {
    const { input, result } = fixture('singleTenantIndustrial');
    expect(() => buildLiveModel(input, { ...result, periods: [] })).toThrow(/no forecast periods/);
  });
});

describe('the identities the formulas encode hold in the engine', () => {
  const { input, result } = fixture('multiTenantOffice');
  const n = result.periods.length;

  it('contractual base rent is potential less absorption', () => {
    const potential = series(result, 'potentialBaseRent');
    const absorption = series(result, 'absorptionAndTurnoverVacancy');
    const contractual = series(result, 'contractualBaseRent');
    for (let i = 0; i < n; i += 1) {
      // The absorption line is stored negative, so the workbook adds it.
      expect(
        Math.abs((potential[i] ?? 0) + (absorption[i] ?? 0) - (contractual[i] ?? 0)),
      ).toBeLessThanOrEqual(SUM_TOLERANCE);
    }
  });

  it('scheduled base rent is contractual plus free rent, which is reported negative', () => {
    const contractual = series(result, 'contractualBaseRent');
    const free = series(result, 'freeRent');
    const scheduled = series(result, 'scheduledBaseRent');
    for (let i = 0; i < n; i += 1) {
      expect(
        Math.abs((contractual[i] ?? 0) + (free[i] ?? 0) - (scheduled[i] ?? 0)),
      ).toBeLessThanOrEqual(SUM_TOLERANCE);
    }
  });

  it('gross potential revenue is the sum of its five components', () => {
    const parts: CashFlowLine[] = [
      'scheduledBaseRent',
      'percentageRent',
      'expenseRecoveries',
      'otherLeaseRevenue',
      'otherPropertyRevenue',
    ];
    const gpr = series(result, 'grossPotentialRevenue');
    for (let i = 0; i < n; i += 1) {
      const total = parts.reduce((sum, line) => sum + (series(result, line)[i] ?? 0), 0);
      expect(Math.abs(total - (gpr[i] ?? 0))).toBeLessThanOrEqual(SUM_TOLERANCE);
    }
  });

  it('the general vacancy allowance nets off vacancy already modelled, floored at zero', () => {
    const rate = Number(input.vacancy.generalVacancyRate);
    const absorption = series(result, 'absorptionAndTurnoverVacancy');
    const vacancy = series(result, 'generalVacancy');
    const applies = new Set(input.vacancy.appliesTo);

    for (let i = 0; i < n; i += 1) {
      let base = 0;
      if (applies.has('base_rent')) base += series(result, 'scheduledBaseRent')[i] ?? 0;
      if (applies.has('recoveries')) base += series(result, 'expenseRecoveries')[i] ?? 0;
      if (applies.has('percentage_rent')) base += series(result, 'percentageRent')[i] ?? 0;
      if (applies.has('other_revenue')) {
        base += series(result, 'otherLeaseRevenue')[i] ?? 0;
        base += series(result, 'otherPropertyRevenue')[i] ?? 0;
      }
      // Negated, because the engine reports allowances as deductions.
      const expected = input.vacancy.netAgainstModelledVacancy
        ? -Math.max(base * rate + (absorption[i] ?? 0), 0)
        : -(base * rate);
      expect(Math.abs(expected - (vacancy[i] ?? 0))).toBeLessThanOrEqual(SUM_TOLERANCE);
    }
  });

  it('effective gross revenue, NOI and unlevered cash flow follow their subtractions', () => {
    const gpr = series(result, 'grossPotentialRevenue');
    const vacancy = series(result, 'generalVacancy');
    const credit = series(result, 'creditLoss');
    const egr = series(result, 'effectiveGrossRevenue');
    const opex = series(result, 'operatingExpenses');
    const noi = series(result, 'netOperatingIncome');
    const ti = series(result, 'tenantImprovements');
    const lc = series(result, 'leasingCommissions');
    const capex = series(result, 'capitalExpenditures');
    const ucf = series(result, 'unleveredCashFlow');

    for (let i = 0; i < n; i += 1) {
      // Every deduction is already negative on the way out of the engine, so
      // each subtotal is an addition. This is the convention the workbook uses.
      expect(
        Math.abs((gpr[i] ?? 0) + (vacancy[i] ?? 0) + (credit[i] ?? 0) - (egr[i] ?? 0)),
      ).toBeLessThanOrEqual(SUM_TOLERANCE);
      expect(Math.abs((egr[i] ?? 0) + (opex[i] ?? 0) - (noi[i] ?? 0))).toBeLessThanOrEqual(
        SUM_TOLERANCE,
      );
      expect(
        Math.abs((noi[i] ?? 0) + (ti[i] ?? 0) + (lc[i] ?? 0) + (capex[i] ?? 0) - (ucf[i] ?? 0)),
      ).toBeLessThanOrEqual(SUM_TOLERANCE);
    }
  });
});

describe('cached values match the engine', () => {
  it('every cached figure equals the engine series it came from', () => {
    const { input, result } = fixture('multiTenantOffice');
    const { workbook } = buildLiveModel(input, result);

    const checks: Array<{ key: string; line: CashFlowLine }> = [
      { key: 'revenue.scheduledBaseRent', line: 'scheduledBaseRent' },
      { key: 'revenue.grossPotentialRevenue', line: 'grossPotentialRevenue' },
      { key: 'revenue.generalVacancy', line: 'generalVacancy' },
      { key: 'recoveries.total', line: 'expenseRecoveries' },
      { key: 'revenue.expenseRecoveries', line: 'expenseRecoveries' },
      { key: 'revenue.effectiveGrossRevenue', line: 'effectiveGrossRevenue' },
      { key: 'expenses.total', line: 'operatingExpenses' },
      { key: 'cashFlow.netOperatingIncome', line: 'netOperatingIncome' },
      { key: 'cashFlow.unleveredCashFlow', line: 'unleveredCashFlow' },
    ];

    for (const check of checks) {
      const expected = series(result, check.line);
      for (let period = 0; period < result.periods.length; period += 1) {
        const cell = cellFor(workbook, `${check.key}#${period}`);
        expect(
          Math.abs(Number(cell.cachedValue) - (expected[period] ?? 0)),
          `${check.key}#${period}`,
        ).toBeLessThanOrEqual(CENT);
      }
    }
  });
});

describe('the model is formula-driven, not a report', () => {
  const { input, result } = fixture('multiTenantOffice');
  const { workbook } = buildLiveModel(input, result);

  it('major calculated lines are formulas, not pasted numbers', () => {
    // This is the test that fails if somebody later replaces a formula with the
    // number it happened to produce.
    for (const key of [
      'revenue.contractualBaseRent#0',
      'revenue.scheduledBaseRent#0',
      'revenue.grossPotentialRevenue#0',
      'revenue.generalVacancy#0',
      'revenue.effectiveGrossRevenue#0',
      'expenses.total#0',
      'cashFlow.netOperatingIncome#0',
      'cashFlow.unleveredCashFlow#0',
      'cashFlow.leveredCashFlow#0',
      'returns.grossSalePrice',
      'returns.unleveredXirr',
      'returns.leveredXirr',
      'returns.equityMultiple',
    ]) {
      expect(cellFor(workbook, key).kind, key).toBe('formula');
    }
  });

  it('links cash flow to the schedules rather than recalculating them', () => {
    expect(formulaFor(workbook, 'cashFlow.effectiveGrossRevenue#5')).toMatch(/^Revenue!/);
    expect(formulaFor(workbook, 'cashFlow.operatingExpenses#5')).toMatch(/^Expenses!/);
    // NOI adds two cells on its own sheet rather than restating the revenue
    // stack — an addition, not a subtraction, because operating expenses are
    // already negative in the engine's reporting convention.
    expect(formulaFor(workbook, 'cashFlow.netOperatingIncome#5')).toMatch(/^[A-Z]+\d+\+[A-Z]+\d+$/);
  });

  it('links returns to the cash flow', () => {
    expect(formulaFor(workbook, 'returns.terminalNoi')).toContain("'Cash Flow'!");
    expect(formulaFor(workbook, 'returns.unleveredXirr')).toContain('XIRR(');
  });

  it('drives the exit valuation from the exit cap rate', () => {
    // The dependency the user actually tests first: change the cap rate, the
    // sale price moves.
    expect(formulaFor(workbook, 'returns.grossSalePrice')).toContain('ExitCapRate');
    expect(formulaFor(workbook, 'returns.sellingCosts')).toContain('SellingCosts');
  });

  it('drives vacancy from the vacancy assumptions', () => {
    expect(formulaFor(workbook, 'revenue.generalVacancy#12')).toContain('GeneralVacancy');
    expect(formulaFor(workbook, 'revenue.creditLoss#12')).toContain('CreditLoss');
  });

  it('drives expense growth from the growth curve, which is itself a formula', () => {
    const growing = input.expenses.find((expense) => expense.growthCurveId);
    if (!growing) return;
    // Month 12 is the first period the curve steps, so it is where a broken
    // growth chain would show.
    const expenseFormula = formulaFor(workbook, `expenses.${growing.id}#12`);
    expect(expenseFormula).toContain('Assumptions!');
    const factor = formulaFor(workbook, `curve.${growing.growthCurveId}.factor#12`);
    expect(factor).toMatch(/\*\(1\+/);
  });

  it('computes the growth factor as the engine does', () => {
    // Period 0 is 1.0, periods 1..11 hold, period 12 steps once.
    const curve = input.growthCurves[0];
    if (!curve) return;
    expect(formulaFor(workbook, `curve.${curve.id}.factor#0`)).toBe('1');
    expect(formulaFor(workbook, `curve.${curve.id}.factor#5`)).toMatch(/^[A-Z]+\d+$/);
    expect(formulaFor(workbook, `curve.${curve.id}.factor#12`)).toMatch(/\*\(1\+/);
  });
});

describe('structural soundness', () => {
  it('has no duplicate sheet names and every defined name points somewhere', async () => {
    const { input, result } = fixture('multiTenantOffice');
    const { workbook } = buildLiveModel(input, result);

    const names = workbook.sheets.map((sheet) => sheet.name);
    expect(new Set(names).size).toBe(names.length);

    for (const entry of workbook.definedNameEntries()) {
      // A defined name must resolve to a real sheet, or the workbook opens
      // with every formula using it showing #REF!.
      const sheetName = entry.ref.split('!')[0]?.replace(/^'|'$/g, '');
      expect(names).toContain(sheetName);
    }
  });

  it('emits no formula that names a sheet the workbook does not have', () => {
    const { input, result } = fixture('developmentProject');
    const { workbook } = buildLiveModel(input, result);
    const names = new Set(workbook.sheets.map((sheet) => sheet.name));

    for (const sheet of workbook.sheets) {
      for (const cell of sheet.cells) {
        if (cell.kind !== 'formula' || !cell.formula) continue;
        const text = cell.formula(workbook.resolver(sheet.name));
        for (const match of text.matchAll(/'([^']+)'!|(\b[A-Za-z_][A-Za-z0-9_]*)!/g)) {
          const referenced = match[1] ?? match[2];
          if (referenced !== undefined) expect(names).toContain(referenced);
        }
      }
    }
  });

  it('never emits a #REF!', () => {
    const { input, result } = fixture('multiTenantOffice');
    const { workbook } = buildLiveModel(input, result);
    for (const sheet of workbook.sheets) {
      for (const cell of sheet.cells) {
        if (cell.kind !== 'formula' || !cell.formula) continue;
        expect(cell.formula(workbook.resolver(sheet.name))).not.toContain('#REF');
      }
    }
  });
});

describe('filenames', () => {
  it('is safe on every platform', () => {
    const on = new Date('2026-08-06T12:00:00Z');
    expect(liveModelFilename('Harbour Point', 'Base case', on)).toBe(
      'Harbour_Point_Base_case_2026-08-06.xlsx',
    );
    // A slash must not become a path separator.
    expect(liveModelFilename('Q1/Q2 Portfolio', '', on)).toBe('Q1Q2_Portfolio_2026-08-06.xlsx');
    expect(liveModelFilename('', '', on)).toBe('Model_2026-08-06.xlsx');
    expect(liveModelFilename('../../etc/passwd', '', on)).toBe('etcpasswd_2026-08-06.xlsx');
  });
});

describe('coverage reporting', () => {
  it('counts the lease-engine lines as the gap they are', () => {
    const { input, result } = fixture('multiTenantOffice');
    const { workbook, coverage } = buildLiveModel(input, result);

    // Per-lease rent comes from the leasing simulation and cannot be a formula
    // without duplicating it. It must be reported as a gap, not hidden.
    expect(cellFor(workbook, 'rentRoll.base.0#0').kind).toBe('staticDerived');
    expect(cellFor(workbook, 'recoveries.lease.0#0').kind).toBe('staticDerived');
    expect(coverage.staticDerivedCells).toBeGreaterThan(0);
    expect(coverage.calculatedCells).toBe(coverage.formulaCells + coverage.staticDerivedCells);
  });
});

describe('a model with no expenses', () => {
  it('still totals to zero rather than emitting an empty formula', () => {
    const { input } = fixture('singleTenantIndustrial');
    const stripped: ModelInput = { ...input, expenses: [] };
    const { workbook } = buildLiveModel(stripped, calculate(stripped));
    expect(formulaFor(workbook, 'expenses.total#0')).toBe('0');
  });
});

describe('rounding', () => {
  it('keeps cached values within a cent of the engine', () => {
    const { input, result } = fixture('groceryAnchoredRetail');
    const { workbook } = buildLiveModel(input, result);
    const noi = series(result, 'netOperatingIncome');
    for (let period = 0; period < result.periods.length; period += 1) {
      const cached = Number(cellFor(workbook, `cashFlow.netOperatingIncome#${period}`).cachedValue);
      expect(Math.abs(cached - (noi[period] ?? 0))).toBeLessThan(CENT);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Reconciliation, by evaluating the formulas the exporter emits               */
/* -------------------------------------------------------------------------- */

describe('the emitted formulas reproduce the engine', () => {
  /**
   * This is the reconciliation that counts.
   *
   * The identity tests above check the engine against itself and, as a probe
   * proved, keep passing when a formula's sign is wrong. These evaluate the
   * formula text this exporter actually produces — through the same references
   * Excel would follow — and compare the result to the engine.
   */
  const reconciled: Array<{ key: string; line: CashFlowLine }> = [
    { key: 'rentRoll.totalBaseRent', line: 'contractualBaseRent' },
    { key: 'revenue.contractualBaseRent', line: 'contractualBaseRent' },
    { key: 'revenue.potentialBaseRent', line: 'potentialBaseRent' },
    { key: 'revenue.scheduledBaseRent', line: 'scheduledBaseRent' },
    { key: 'revenue.grossPotentialRevenue', line: 'grossPotentialRevenue' },
    { key: 'revenue.generalVacancy', line: 'generalVacancy' },
    { key: 'revenue.creditLoss', line: 'creditLoss' },
    { key: 'recoveries.total', line: 'expenseRecoveries' },
    { key: 'revenue.expenseRecoveries', line: 'expenseRecoveries' },
    { key: 'revenue.effectiveGrossRevenue', line: 'effectiveGrossRevenue' },
    { key: 'expenses.total', line: 'operatingExpenses' },
    { key: 'cashFlow.netOperatingIncome', line: 'netOperatingIncome' },
    { key: 'cashFlow.unleveredCashFlow', line: 'unleveredCashFlow' },
  ];

  for (const name of ['singleTenantIndustrial', 'multiTenantOffice', 'baseYearRecovery'] as const) {
    it(`reconciles ${name} to the engine, line by line and period by period`, () => {
      const { input, result } = fixture(name);
      const { workbook } = buildLiveModel(input, result);
      const evaluator = new FormulaEvaluator(workbook);

      for (const check of reconciled) {
        const expected = series(result, check.line);
        for (let period = 0; period < result.periods.length; period += 1) {
          const actual = evaluator.value(check.key, period);
          expect(Number.isFinite(actual), `${check.key}#${period} did not evaluate`).toBe(true);
          expect(
            Math.abs(actual - (expected[period] ?? 0)),
            `${check.key}#${period}: workbook ${actual} vs engine ${expected[period]}`,
          ).toBeLessThanOrEqual(SUM_TOLERANCE);
        }
      }
    });
  }

  it('reconciles the exit valuation to the engine', () => {
    const { input, result } = fixture('multiTenantOffice');
    const { workbook } = buildLiveModel(input, result);
    const evaluator = new FormulaEvaluator(workbook);

    const sale = result.monthly.grossSaleProceeds.map(Number).find((value) => value !== 0);
    if (sale === undefined) return;
    /*
     * Relative, not absolute. Terminal value is twelve monthly NOI figures —
     * each rounded to cents by the engine — divided by a cap rate, so the
     * rounding is divided by the cap rate too: six cents of NOI error becomes
     * about a dollar of value at a 6% cap. An absolute tolerance would be
     * tightened or loosened by the cap rate rather than by correctness.
     */
    const actual = evaluator.value('returns.grossSalePrice');
    expect(Math.abs(actual - sale) / sale).toBeLessThan(1e-5);
  });

  it('moves downstream figures when an assumption changes', () => {
    // The behaviour the whole feature exists for, checked mechanically:
    // raise the exit cap rate and the sale price must fall.
    const { input, result } = fixture('multiTenantOffice');
    const { workbook } = buildLiveModel(input, result);

    const capRateCell = cellFor(workbook, 'assumptions.exitCapRate');
    const before = new FormulaEvaluator(workbook).value('returns.grossSalePrice');

    capRateCell.value = Number(capRateCell.value) * 2;
    const after = new FormulaEvaluator(workbook).value('returns.grossSalePrice');

    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    // Halving the value for a doubled cap rate is the arithmetic of the
    // formula, so this also proves nothing intervened.
    expect(after).toBeCloseTo(before / 2, 4);
  });

  it('moves net operating income when the expense growth rate changes', () => {
    const { input, result } = fixture('multiTenantOffice');
    const curve = input.growthCurves[0];
    if (!curve) return;
    const { workbook } = buildLiveModel(input, result);

    const lastPeriod = result.periods.length - 1;
    const before = new FormulaEvaluator(workbook).value('cashFlow.netOperatingIncome', lastPeriod);

    // Year 5's rate, which the cumulative factor compounds into every later
    // month. A broken growth chain would leave NOI unchanged.
    const rateCell = cellFor(workbook, `curve.${curve.id}.rate#5`);
    rateCell.value = Number(rateCell.value) + 0.05;
    const after = new FormulaEvaluator(workbook).value('cashFlow.netOperatingIncome', lastPeriod);

    expect(after).not.toBeCloseTo(before, 2);
    // Expenses rose, so NOI must fall.
    expect(after).toBeLessThan(before);
  });
});

/**
 * Math Check I — Excel Live Model reconciliation at institutional scale
 * (`docs/commercial-gap-analysis.md` item 13, operating expense library).
 *
 * The same reconciliation as "the emitted formulas reproduce the engine"
 * above, run on a fixture with a hundreds-of-millions expense and a
 * multi-hundred-million recovery pool, so a workbook that only reconciles at
 * ordinary regression-fixture magnitudes would not pass this silently. No
 * value here is rounded to thousands to make it reconcile — `SUM_TOLERANCE`
 * (a few cents, from independent per-line rounding) is the only slack.
 */
describe('the emitted formulas reproduce the engine at institutional scale', () => {
  function largeExpenseFixture(): { input: ModelInput; result: ModelResult } {
    const input = parseModelInput({
      modelId: 'math-i-large-expense',
      modelName: 'Math Check I fixture',
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      property: {
        id: 'P1',
        name: 'Math I property',
        propertyType: 'industrial',
        rentableArea: '10000000',
      },
      spaces: [{ id: 'S1', code: 'Building A', area: '10000000', spaceType: 'warehouse' }],
      tenants: [{ id: 'T1', name: 'Math I Tenant', industry: 'Logistics' }],
      leases: [
        {
          id: 'L1',
          tenantId: 'T1',
          spaceIds: ['S1'],
          status: 'occupied',
          area: '10000000',
          commencementDate: '2026-01-01',
          expirationDate: '2035-12-31',
          baseRent: '20',
          baseRentBasis: 'per_area_per_year',
          recovery: { method: 'triple_net' },
          excludeFromRollover: true,
        },
      ],
      expenses: [
        {
          id: 'E1',
          name: 'Large partly-recoverable expense',
          category: 'operating',
          method: 'fixed_annual',
          amount: '600000000',
          recoverableShare: '0.8',
          variableShare: '0.3',
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
      },
    });
    return { input, result: calculate(input) };
  }

  const reconciled: Array<{ key: string; line: CashFlowLine }> = [
    { key: 'revenue.scheduledBaseRent', line: 'scheduledBaseRent' },
    { key: 'recoveries.total', line: 'expenseRecoveries' },
    { key: 'revenue.expenseRecoveries', line: 'expenseRecoveries' },
    { key: 'revenue.effectiveGrossRevenue', line: 'effectiveGrossRevenue' },
    { key: 'expenses.total', line: 'operatingExpenses' },
    { key: 'cashFlow.netOperatingIncome', line: 'netOperatingIncome' },
    { key: 'cashFlow.unleveredCashFlow', line: 'unleveredCashFlow' },
  ];

  it('reconciles a $600,000,000 partly-recoverable expense and its $480,000,000 recovery pool, line by line and period by period', () => {
    const { input, result } = largeExpenseFixture();
    const { workbook } = buildLiveModel(input, result);
    const evaluator = new FormulaEvaluator(workbook);

    for (const check of reconciled) {
      const expected = series(result, check.line);
      for (let period = 0; period < result.periods.length; period += 1) {
        const actual = evaluator.value(check.key, period);
        expect(Number.isFinite(actual), `${check.key}#${period} did not evaluate`).toBe(true);
        expect(
          Math.abs(actual - (expected[period] ?? 0)),
          `${check.key}#${period}: workbook ${actual} vs engine ${expected[period]}`,
        ).toBeLessThanOrEqual(SUM_TOLERANCE);
      }
    }
  });

  it('does not lose precision to Excel-style scientific notation on any evaluated cell', () => {
    const { input, result } = largeExpenseFixture();
    const { workbook } = buildLiveModel(input, result);
    const evaluator = new FormulaEvaluator(workbook);

    for (const check of reconciled) {
      for (let period = 0; period < result.periods.length; period += 1) {
        const actual = evaluator.value(check.key, period);
        expect(Number.isFinite(actual)).toBe(true);
        // A value corrupted into exponential form would still be "finite" by
        // JS's own definition, so this checks the number itself is exactly
        // representable rather than merely non-NaN/non-Infinity.
        expect(Number.isSafeInteger(Math.round(actual * 100))).toBe(true);
      }
    }
  });
});

describe('the debt schedule amortises in the workbook', () => {
  /** Every regression fixture that carries a facility. */
  const withDebt = Object.keys(ALL_FIXTURES).filter(
    (name) => ALL_FIXTURES[name as keyof typeof ALL_FIXTURES]!().debt.length > 0,
  );

  it('covers the debt shapes that matter', () => {
    // Guards the loop below: if the fixtures ever stop including an amortising
    // loan, a floating one and one that capitalises interest, these tests would
    // quietly stop proving what they claim to.
    const inputs = withDebt.map((name) => ALL_FIXTURES[name as keyof typeof ALL_FIXTURES]!());
    expect(inputs.some((input) => input.debt.some((f) => f.amortizationMonths > 0))).toBe(true);
    expect(inputs.some((input) => input.debt.some((f) => f.rateType === 'floating'))).toBe(true);
    expect(inputs.some((input) => input.debt.some((f) => f.capitalizeInterest))).toBe(true);
  });

  for (const name of withDebt) {
    it(`reconciles ${name}: balance, interest, principal and payoff`, () => {
      const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
      const { workbook } = buildLiveModel(input, result);
      const evaluator = new FormulaEvaluator(workbook);

      for (let period = 0; period < result.periods.length; period += 1) {
        const engineBalance = input.debt.reduce((sum, facility) => {
          const schedule = result.debtSchedules.find((s) => s.facilityId === facility.id);
          return sum + Number(schedule?.rows[period]?.endingBalance ?? '0');
        }, 0);

        expect(
          Math.abs(evaluator.value('debt.endingBalance', period) - engineBalance),
          `ending balance at ${period}`,
        ).toBeLessThanOrEqual(SUM_TOLERANCE);

        for (const [key, line] of [
          ['debt.interest', 'interestExpense'],
          ['debt.principal', 'principalAmortization'],
          ['debt.payoffSigned', 'debtPayoff'],
          ['debt.proceeds', 'debtProceeds'],
        ] as Array<[string, CashFlowLine]>) {
          expect(
            Math.abs(evaluator.value(key, period) - (series(result, line)[period] ?? 0)),
            `${key} at ${period}`,
          ).toBeLessThanOrEqual(SUM_TOLERANCE);
        }
      }
    });
  }

  it('never shows a facility as active when its funding date falls after the whole forecast', () => {
    /*
     * The engine's own fundingIndex (an unclamped month offset from the
     * forecast start) leaves this facility inactive in every period, drawing
     * nothing and charging nothing — exactly the same standard as the
     * capped-rate test below: the modified input is run back through the
     * engine, and the workbook is reconciled to *that* real schedule, not to
     * a number worked out by hand.
     */
    const { input } = fixture('refinanceScenario');
    const facility = input.debt[0];
    if (!facility) return;
    const neverFunded: ModelInput = {
      ...input,
      debt: input.debt.map((entry, index) =>
        index === 0 ? { ...entry, fundingDate: '2099-01-01' } : entry,
      ),
    };
    const neverFundedResult = calculate(neverFunded);
    const { workbook } = buildLiveModel(neverFunded, neverFundedResult);
    const evaluator = new FormulaEvaluator(workbook);

    const schedule = neverFundedResult.debtSchedules.find((s) => s.facilityId === facility.id);
    expect(schedule).toBeDefined();
    // The premise of the test: the engine really does leave this schedule at
    // zero throughout, not merely close to it.
    expect(schedule?.rows.every((row) => Number(row.endingBalance) === 0)).toBe(true);

    for (let period = 0; period < neverFundedResult.periods.length; period += 1) {
      const expected = Number(schedule?.rows[period]?.endingBalance ?? '0');
      expect(
        evaluator.value(`debt.ending.${facility.id}`, period),
        `ending balance at period ${period}`,
      ).toBeCloseTo(expected, 6);
      expect(
        evaluator.value(`debt.accrued.${facility.id}`, period),
        `accrued interest at period ${period}`,
      ).toBeCloseTo(0, 6);
    }
  });

  it('moves interest, and therefore levered cash flow, when the rate changes', () => {
    // The dependency chain the feature is judged on.
    const { input, result } = fixture('refinanceScenario');
    const { workbook } = buildLiveModel(input, result);
    const facility = input.debt[0];
    if (!facility) return;

    const period = 6;
    const before = {
      interest: new FormulaEvaluator(workbook).value('debt.interest', period),
      levered: new FormulaEvaluator(workbook).value('cashFlow.leveredCashFlow', period),
    };

    const rateCell = cellFor(workbook, `debt.${facility.id}.fixedRate`);
    rateCell.value = Number(rateCell.value) + 0.02;

    const after = {
      interest: new FormulaEvaluator(workbook).value('debt.interest', period),
      levered: new FormulaEvaluator(workbook).value('cashFlow.leveredCashFlow', period),
    };

    // Interest is reported negative, so a higher rate makes it more negative.
    expect(after.interest).toBeLessThan(before.interest);
    expect(after.levered).toBeLessThan(before.levered);
  });

  it('keeps the balance rolling forward: ending equals beginning plus draws less principal', () => {
    const { input, result } = fixture('refinanceScenario');
    const { workbook } = buildLiveModel(input, result);
    const evaluator = new FormulaEvaluator(workbook);
    const facility = input.debt[0];
    if (!facility) return;

    for (let period = 1; period < result.periods.length; period += 1) {
      const previousEnding = evaluator.value(`debt.ending.${facility.id}`, period - 1);
      const beginning = evaluator.value(`debt.beginning.${facility.id}`, period);
      expect(Math.abs(beginning - previousEnding), `roll-forward at ${period}`).toBeLessThan(1e-6);
    }
  });
});

describe('the model checks on the Summary sheet', () => {
  /**
   * Each check is a difference that must be near zero. Evaluating the
   * difference cells proves the workbook is internally consistent — that
   * revenue really does roll into cash flow, that the rent roll really does
   * total to contractual base rent, and that the debt is actually retired.
   *
   * A check that always reads OK proves nothing, so the probe below breaks one
   * deliberately and confirms it trips.
   */
  const checkKeys = [
    'check.revenueRolls',
    'check.expensesRoll',
    'check.rentRollRolls',
    'check.noi',
    'check.saleOnce',
  ];

  for (const name of ['multiTenantOffice', 'refinanceScenario', 'developmentProject'] as const) {
    it(`every check reads OK for ${name}`, () => {
      const { input, result } = fixture(name);
      const { workbook } = buildLiveModel(input, result);
      const evaluator = new FormulaEvaluator(workbook);

      const keys = [...checkKeys];
      if (input.debt.length > 0) keys.push('check.debtRepaid', 'check.debtBalances');

      for (const key of keys) {
        const difference = evaluator.value(`${key}.difference`);
        expect(Number.isFinite(difference), `${key} did not evaluate`).toBe(true);
        // The sale check and the debt checks carry a wider tolerance in the
        // workbook itself; a dollar covers all of them.
        expect(Math.abs(difference), `${key} is off by ${difference}`).toBeLessThanOrEqual(1);
      }
    });
  }

  it('a check trips when the thing it checks is broken', () => {
    const { input, result } = fixture('multiTenantOffice');
    const { workbook } = buildLiveModel(input, result);

    // Corrupt one lease's rent. The rent-roll check compares the sum of the
    // leases against contractual base rent, which links to that same sum, so
    // the check that must move is NOI — revenue now disagrees with itself
    // downstream. Use the cash-flow roll-up check instead, which compares two
    // independently reached totals.
    const before = new FormulaEvaluator(workbook).value('check.expensesRoll.difference');
    expect(Math.abs(before)).toBeLessThanOrEqual(1);

    // Break the link: make cash flow's expense line ignore the Expenses sheet.
    const cell = cellFor(workbook, 'cashFlow.operatingExpenses#0');
    cell.formula = () => '0';

    const after = new FormulaEvaluator(workbook).value('check.expensesRoll.difference');
    expect(Math.abs(after)).toBeGreaterThan(1);
  });
});

describe('the recovery settlement is calculated, not imported', () => {
  /** Fixtures whose recoveries actually exercise the build-up. */
  const withRecoveries = Object.keys(ALL_FIXTURES).filter((name) => {
    const { result } = fixture(name as keyof typeof ALL_FIXTURES);
    return result.recoveryDetail.length > 0;
  });

  it('covers base-year, expense-stop, multi-pool and reconciled structures', () => {
    // A guard on the loop below: these are the shapes the build-up must handle,
    // and the expense stop is the one that proved the subtraction order.
    expect(withRecoveries).toEqual(
      expect.arrayContaining([
        'baseYearRecovery',
        'expenseStopRecovery',
        'multiplePoolRecovery',
        'reconciledRecovery',
      ]),
    );
  });

  for (const name of withRecoveries) {
    it(`reconciles the ${name} settlement, row by row`, () => {
      const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
      const { workbook } = buildLiveModel(input, result);
      const evaluator = new FormulaEvaluator(workbook);

      for (const [index, detail] of result.recoveryDetail.entries()) {
        const key = `recovery.${index}`;
        // The whole build-up, now that the admin-fee placement and the
        // zero floor are understood. `fixed_amount` rows import instead.
        const checks: Array<[string, number]> = [
          ['share', Number(detail.proRataShare)],
          ['adminFee', Number(detail.adminFee)],
          ['beforeCaps', Number(detail.recoveryBeforeCaps)],
          ['finalRecovery', Number(detail.finalRecovery)],
          ['trueUp', Number(detail.trueUpAmount)],
        ];
        for (const [suffix, expected] of checks) {
          const actual = evaluator.value(`${key}.${suffix}`);
          expect(Number.isFinite(actual), `${key}.${suffix} did not evaluate`).toBe(true);
          expect(
            Math.abs(actual - expected),
            `${key}.${suffix}: workbook ${actual} vs engine ${expected}`,
          ).toBeLessThanOrEqual(SUM_TOLERANCE);
        }
      }
    });
  }

  it('moves the share when a tenant area changes', () => {
    const { input, result } = fixture('expenseStopRecovery');
    const { workbook } = buildLiveModel(input, result);

    const before = new FormulaEvaluator(workbook).value('recovery.0.share');
    const areaCell = cellFor(workbook, 'recovery.0.tenantArea');
    areaCell.value = Number(areaCell.value) * 2;
    const after = new FormulaEvaluator(workbook).value('recovery.0.share');

    expect(after).toBeCloseTo(before * 2, 10);
  });

  it('does not add the admin fee twice', () => {
    /*
     * The bug that made triple-net recoveries look like a 1.15x mystery. The
     * engine reports `entitlement + adminFee` as "before caps", so the final
     * recovery adds only the cap adjustment. Pinned because the double-count
     * is invisible on every fixture whose admin fee is zero.
     */
    const { input, result } = fixture('groceryAnchoredRetail');
    const { workbook } = buildLiveModel(input, result);

    const withFee = result.recoveryDetail.findIndex((d) => Number(d.adminFee) !== 0);
    expect(withFee, 'no fixture row carries an admin fee').toBeGreaterThanOrEqual(0);

    const formula = formulaFor(workbook, `recovery.${withFee}.finalRecovery`);
    expect(formula).not.toContain(
      workbook.resolver('Recoveries').ref(`recovery.${withFee}.adminFee`),
    );

    const evaluator = new FormulaEvaluator(workbook);
    expect(
      Math.abs(
        evaluator.value(`recovery.${withFee}.finalRecovery`) -
          Number(result.recoveryDetail[withFee]?.finalRecovery),
      ),
    ).toBeLessThanOrEqual(SUM_TOLERANCE);
  });

  it('floors the entitlement at zero', () => {
    // A pool below the stop recovers nothing; it must not credit the tenant.
    const { input, result } = fixture('expenseStopRecovery');
    const { workbook } = buildLiveModel(input, result);
    expect(formulaFor(workbook, 'recovery.0.entitlement')).toMatch(/^MAX\(/);
  });
});

describe('the sensitivity chain a reader will actually try', () => {
  /**
   * The four movements the feature was specified against. Each raises an
   * assumption and checks the figures downstream of it move — and, where the
   * direction is determined, that they move the right way.
   */
  const { input, result } = fixture('refinanceScenario');
  const last = result.periods.length - 1;

  function reading(workbook: WorkbookModel) {
    const evaluator = new FormulaEvaluator(workbook);
    return {
      revenue: evaluator.value('revenue.effectiveGrossRevenue', last),
      noi: evaluator.value('cashFlow.netOperatingIncome', last),
      levered: evaluator.value('cashFlow.leveredCashFlow', last),
      sale: evaluator.value('returns.grossSalePrice'),
    };
  }

  it('rent growth moves revenue, NOI and the sale price', () => {
    // The one that did not work before the sensitivity lever existed.
    const { workbook } = buildLiveModel(input, result);
    const before = reading(workbook);

    const cell = cellFor(workbook, 'assumptions.rentGrowthSensitivity');
    expect(cell.value, 'must default to zero so the export still reconciles').toBe(0);
    cell.value = 0.03;

    const after = reading(workbook);
    expect(after.revenue).toBeGreaterThan(before.revenue);
    expect(after.noi).toBeGreaterThan(before.noi);
    expect(after.sale).toBeGreaterThan(before.sale);
  });

  it('expense growth moves NOI and the sale price, and lowers them', () => {
    const curve = input.growthCurves[0];
    if (!curve) return;
    const { workbook } = buildLiveModel(input, result);
    const before = reading(workbook);

    const cell = cellFor(workbook, `curve.${curve.id}.rate#3`);
    cell.value = Number(cell.value) + 0.05;

    const after = reading(workbook);
    // Higher expenses, so NOI falls and the value with it.
    expect(after.noi).toBeLessThan(before.noi);
    expect(after.sale).toBeLessThan(before.sale);
  });

  it('the interest rate moves levered cash flow but leaves NOI alone', () => {
    const facility = input.debt[0];
    if (!facility) return;

    /*
     * Measured where the loan is actually outstanding, not at the last period.
     * This facility matures inside the forecast, so at the final month its
     * interest is zero and raising the rate moves nothing — the first version
     * of this test failed for that reason, which was the test looking in the
     * wrong place rather than the model being wrong.
     */
    const live = series(result, 'interestExpense').findIndex((value) => value !== 0);
    expect(live, 'no period carries interest').toBeGreaterThanOrEqual(0);

    const { workbook } = buildLiveModel(input, result);
    const at = (wb: WorkbookModel, key: string) => new FormulaEvaluator(wb).value(key, live);

    const beforeLevered = at(workbook, 'cashFlow.leveredCashFlow');
    const beforeNoi = at(workbook, 'cashFlow.netOperatingIncome');

    const cell = cellFor(workbook, `debt.${facility.id}.fixedRate`);
    cell.value = Number(cell.value) + 0.02;

    expect(at(workbook, 'cashFlow.leveredCashFlow')).toBeLessThan(beforeLevered);
    // Debt is not an operating cost: NOI must not budge.
    expect(at(workbook, 'cashFlow.netOperatingIncome')).toBeCloseTo(beforeNoi, 6);
  });

  it('the exit cap rate moves the sale price but leaves operations alone', () => {
    const { workbook } = buildLiveModel(input, result);
    const before = reading(workbook);

    const cell = cellFor(workbook, 'assumptions.exitCapRate');
    cell.value = Number(cell.value) * 1.5;

    const after = reading(workbook);
    expect(after.sale).toBeLessThan(before.sale);
    expect(after.noi).toBeCloseTo(before.noi, 6);
  });

  it('leaves the model untouched at its defaults', () => {
    // The lever only earns its place if the exported workbook still equals the
    // platform when nobody has touched it.
    const { workbook } = buildLiveModel(input, result);
    const evaluator = new FormulaEvaluator(workbook);
    for (let period = 0; period < result.periods.length; period += 1) {
      expect(evaluator.value('rentRoll.sensitivityFactor', period)).toBe(1);
      expect(
        Math.abs(
          evaluator.value('revenue.contractualBaseRent', period) -
            (series(result, 'contractualBaseRent')[period] ?? 0),
        ),
      ).toBeLessThanOrEqual(SUM_TOLERANCE);
    }
  });
});

describe('a floating rate is resolved, not imported', () => {
  const { input, result } = fixture('floatingRateDebt');
  const facility = input.debt[0];

  it('is a formula over the index curve, the spread and the floor', () => {
    if (!facility) return;
    const { workbook } = buildLiveModel(input, result);
    const cell = cellFor(workbook, `debt.rate.${facility.id}#0`);
    expect(cell.kind).toBe('formula');

    const refs = workbook.resolver('Debt');
    const resolved = cell.formula?.(refs) ?? '';
    // Absolute references, so a reader dragging the row sideways does not
    // silently walk off the assumption.
    expect(resolved).toContain(refs.absRef(`curve.${facility.indexCurveId}.rate`, 1));
    expect(resolved).toContain(refs.absRef(`debt.${facility.id}.spread`));
    expect(resolved).toMatch(/^MAX\(/);
  });

  it('applies the floor only in the years it binds', () => {
    /*
     * The fixture is built so the floor is live for part of the term and dead
     * for the rest: the index path falls from 5% to 3% while the spread is
     * 2.5% and the floor 6.5%. Years 1 and 2 clear it; years 3 and 4 do not.
     *
     * Both branches therefore matter, and asserting on only one would leave a
     * formula that ignored the floor entirely looking correct.
     */
    if (!facility) return;
    const { workbook } = buildLiveModel(input, result);
    const evaluator = new FormulaEvaluator(workbook);
    const rate = (period: number): number => evaluator.value(`debt.rate.${facility.id}`, period);

    expect(rate(0)).toBeCloseTo(0.075, 10);
    expect(rate(12)).toBeCloseTo(0.07, 10);
    expect(rate(24)).toBeCloseTo(0.065, 10);
    expect(rate(36)).toBeCloseTo(0.065, 10);
  });

  it('moves interest when the index curve moves', () => {
    /*
     * The point of the whole change. While the applied rate was an imported
     * per-period input, editing the index curve did nothing at all — the
     * workbook showed a floating loan that did not float.
     */
    if (!facility) return;
    const { workbook } = buildLiveModel(input, result);
    const live = series(result, 'interestExpense').findIndex((value) => value !== 0);
    expect(live, 'no period carries interest').toBeGreaterThanOrEqual(0);

    const at = (key: string): number => new FormulaEvaluator(workbook).value(key, live);
    const beforeInterest = at('cashFlow.interestExpense');
    const beforeNoi = at('cashFlow.netOperatingIncome');

    const year = Math.floor(live / 12) + 1;
    const cell = cellFor(workbook, `curve.${facility.indexCurveId}.rate#${year}`);
    cell.value = Number(cell.value) + 0.02;

    // Interest is stored negative, so more interest is a smaller number.
    expect(at('cashFlow.interestExpense')).toBeLessThan(beforeInterest);
    expect(at('cashFlow.netOperatingIncome')).toBeCloseTo(beforeNoi, 6);
  });

  it('caps the rate when the facility carries a cap', () => {
    /*
     * No fixture sets a cap, so the `MIN` branch would otherwise ship
     * unexercised. Rather than assert against a number worked out by hand, the
     * capped facility is run back through the engine and the workbook is
     * reconciled to *that* — the same standard as every other reconciliation
     * here, on an input the fixture set does not happen to contain.
     */
    if (!facility) return;
    const capped: ModelInput = {
      ...input,
      debt: input.debt.map((entry, index) =>
        index === 0 ? { ...entry, rateCap: '0.068' } : entry,
      ),
    };
    const cappedResult = calculate(capped);
    const { workbook } = buildLiveModel(capped, cappedResult);
    const evaluator = new FormulaEvaluator(workbook);

    const schedule = cappedResult.debtSchedules.find((s) => s.facilityId === facility.id);
    expect(schedule).toBeDefined();

    for (let period = 0; period < cappedResult.periods.length; period += 1) {
      const expected = Number(schedule?.rows[period]?.appliedRate ?? '0');
      expect(evaluator.value(`debt.rate.${facility.id}`, period), `period ${period}`).toBeCloseTo(
        expected,
        10,
      );
    }

    // And the cap actually bit: year 1 was 7.5% uncapped.
    expect(Number(schedule?.rows[0]?.appliedRate)).toBeCloseTo(0.068, 10);
  });
});

describe('every formula reproduces its own cached value', () => {
  /**
   * The broadest check in the suite, and the one that has found the most.
   *
   * Every formula cell carries the engine's figure as its cached result. If
   * evaluating the formula does not reproduce that figure, the two disagree —
   * which means either the formula is wrong or the cached value is, and Excel
   * will show one thing on open and another after recalculating.
   *
   * Unlike the hand-listed reconciliations above, this covers cells nobody
   * thought to name. It found a $2.36m error in the terminal NOI window on the
   * renewal-option fixture: a forward-twelve-month window that does not fit
   * inside the forecast falls back to trailing in the engine, but was being
   * clamped to a single month here.
   *
   * Cells whose formulas use functions outside the evaluator's subset — XIRR,
   * XNPV, SUMIF — evaluate to NaN and are skipped rather than counted.
   */
  it('across every regression fixture, cell by cell', () => {
    let checked = 0;
    const divergences: string[] = [];

    for (const name of Object.keys(ALL_FIXTURES)) {
      const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
      const { workbook } = buildLiveModel(input, result);
      const evaluator = new FormulaEvaluator(workbook);

      for (const sheet of workbook.sheets) {
        for (const cell of sheet.cells) {
          if (cell.kind !== 'formula' || typeof cell.cachedValue !== 'number') continue;

          let evaluated: number;
          try {
            evaluated = evaluator.at(sheet.name, cell.row, cell.col);
          } catch (error) {
            divergences.push(`${name} ${sheet.name} ${cell.key ?? ''} threw: ${String(error)}`);
            continue;
          }
          if (!Number.isFinite(evaluated)) continue;

          checked += 1;
          /*
           * Absolute five cents or a relative millionth, whichever is looser.
           * Money is rounded to cents line by line, so a sum of parts can miss
           * the rounded total by a few; and the sale price divides twelve such
           * figures by a cap rate, which scales that rounding up with it.
           */
          const tolerance = Math.max(0.05, Math.abs(cell.cachedValue) * 1e-6);
          if (Math.abs(evaluated - cell.cachedValue) > tolerance) {
            divergences.push(
              `${name} ${sheet.name} ${cell.key ?? `r${cell.row}c${cell.col}`}: ` +
                `cached ${cell.cachedValue} vs evaluated ${evaluated}`,
            );
          }
        }
      }
    }

    // A guard on the guard: a refactor that stopped writing cached values would
    // otherwise make this test pass by checking nothing.
    expect(checked).toBeGreaterThan(20_000);
    expect(divergences.slice(0, 10), `${divergences.length} divergences`).toEqual([]);
  });
});

describe('the terminal NOI window follows the engine', () => {
  it('falls back to trailing when a forward window does not fit', () => {
    /*
     * The engine needs twelve months after the sale for a forward basis and
     * warns when it has fewer. Clamping instead of falling back understated
     * the renewal-option sale price twelve-fold.
     */
    const { input, result } = fixture('renewalOption');
    expect(input.valuation.terminalNoiBasis).toBe('forward_12');

    const saleIndex = (input.valuation.saleMonth ?? result.periods.length) - 1;
    expect(
      result.periods.length - (saleIndex + 1),
      'fixture must not fit a forward window',
    ).toBeLessThan(12);

    const { workbook } = buildLiveModel(input, result);
    const evaluator = new FormulaEvaluator(workbook);
    const sale = result.monthly.grossSaleProceeds.map(Number).find((value) => value !== 0);
    expect(sale).toBeDefined();
    expect(
      Math.abs(evaluator.value('returns.grossSalePrice') - (sale ?? 0)) / (sale ?? 1),
    ).toBeLessThan(1e-5);
  });

  it('annualises a trailing window that runs short at the start', () => {
    // A sale early in the forecast has fewer than twelve months behind it, so
    // the engine scales rather than capitalising a part-year figure.
    const base = ALL_FIXTURES.singleTenantIndustrial!();
    const input: ModelInput = {
      ...base,
      valuation: { ...base.valuation, saleMonth: 6, terminalNoiBasis: 'trailing_12' },
    };
    const result = calculate(input);
    const { workbook } = buildLiveModel(input, result);

    expect(formulaFor(workbook, 'returns.terminalNoi')).toContain('*12/6');

    const evaluator = new FormulaEvaluator(workbook);
    const sale = result.monthly.grossSaleProceeds.map(Number).find((value) => value !== 0);
    if (sale === undefined) return;
    expect(Math.abs(evaluator.value('returns.grossSalePrice') - sale) / sale).toBeLessThan(1e-5);
  });
});

describe('the going-in cap rate follows the engine on a short forecast', () => {
  it('annualises year 1 NOI on a forecast shorter than 12 months', () => {
    /*
     * Found by a ninth audit pass: the sibling "Terminal NOI" cell above
     * already annualises a short trailing window (its own describe block,
     * above), but "Going-in cap rate" never did — reading one, un-annualised
     * year-1 window against the full acquisition basis, understating the
     * cap rate by up to 2x on a forecast shorter than a year. This is the
     * exact bug `engine.ts`'s 4.0.0 changelog entry already fixed in
     * `goingInCapRate` itself; it was never carried into this formula.
     *
     * Flat $10,000/month other revenue, no leases, no expenses, no debt, so
     * the annualised answer is unambiguous: $10,000 x 12 = $120,000/year.
     * `acquisitionCosts: '0'` keeps this isolated to the annualiser alone —
     * the cell's own denominator question is separate and not what this
     * test checks.
     */
    const input = parseModelInput({
      modelId: 'fx-going-in-cap-short-forecast',
      modelName: 'Going-in cap rate, short forecast (fixture)',
      currency: 'USD',
      areaUnit: 'sqft',
      forecast: {
        startDate: '2026-01-01',
        months: 6,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      property: {
        id: 'P1',
        name: 'Fixture Property',
        propertyType: 'office',
        rentableArea: '100000',
        unitCount: 0,
        ownershipPercent: '1',
      },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat other revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 6 }, () => '10000'),
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        acquisitionPrice: '2400000',
      },
    });
    const result = calculate(input);
    // Confirms the engine side of the comparison independently before
    // trusting the Excel formula against it: 120,000 / 2,400,000 = 5%.
    expect(Number(result.returns.goingInCapRate)).toBeCloseTo(0.05, 6);

    const { workbook } = buildLiveModel(input, result);
    expect(formulaFor(workbook, 'returns.goingInCapRate')).toContain('*12/6');

    const evaluator = new FormulaEvaluator(workbook);
    expect(evaluator.value('returns.goingInCapRate')).toBeCloseTo(0.05, 6);
  });
});

describe('the partnership waterfall', () => {
  const withWaterfall = Object.keys(ALL_FIXTURES).filter(
    (name) => fixture(name as keyof typeof ALL_FIXTURES).result.waterfall.length > 0,
  );

  it('covers a real promote structure, not just a pro-rata split', () => {
    // A guard on the loop below: a fixture set with only pro-rata splits would
    // exercise none of the tier logic the sheet exists to show.
    const tiers = withWaterfall.flatMap((name) =>
      fixture(name as keyof typeof ALL_FIXTURES).result.waterfall.flatMap((partner) =>
        partner.byTier.map((tier) => tier.tierName),
      ),
    );
    expect(tiers.some((name) => /preferred/i.test(name))).toBe(true);
    expect(tiers.some((name) => /catch.?up/i.test(name))).toBe(true);
  });

  for (const name of withWaterfall) {
    it(`reconciles ${name}: distributions, profit and multiple per partner`, () => {
      const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
      const { workbook } = buildLiveModel(input, result);
      const evaluator = new FormulaEvaluator(workbook);

      for (const [index, partner] of result.waterfall.entries()) {
        const key = `waterfall.${index}`;
        expect(
          Math.abs(evaluator.value(`${key}.distributions`) - Number(partner.distributions)),
          `${key} distributions`,
        ).toBeLessThanOrEqual(SUM_TOLERANCE);
        expect(
          Math.abs(evaluator.value(`${key}.profit`) - Number(partner.profit)),
          `${key} profit`,
        ).toBeLessThanOrEqual(SUM_TOLERANCE);
        if (partner.equityMultiple !== null) {
          expect(
            Math.abs(evaluator.value(`${key}.multiple`) - Number(partner.equityMultiple)),
            `${key} multiple`,
          ).toBeLessThan(1e-6);
        }
      }
    });
  }

  it('moves a partner’s multiple when their contribution changes', () => {
    const name = withWaterfall[0];
    if (!name) return;
    const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
    const { workbook } = buildLiveModel(input, result);

    const before = new FormulaEvaluator(workbook).value('waterfall.0.multiple');
    const cell = cellFor(workbook, 'waterfall.0.contributions');
    cell.value = Number(cell.value) * 2;
    const after = new FormulaEvaluator(workbook).value('waterfall.0.multiple');

    // Twice the capital for the same distribution halves the multiple.
    expect(after).toBeCloseTo(before / 2, 8);
  });

  it('calculates the partner IRR from the partner’s own cash-flow row', () => {
    /*
     * Pinned deliberately, and it used to be pinned the other way. The engine
     * reported the partnership only as totals, so the IRR was imported. It now
     * surfaces each partner's dated flows, so the cell is an `XIRR` over the
     * row below it — the same construction the Returns sheet uses for the
     * property, and for the same reason: an IRR that does not move when the
     * cash flows move is a caption, not a result.
     */
    const name = withWaterfall[0];
    if (!name) return;
    const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
    const { workbook } = buildLiveModel(input, result);

    const cell = cellFor(workbook, 'waterfall.0.irr');
    expect(cell.kind).toBe('formula');

    const resolved = cell.formula?.(workbook.resolver('Waterfall')) ?? '';
    expect(resolved).toMatch(/^IFERROR\(XIRR\(/);
    // Over the partner's own flow row and the shared date row, spanning
    // closing plus every forecast month.
    const refs = workbook.resolver('Waterfall');
    const flowRange = refs.range('waterfall.0.flow', 0, result.periods.length);
    const dateRange = refs.range('waterfall.date', 0, result.periods.length);
    expect(resolved).toContain(flowRange);
    expect(resolved).toContain(dateRange);
  });

  for (const name of withWaterfall) {
    it(`carries every partner cash flow for ${name}, signed and dated`, () => {
      const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
      const { workbook } = buildLiveModel(input, result);
      const evaluator = new FormulaEvaluator(workbook);
      const count = result.periods.length;

      for (const [index, partner] of result.waterfall.entries()) {
        const key = `waterfall.${index}`;

        /*
         * Two independent routes to the same number. The flows come across
         * period by period; profit is a formula over the tiers less the
         * contribution. A dropped period or a flipped sign breaks the tie.
         */
        expect(
          Math.abs(evaluator.value(`${key}.flowTotal`) - Number(partner.profit)),
          `${key} flow total vs profit`,
        ).toBeLessThanOrEqual(SUM_TOLERANCE);

        // Positives are distributions, negatives are capital calls, and the
        // engine never puts both in one month.
        const flows = [Number(partner.initialFlow), ...partner.flows.map(Number)];
        expect(flows).toHaveLength(count + 1);
        const paidIn = -flows.filter((flow) => flow < 0).reduce((a, b) => a + b, 0);
        const paidOut = flows.filter((flow) => flow > 0).reduce((a, b) => a + b, 0);
        expect(Math.abs(paidIn - Number(partner.contributions))).toBeLessThanOrEqual(SUM_TOLERANCE);
        expect(Math.abs(paidOut - Number(partner.distributions))).toBeLessThanOrEqual(
          SUM_TOLERANCE,
        );

        // And the workbook carries each one, in order, at the right column.
        for (let i = 0; i <= count; i += 1) {
          expect(Number(cellFor(workbook, `${key}.flow#${i}`).value), `${key}.flow#${i}`).toBe(
            flows[i],
          );
        }
      }

      // The dates line up with the schedule: closing, then each month end.
      expect(cellFor(workbook, 'waterfall.date#0').value).toBe(
        input.valuation.acquisitionDate ?? input.forecast.startDate,
      );
      for (let period = 0; period < count; period += 1) {
        expect(cellFor(workbook, `waterfall.date#${period + 1}`).value).toBe(
          result.periods[period]?.endDate,
        );
      }
    });
  }

  it('moves a partner’s IRR when one of their cash flows changes', () => {
    /*
     * The dependency the XIRR exists for. `FormulaEvaluator` does not implement
     * XIRR, so this checks the chain the IRR sits on instead: editing a flow
     * cell must move the row total, which is what XIRR reads. If the flow row
     * were disconnected from the IRR the range assertion above would fail, and
     * if it were disconnected from the total this would.
     */
    const name = withWaterfall[0];
    if (!name) return;
    const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
    const { workbook } = buildLiveModel(input, result);

    const before = new FormulaEvaluator(workbook).value('waterfall.0.flowTotal');
    const cell = cellFor(workbook, 'waterfall.0.flow#1');
    cell.value = Number(cell.value) + 1_000_000;
    const after = new FormulaEvaluator(workbook).value('waterfall.0.flowTotal');

    expect(after - before).toBeCloseTo(1_000_000, 6);
  });

  for (const name of withWaterfall) {
    it(`the partner cash-flow tie-out check reads clean for ${name}`, () => {
      const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
      const { workbook } = buildLiveModel(input, result);
      const difference = new FormulaEvaluator(workbook).value('check.waterfallFlows.difference');
      expect(Number.isFinite(difference)).toBe(true);
      expect(Math.abs(difference)).toBeLessThanOrEqual(1);
    });
  }

  it('trips the tie-out check when a partner cash flow is dropped', () => {
    // The probe: a check nobody has watched fail is not a check. Zeroing the
    // closing capital call leaves the tier table untouched, so the two routes
    // to profit must now disagree by exactly that call.
    const name = withWaterfall[0];
    if (!name) return;
    const { input, result } = fixture(name as keyof typeof ALL_FIXTURES);
    const { workbook } = buildLiveModel(input, result);

    const cell = cellFor(workbook, 'waterfall.0.flow#0');
    const dropped = Number(cell.value);
    expect(dropped).toBeLessThan(0);
    cell.value = 0;

    const difference = new FormulaEvaluator(workbook).value('check.waterfallFlows.difference');
    expect(difference).toBeCloseTo(-dropped, 6);
    expect(Math.abs(difference)).toBeGreaterThan(1);
  });

  it('is omitted entirely from a model with no partnership', () => {
    const { input, result } = fixture('singleTenantIndustrial');
    expect(result.waterfall).toHaveLength(0);
    const { workbook } = buildLiveModel(input, result);
    expect(workbook.sheets.map((sheet) => sheet.name)).not.toContain('Waterfall');
  });

  it('refuses to render partners whose tiers disagree', () => {
    // One table cannot describe two different tier structures, and rendering
    // it anyway would put different meanings in the same column.
    const { input, result } = fixture(withWaterfall[0] as keyof typeof ALL_FIXTURES);
    const mangled: ModelResult = {
      ...result,
      waterfall: result.waterfall.map((partner, index) =>
        index === 0
          ? partner
          : { ...partner, byTier: [{ tierId: 'x', tierName: 'Different', amount: '1' }] },
      ),
    };
    expect(() => buildLiveModel(input, mangled)).toThrow(/different waterfall tiers/);
  });
});

/**
 * Two defects in the Debt sheet's payoff/maturity resolution, found by a
 * seventh audit pass.
 *
 * 1. `saleIndex` was hardcoded to the sheet's own last modelled period,
 *    ignoring `input.valuation.saleMonth` entirely — unlike `returns.ts`,
 *    which resolves it correctly and whose own comments explain why the
 *    axis is deliberately extended past the sale date for a `forward_12`
 *    terminal basis. A `repayOnSale` facility's payoff formula fired at the
 *    axis's last period instead of the real sale month, so the workbook
 *    kept amortising and accruing interest on a facility the engine
 *    considers already repaid.
 * 2. `maturityIndex` was clamped to the axis's last period before being
 *    used to decide *where the payoff formula fires* — a facility whose
 *    real term (the engine's own, unclamped) simply outlives the forecast
 *    is left outstanding by the engine, with no payoff and no exit fee ever
 *    charged, but the sheet forced a phantom payoff, and an erroneous exit
 *    fee, into the axis's last period regardless.
 */
describe('the debt sheet resolves the sale date and maturity the same way the engine does', () => {
  it('stops amortising a repayOnSale facility at the real sale month, not the last modelled period', () => {
    // 18-month forecast, sale at month 6, forward_12 terminal basis (which
    // needs exactly the 12 months after the sale that this forecast length
    // provides) — the axis therefore runs 12 months past the real sale, the
    // ordinary `forward_12` shape the fix's own comment describes.
    const input: ModelInput = parseModelInput({
      modelId: 'fx-debt-sale-index',
      modelName: 'Debt sheet sale index (fixture)',
      forecast: {
        startDate: '2026-01-01',
        months: 18,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      property: { id: 'P1', name: 'Fixture', propertyType: 'office', rentableArea: '10000' },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat other revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 18 }, () => '10000'),
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        saleMonth: 6,
        terminalCapRate: '0.06',
        terminalNoiBasis: 'forward_12',
      },
      debt: [
        {
          id: 'D1',
          name: 'Senior loan',
          type: 'permanent',
          commitment: '1000000',
          initialFunding: '1000000',
          fundingDate: '2026-01-01',
          rateType: 'fixed',
          fixedRate: '0.06',
          interestOnlyMonths: 999,
          amortizationMonths: 0,
          termMonths: 24,
          repayOnSale: true,
        },
      ],
    });
    const result = calculate(input);
    const { workbook } = buildLiveModel(input, result);
    const evaluator = new FormulaEvaluator(workbook);

    // Hand-derived and cross-checked against the engine's own schedule: the
    // facility is repaid at the sale (month 6, index 5), so the engine
    // reports a zero balance for every period from there on. If the sheet
    // still resolves the sale as its own last period (17), it keeps
    // amortising the facility through month 18 instead.
    expect(Number(result.debtSchedules[0]?.rows[5]?.endingBalance)).toBeCloseTo(0, 2);
    for (let period = 5; period < 18; period += 1) {
      expect(
        Math.abs(evaluator.value('debt.endingBalance', period)),
        `ending balance at period ${period}`,
      ).toBeLessThanOrEqual(SUM_TOLERANCE);
    }
  });

  it('leaves a facility outstanding, with no phantom payoff or exit fee, when its term outlives the forecast', () => {
    // 12-month forecast; a 120-month term means the engine's own (unclamped)
    // maturity index falls far outside the axis, so the balance is left
    // outstanding with no payoff or fee ever charged within the 12 modelled
    // months — the ordinary shape of, say, a 10-year permanent loan modelled
    // over a shorter hold.
    const input: ModelInput = parseModelInput({
      modelId: 'fx-debt-maturity-beyond-axis',
      modelName: 'Debt sheet maturity beyond axis (fixture)',
      forecast: {
        startDate: '2026-01-01',
        months: 12,
        fiscalYearStartMonth: 1,
        proration: 'actual_days',
      },
      property: { id: 'P1', name: 'Fixture', propertyType: 'office', rentableArea: '10000' },
      otherRevenue: [
        {
          id: 'OTHER',
          name: 'Flat other revenue',
          method: 'custom_monthly_schedule',
          monthlySchedule: Array.from({ length: 12 }, () => '10000'),
        },
      ],
      valuation: {
        discountRate: '0.08',
        saleCostPercent: '0',
        directCapAdjustments: '0',
        acquisitionCosts: '0',
        saleMonth: 12,
        terminalCapRate: '0.06',
        terminalNoiBasis: 'trailing_12',
      },
      debt: [
        {
          id: 'D1',
          name: 'Permanent loan',
          type: 'permanent',
          commitment: '1000000',
          initialFunding: '1000000',
          fundingDate: '2026-01-01',
          rateType: 'fixed',
          fixedRate: '0.06',
          interestOnlyMonths: 999,
          amortizationMonths: 0,
          termMonths: 120,
          repayOnSale: false,
          exitFeePercent: '0.02',
        },
      ],
    });
    const result = calculate(input);
    const { workbook } = buildLiveModel(input, result);
    const evaluator = new FormulaEvaluator(workbook);

    // Interest-only, so the balance never amortises down: it stays at the
    // full $1,000,000 through the last modelled period. Confirmed against
    // the engine's own schedule first, independent of anything Excel does.
    expect(Number(result.debtSchedules[0]?.rows[11]?.endingBalance)).toBeCloseTo(1_000_000, 2);
    expect(
      Math.abs(evaluator.value('debt.endingBalance', 11) - 1_000_000),
      'ending balance at the last modelled period',
    ).toBeLessThanOrEqual(SUM_TOLERANCE);
    expect(
      Math.abs(evaluator.value('debt.fees', 11)),
      'no exit fee charged when the loan has not actually matured',
    ).toBeLessThanOrEqual(SUM_TOLERANCE);
  });
});
