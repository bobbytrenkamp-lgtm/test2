import { describe, expect, it } from 'vitest';
import { formatCovenantValue } from './ReturnsTab.js';

/**
 * The "first breach" banner on the debt schedule card.
 *
 * `covenantBreaches[].value`/`.limit` mean different things depending on
 * which covenant sprang it: `minimum_dscr` is a ratio (1.20, shown as
 * "1.20", the same way the Minimum DSCR summary metric on this same tab
 * already renders it), while `maximum_ltv`, `maximum_ltc` and
 * `minimum_debt_yield` are the engine's usual raw decimal fraction (0.65
 * for 65%) -- the same convention `formatPercent` already applies to
 * `returns.loanToValue` a few lines up in this file. The banner used to
 * format every covenant type as a bare `.toFixed(4)`, which meant an LTV
 * breach read "0.6800 against a limit of 0.6500" -- the real 68% against a
 * 65% cap, printed two decimal orders of magnitude off, on the one screen
 * a lender-facing covenant conversation would actually use.
 */
describe('formatCovenantValue', () => {
  it('renders a DSCR covenant as a plain ratio, not a percentage', () => {
    expect(formatCovenantValue('minimum_dscr', '1.15')).toBe('1.15');
    expect(formatCovenantValue('minimum_dscr', '1.2')).toBe('1.20');
  });

  it('renders an LTV, LTC or debt-yield covenant as a percentage', () => {
    expect(formatCovenantValue('maximum_ltv', '0.68')).toBe('68.00%');
    expect(formatCovenantValue('maximum_ltc', '0.75')).toBe('75.00%');
    expect(formatCovenantValue('minimum_debt_yield', '0.095')).toBe('9.50%');
  });

  it('falls back to an em dash when either half is missing', () => {
    expect(formatCovenantValue(undefined, '0.65')).toBe('—');
    expect(formatCovenantValue('maximum_ltv', undefined)).toBe('—');
  });
});
