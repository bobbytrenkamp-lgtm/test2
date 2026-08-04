import { describe, expect, it } from 'vitest';
import { analyzeActuals, mapActuals, normalizeMonth, suggestCategory } from './actuals-import.js';

describe('month normalisation', () => {
  it('reads the shapes a ledger export actually uses', () => {
    expect(normalizeMonth('2026-01')).toBe('2026-01-01');
    expect(normalizeMonth('2026-01-31')).toBe('2026-01-01');
    expect(normalizeMonth('Jan-26')).toBe('2026-01-01');
    expect(normalizeMonth('Jan 2026')).toBe('2026-01-01');
    expect(normalizeMonth('January 2026')).toBe('2026-01-01');
    expect(normalizeMonth('03/2026')).toBe('2026-03-01');
    expect(normalizeMonth('12-2026')).toBe('2026-12-01');
  });

  it('always lands on the first of the month', () => {
    // A monthly figure has no meaningful day. Keeping one invites a timezone
    // to shift it into the previous month.
    expect(normalizeMonth('2026-07-31')).toBe('2026-07-01');
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(normalizeMonth('Q1 2026')).toBeNull();
    expect(normalizeMonth('2026-13')).toBeNull();
    expect(normalizeMonth('Smarch-26')).toBeNull();
    expect(normalizeMonth('')).toBeNull();
  });
});

describe('category detection', () => {
  it('reads the words a chart of accounts uses', () => {
    expect(suggestCategory('Revenue')).toBe('revenue');
    expect(suggestCategory('Rental income')).toBe('revenue');
    expect(suggestCategory('Operating expense')).toBe('operating_expense');
    expect(suggestCategory('OPEX')).toBe('operating_expense');
    expect(suggestCategory('Capital expenditure')).toBe('capital');
    expect(suggestCategory('Interest')).toBe('debt_service');
  });

  it('returns nothing when it does not recognise the word', () => {
    expect(suggestCategory('Zorblatt')).toBeNull();
  });
});

describe('layout detection', () => {
  const wide = [
    'Account,Description,Jan-26,Feb-26,Mar-26',
    '4000,Base rent,10000,10000,10500',
    '5100,Repairs,1200,900,1450',
  ].join('\n');

  const long = [
    'Account,Description,Period,Amount',
    '4000,Base rent,2026-01,10000',
    '4000,Base rent,2026-02,10000',
  ].join('\n');

  it('recognises a month-per-column trial balance', () => {
    const analysis = analyzeActuals(wide);
    expect(analysis.layout).toBe('wide');
    expect(analysis.monthColumns.map((column) => column.month)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
    expect(analysis.mapping.accountCode).toBe(0);
    expect(analysis.mapping.accountName).toBe(1);
    expect(analysis.rowCount).toBe(2);
  });

  it('recognises a row-per-account-per-month export', () => {
    const analysis = analyzeActuals(long);
    expect(analysis.layout).toBe('long');
    expect(analysis.monthColumns).toEqual([]);
    expect(analysis.mapping.period).toBe(2);
    expect(analysis.mapping.amount).toBe(3);
  });

  it('accepts a single month column, which is the most ordinary upload there is', () => {
    // One month of actuals is the routine monthly close. Requiring two month
    // columns before recognising the layout would reject it.
    const analysis = analyzeActuals('Account,Description,Jan-26\n4000,Base rent,10000');
    expect(analysis.layout).toBe('wide');
    expect(analysis.monthColumns).toEqual([{ index: 2, month: '2026-01-01' }]);
  });

  it('prefers the long reading when a period and amount pair is present', () => {
    // A period column paired with an amount column settles it, whatever else
    // the header happens to contain.
    const analysis = analyzeActuals(
      'Account,Description,Period,Amount\n4000,Base rent,Jan-26,10000',
    );
    expect(analysis.layout).toBe('long');
  });
});

describe('mapping a wide sheet', () => {
  const content = [
    'Account,Description,Category,Jan-26,Feb-26',
    '4000,Base rent,Revenue,10000,10000',
    '5100,Repairs,Operating expense,1200,900',
  ].join('\n');

  it('produces one entry per account per month', () => {
    const analysis = analyzeActuals(content);
    const result = mapActuals(content, analysis);
    expect(result.entries).toHaveLength(4);
    expect(result.months).toEqual(['2026-01-01', '2026-02-01']);
  });

  it('negates costs when the file states them positive', () => {
    const analysis = analyzeActuals(content);
    const result = mapActuals(content, analysis, { expenseSign: 'positive' });
    const rent = result.entries.find((entry) => entry.accountCode === '4000');
    const repairs = result.entries.find((entry) => entry.accountCode === '5100');
    // Revenue is untouched; the cost is flipped into the cash-flow convention.
    expect(rent?.amount).toBe('10000');
    expect(repairs?.amount).toBe('-1200');
  });

  it('leaves signs alone when the file already uses the cash-flow convention', () => {
    const negative = [
      'Account,Description,Category,Jan-26',
      '5100,Repairs,Operating expense,-1200',
    ].join('\n');
    const analysis = analyzeActuals(negative);
    const result = mapActuals(negative, analysis, { expenseSign: 'negative' });
    expect(result.entries[0]?.amount).toBe('-1200');
  });

  it('does not double-negate a cost already written negative', () => {
    const alreadyNegative = [
      'Account,Description,Category,Jan-26',
      '5100,Repairs,Operating expense,-1200',
    ].join('\n');
    const analysis = analyzeActuals(alreadyNegative);
    const result = mapActuals(alreadyNegative, analysis, { expenseSign: 'positive' });
    expect(result.entries[0]?.amount).toBe('-1200');
  });

  it('skips a blank cell rather than storing a zero nobody entered', () => {
    const sparse = ['Account,Description,Jan-26,Feb-26', '4000,Base rent,10000,'].join('\n');
    const analysis = analyzeActuals(sparse);
    const result = mapActuals(sparse, analysis);
    expect(result.entries).toHaveLength(1);
    expect(result.months).toEqual(['2026-01-01']);
  });

  it('warns rather than guessing the sign of an uncategorised row', () => {
    const uncategorised = ['Account,Description,Jan-26', '9999,Something,500'].join('\n');
    const analysis = analyzeActuals(uncategorised);
    const result = mapActuals(uncategorised, analysis, { expenseSign: 'positive' });
    const warning = result.issues.find((issue) => issue.severity === 'warning');
    expect(warning?.message).toContain('no category');
    // Left as written: applying the wrong sign would reverse the variance, not
    // merely misplace the row.
    expect(result.entries[0]?.amount).toBe('500');
  });

  it('classifies by account-code prefix when the file has no category column', () => {
    const noCategory = [
      'Account,Description,Jan-26',
      '4000,Base rent,10000',
      '5100,Repairs,1200',
    ].join('\n');
    const analysis = analyzeActuals(noCategory);
    const result = mapActuals(noCategory, analysis, {
      expenseSign: 'positive',
      categoryByPrefix: { '4': 'revenue', '5': 'operating_expense' },
    });
    expect(result.entries.find((entry) => entry.accountCode === '4000')?.amount).toBe('10000');
    expect(result.entries.find((entry) => entry.accountCode === '5100')?.amount).toBe('-1200');
    expect(result.issues).toEqual([]);
  });
});

describe('mapping a long sheet', () => {
  it('reads one row per account per month', () => {
    const content = [
      'Account,Description,Category,Period,Amount',
      '4000,Base rent,Revenue,2026-01,10000',
      '4000,Base rent,Revenue,Feb-26,"10,500"',
    ].join('\n');
    const analysis = analyzeActuals(content);
    const result = mapActuals(content, analysis);
    expect(result.entries).toHaveLength(2);
    // Thousands separators are read, as in the rent-roll importer.
    expect(result.entries[1]?.amount).toBe('10500');
    expect(result.entries[1]?.periodMonth).toBe('2026-02-01');
  });

  it('reports an unreadable month and imports nothing from that row', () => {
    const content = [
      'Account,Description,Period,Amount',
      '4000,Base rent,Q1 2026,10000',
      '4000,Base rent,2026-02,10000',
    ].join('\n');
    const analysis = analyzeActuals(content);
    const result = mapActuals(content, analysis);
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.periodMonth).toBe('2026-02-01');
  });
});

describe('rows that cannot be used', () => {
  it('refuses a file with no account column', () => {
    const content = 'Something,Else\n1,2';
    const analysis = analyzeActuals(content);
    const result = mapActuals(content, analysis);
    expect(result.entries).toEqual([]);
    expect(result.issues[0]?.message).toContain('No account code column');
  });

  it('excludes a row whose amount cannot be read, even where other months parsed', () => {
    // The lesson from the rent-roll importer: reporting a problem and importing
    // the row anyway means the warning is ignored because the number arrived.
    const content = ['Account,Description,Jan-26,Feb-26', '4000,Base rent,10000,n/a'].join('\n');
    const analysis = analyzeActuals(content);
    const result = mapActuals(content, analysis);
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it('reports a row with no account code', () => {
    const content = ['Account,Description,Jan-26', ',Orphaned,10000'].join('\n');
    const analysis = analyzeActuals(content);
    const result = mapActuals(content, analysis);
    expect(result.entries).toEqual([]);
    expect(result.issues[0]?.message).toContain('account code is empty');
  });
});
