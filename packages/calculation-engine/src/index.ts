export { ENGINE_VERSION, calculate, type CalculateOptions } from './engine.js';
export * from './decimal.js';
export * from './calendar.js';
export * from './curves.js';
export * from './trace.js';
export * from './rent-schedule.js';
export * from './leases.js';
export * from './expenses.js';
export * from './recoveries.js';
export * from './revenue.js';
export * from './capital.js';
export * from './debt.js';
export * from './debt-sizing.js';
export * from './straight-line-rent.js';
export * from './sales-comparison.js';
export * from './cost-approach.js';
export * from './valuation.js';
export * from './metrics.js';
export * from './waterfall.js';
export * from './portfolio.js';
export * from './fund.js';
export * from './fund-waterfall.js';
export * from './compare.js';
export * from './lease-options.js';
export * from './variance.js';
export * from './health.js';
export * from './drivers.js';

/**
 * The regression fixtures.
 *
 * Exported because two things outside the test suite now depend on them: the
 * public demonstration page bundles them to run the engine in a browser, and
 * the Excel Live Model tests reconcile the exported workbook against them.
 * Both were reaching in through relative paths, which `tsc` rejects across a
 * package boundary — a supported export is the honest form of a dependency
 * that already exists.
 */
export { ALL_FIXTURES } from './__fixtures__/properties.js';
