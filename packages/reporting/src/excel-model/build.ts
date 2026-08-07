import type { ModelInput, ModelResult } from '@cre/domain-models';
import { WorkbookModel } from './model.js';
import { timeAxis } from './layout.js';
import { buildAssumptions } from './sheets/assumptions.js';
import { buildRentRoll } from './sheets/rent-roll.js';
import { buildRevenue } from './sheets/revenue.js';
import { buildExpenses } from './sheets/expenses.js';
import { buildRecoveries } from './sheets/recoveries.js';
import { buildDebt } from './sheets/debt.js';
import { buildCashFlow } from './sheets/cashflow.js';
import { buildReturns } from './sheets/returns.js';
import { buildSummary } from './sheets/summary.js';
import { buildWaterfall } from './sheets/waterfall.js';
import { measureCoverage } from './coverage.js';
import type { CoverageReport } from './coverage.js';
import { renderWorkbook } from './render.js';

/**
 * Assembles the Live Model workbook.
 *
 * Sheet order is reading order, not dependency order — the two-pass formula
 * resolution in `WorkbookModel` means a sheet may reference one built after it,
 * so the layout can serve the reader instead of the builder.
 *
 * Phases 2 and 4 are in: Assumptions, Revenue, Expenses, Debt, Cash Flow and
 * Returns. `docs/excel-live-model.md` tracks what each remaining phase adds.
 */
export interface LiveModelResult {
  workbook: WorkbookModel;
  coverage: CoverageReport;
}

export function buildLiveModel(input: ModelInput, result: ModelResult): LiveModelResult {
  const axis = timeAxis(result.periods);
  if (axis.count === 0) {
    throw new Error('This model has no forecast periods, so there is no workbook to build.');
  }

  const workbook = new WorkbookModel();

  // A model with no facilities gets zeroed financing lines rather than an
  // empty sheet, so Cash Flow can reference them unconditionally.
  const hasDebt = input.debt.length > 0;

  // Summary first, so it reads first. It references sheets built after it,
  // which the two-pass formula resolution makes safe.
  buildSummary(workbook, input, result, axis, hasDebt, result.waterfall.length > 0);
  buildAssumptions(workbook, input, result, axis);
  buildRentRoll(workbook, input, result, axis);
  buildRecoveries(workbook, result, axis);
  buildRevenue(workbook, input, result, axis);
  buildExpenses(workbook, input, result, axis);
  if (hasDebt) buildDebt(workbook, input, result, axis);
  buildCashFlow(workbook, result, axis, hasDebt);
  buildReturns(workbook, input, result, axis);
  // Only when the model has a partnership; most single-asset models do not.
  buildWaterfall(workbook, result);

  return { workbook, coverage: measureCoverage(workbook) };
}

/** Builds and serialises in one step. */
export async function exportLiveModel(
  input: ModelInput,
  result: ModelResult,
): Promise<{ buffer: Buffer; coverage: CoverageReport }> {
  const { workbook, coverage } = buildLiveModel(input, result);
  const buffer = await renderWorkbook(workbook, {
    description: `Live model for ${input.property.name}. Engine ${result.engineVersion}.`,
  });
  return { buffer, coverage };
}

/**
 * A filename safe on every platform.
 *
 * Reserved characters, leading dots and trailing spaces are all removed rather
 * than escaped: a property called `Q1/Q2 Portfolio` must not become a path.
 */
export function liveModelFilename(propertyName: string, modelName: string, on: Date): string {
  const clean = (value: string): string =>
    value
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60);
  const date = on.toISOString().slice(0, 10);
  const parts = [clean(propertyName), clean(modelName)].filter((part) => part.length > 0);
  return `${parts.join('_') || 'Model'}_${date}.xlsx`;
}
