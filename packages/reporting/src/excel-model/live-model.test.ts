import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { ALL_FIXTURES, calculate } from '@cre/calculation-engine';
import type { CashFlowLine, ModelInput, ModelResult } from '@cre/domain-models';
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
        // Only the two identities that hold across all 102 detail rows. The
        // recovery build-up itself is imported; see the sheet documentation.
        const checks: Array<[string, number]> = [
          ['share', Number(detail.proRataShare)],
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

  it('keeps the recovery build-up imported rather than guessed', () => {
    // Pinned deliberately. `pool x share - base year - stop` is exact for
    // base-year and expense-stop leases and wrong for triple-net ones, so these
    // two lines must stay imported until the triple-net rule is understood.
    const { input, result } = fixture('groceryAnchoredRetail');
    const { workbook } = buildLiveModel(input, result);
    expect(cellFor(workbook, 'recovery.0.beforeCaps').kind).toBe('staticDerived');
    expect(cellFor(workbook, 'recovery.0.finalRecovery').kind).toBe('staticDerived');
  });
});
