/**
 * The Excel Live Model exporter.
 *
 * A formula-driven workbook: assumptions as editable cells, and calculations
 * as Excel formulas that reference them, rather than a report of numbers the
 * engine already worked out.
 *
 * ## Status
 *
 * **Phase 1 (framework) is complete and tested. Phases 2 to 5 are not built.**
 * There is no export route and no UI entry point yet, because there is not yet
 * a workbook worth exporting. See `docs/excel-live-model.md` for what each
 * remaining phase covers and what is verified today.
 *
 * ## Why the framework comes first
 *
 * The architectural risk in this feature is ending up with two calculation
 * engines that drift. The defence is that the exporter never restates a rule:
 * it maps the engine's own relationships onto cells, and where a rule cannot be
 * expressed as a formula it says so through the coverage metric rather than
 * quietly pasting a number.
 *
 * That only works if cells are addressable by meaning. Here a cell is
 * registered under a business key and formulas ask for
 * `refs.ref('cashFlow.netOperatingIncome', 12)`; no formula anywhere contains a
 * literal coordinate.
 */

export {
  columnLetter,
  quoteSheet,
  refTo,
  rangeTo,
  absoluteRef,
  safeSheetName,
  safeDefinedName,
} from './refs.js';
export type { Address, RefOptions } from './refs.js';

export { WorkbookModel, SheetModel, seriesKey } from './model.js';
export type { CellKind, CellSpec, NumberFormatName, RefResolver, SheetOptions } from './model.js';

export { NUMBER_FORMATS, FONT_COLOURS, fontColour } from './styles.js';

export {
  LABEL_COL,
  TOTAL_COL,
  FIRST_PERIOD_COL,
  periodColumn,
  periodHeader,
  scheduleColumnWidths,
  seriesRow,
  sumOfSeries,
  timeAxis,
} from './layout.js';
export type { TimeAxis, SeriesRowOptions } from './layout.js';

export { measureCoverage, formatCoverage } from './coverage.js';
export type { CoverageReport } from './coverage.js';

export { renderWorkbook } from './render.js';
export type { RenderOptions } from './render.js';

export { buildAssumptions } from './sheets/assumptions.js';
export { buildRentRoll } from './sheets/rent-roll.js';
export { buildRevenue } from './sheets/revenue.js';
export { buildExpenses } from './sheets/expenses.js';
export { buildRecoveries } from './sheets/recoveries.js';
export { buildDebt } from './sheets/debt.js';
export { buildCashFlow } from './sheets/cashflow.js';
export { buildReturns } from './sheets/returns.js';
export { buildSummary } from './sheets/summary.js';

export { buildLiveModel, exportLiveModel, liveModelFilename } from './build.js';
export type { LiveModelResult } from './build.js';
