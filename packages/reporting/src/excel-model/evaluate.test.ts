import { describe, expect, it } from 'vitest';
import { WorkbookModel } from './model.js';
import { FormulaEvaluator } from './evaluate.js';

/**
 * `IFERROR`'s fallback argument, in the workbook reconciliation instrument.
 *
 * Found by a repository-wide correctness audit: the evaluator's `IFERROR`
 * never read its second argument at all — it returned `NaN` whenever the
 * first argument was non-finite, regardless of what the fallback was. Every
 * `IFERROR` this exporter currently emits wraps an unimplemented function
 * (`XIRR`, `XNPV`, `SUMIF`, all deliberately `NaN` in this evaluator) with a
 * string-literal fallback (also `NaN`, since this parser is arithmetic-only
 * and has nowhere to put a string), so the bug had no effect on any formula
 * emitted today. But it is real: a future formula wrapping a genuine
 * divide-by-zero risk in `IFERROR(expr, fallback)` would have its
 * reconciliation check silently skipped rather than verified against the
 * fallback value, exactly the "pretend to have checked it" failure mode
 * this evaluator's own module doc says it exists to avoid.
 */
describe('IFERROR', () => {
  it('falls back to its second argument on a non-finite result, matching real Excel semantics', () => {
    const workbook = new WorkbookModel();
    const sheet = workbook.sheet('Test');
    // `1/0` is this evaluator's own way of producing a non-finite value —
    // it returns NaN rather than JS's native Infinity, precisely so a
    // missing IFERROR guard is visible as an error condition.
    sheet.at(1, 1, { kind: 'formula', formula: () => 'IFERROR(1/0,42)' }, 'test.divideByZero');

    const evaluator = new FormulaEvaluator(workbook);
    expect(evaluator.value('test.divideByZero')).toBe(42);
  });

  it('returns the primary value untouched when it is finite', () => {
    const workbook = new WorkbookModel();
    const sheet = workbook.sheet('Test');
    sheet.at(1, 1, { kind: 'formula', formula: () => 'IFERROR(6/3,42)' }, 'test.finite');

    const evaluator = new FormulaEvaluator(workbook);
    expect(evaluator.value('test.finite')).toBe(2);
  });
});
