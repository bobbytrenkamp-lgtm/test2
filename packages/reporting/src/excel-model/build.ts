import type { ModelInput, ModelResult } from '@cre/domain-models';
import { WorkbookModel } from './model.js';
import { timeAxis } from './layout.js';
import { buildAssumptions } from './sheets/assumptions.js';
import { buildRevenue } from './sheets/revenue.js';
import { buildExpenses } from './sheets/expenses.js';
import { buildCashFlow } from './sheets/cashflow.js';
import { buildReturns } from './sheets/returns.js';
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
 * Phase 2 covers Assumptions, Revenue, Expenses, Cash Flow and Returns. There
 * is no Rent Roll, Debt or Summary sheet yet; `hasDebt` is therefore false and
 * the cash flow's financing lines are zero. `docs/excel-live-model.md` tracks
 * what each remaining phase adds.
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

  // Debt has its own phase. Until then the schedule does not exist, so the
  // financing lines are written as explicit zeros rather than as engine values
  // that no assumption could move.
  const hasDebt = false;

  buildAssumptions(workbook, input, result, axis);
  buildRevenue(workbook, input, result, axis);
  buildExpenses(workbook, input, result, axis);
  buildCashFlow(workbook, result, axis, hasDebt);
  buildReturns(workbook, input, result, axis);

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
