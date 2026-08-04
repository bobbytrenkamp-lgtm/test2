import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, toCsv } from './csv.js';
import {
  analyzeSheet,
  mapRows,
  normalizeDate,
  normalizeNumber,
  normalizeRecoveryMethod,
  normalizeStatus,
  suggestField,
  suggestMapping,
} from './rent-roll-import.js';

describe('CSV parsing', () => {
  it('handles quoted fields containing the delimiter', () => {
    const rows = parseCsv('a,"b,c",d\n1,2,3');
    expect(rows).toEqual([
      ['a', 'b,c', 'd'],
      ['1', '2', '3'],
    ]);
  });

  it('handles escaped quotes and embedded newlines', () => {
    const rows = parseCsv('name,note\n"Smith ""Jr"""," line one\nline two"');
    expect(rows[1]?.[0]).toBe('Smith "Jr"');
    expect(rows[1]?.[1]).toBe(' line one\nline two');
  });

  it('strips a byte order mark from the first header', () => {
    const rows = parseCsv('﻿Suite,Tenant\n101,Acme');
    expect(rows[0]?.[0]).toBe('Suite');
  });

  it('accepts both line ending conventions', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('detects the delimiter from the most consistent column count', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('round-trips through serialisation', () => {
    const rows = [
      ['Tenant', 'Note'],
      ['Acme, Inc.', 'Says "hello"'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('number normalisation', () => {
  it('reads thousands separators and currency symbols', () => {
    expect(normalizeNumber('$1,234,567.89')).toBe('1234567.89');
    expect(normalizeNumber('12,500 sf')).toBe('12500');
    expect(normalizeNumber('  42  ')).toBe('42');
  });

  it('reads parentheses as a negative', () => {
    expect(normalizeNumber('(1,500.00)')).toBe('-1500.00');
    expect(normalizeNumber('-250')).toBe('-250');
  });

  it('reads European decimal separators', () => {
    expect(normalizeNumber('1.234.567,89')).toBe('1234567.89');
    expect(normalizeNumber('1.234,50')).toBe('1234.50');
  });

  it('returns null for a blank or non-numeric cell', () => {
    expect(normalizeNumber('')).toBeNull();
    expect(normalizeNumber('N/A')).toBeNull();
    expect(normalizeNumber('—')).toBeNull();
    expect(normalizeNumber('TBD')).toBeNull();
  });
});

describe('date normalisation', () => {
  it('reads ISO dates without ambiguity', () => {
    expect(normalizeDate('2026-03-04')).toEqual({ value: '2026-03-04', ambiguous: false });
  });

  it('resolves an ambiguous numeric date by the stated preference, and says so', () => {
    expect(normalizeDate('03/04/2026', 'mdy')).toEqual({ value: '2026-03-04', ambiguous: true });
    expect(normalizeDate('03/04/2026', 'dmy')).toEqual({ value: '2026-04-03', ambiguous: true });
  });

  it('resolves a date that can only be read one way', () => {
    expect(normalizeDate('25/12/2026', 'mdy')).toEqual({ value: '2026-12-25', ambiguous: false });
    expect(normalizeDate('12/25/2026', 'dmy')).toEqual({ value: '2026-12-25', ambiguous: false });
  });

  it('reads named-month formats', () => {
    expect(normalizeDate('1 Mar 2026').value).toBe('2026-03-01');
    expect(normalizeDate('March 15, 2026').value).toBe('2026-03-15');
    expect(normalizeDate('15-Jun-27').value).toBe('2027-06-15');
  });

  it('reads an unformatted Excel serial number', () => {
    // Excel serial 45658 is 1 January 2025.
    expect(normalizeDate('45658').value).toBe('2025-01-01');
  });

  it('expands two-digit years around the century boundary', () => {
    expect(normalizeDate('01/01/99', 'mdy').value).toBe('1999-01-01');
    expect(normalizeDate('01/01/26', 'mdy').value).toBe('2026-01-01');
  });

  it('returns null when nothing resembles a date', () => {
    expect(normalizeDate('see lease').value).toBeNull();
    expect(normalizeDate('').value).toBeNull();
  });
});

describe('enumeration normalisation', () => {
  it('maps status vocabulary onto the platform statuses', () => {
    expect(normalizeStatus('Current')).toBe('occupied');
    expect(normalizeStatus('VACANT')).toBe('vacant');
    expect(normalizeStatus('month-to-month')).toBe('month_to_month');
  });

  it('maps recovery vocabulary onto the platform structures', () => {
    expect(normalizeRecoveryMethod('NNN')).toBe('triple_net');
    expect(normalizeRecoveryMethod('Triple Net')).toBe('triple_net');
    expect(normalizeRecoveryMethod('Base Year 2026')).toBe('base_year');
    expect(normalizeRecoveryMethod('Expense Stop')).toBe('expense_stop');
    expect(normalizeRecoveryMethod('Full Service Gross')).toBe('full_service_gross');
    expect(normalizeRecoveryMethod('unrecognised')).toBe('none');
  });
});

describe('header detection', () => {
  it('finds the header row beneath a title block', () => {
    const rows = parseCsv(
      [
        'ACME PROPERTY MANAGEMENT,,,,',
        'Rent Roll as of 1 January 2026,,,,',
        ',,,,',
        'Suite,Tenant Name,Square Feet,Lease Start,Lease End,Annual Rent',
        '101,Northwind Trading,12500,01/01/2024,12/31/2028,375000',
        '102,Contoso Legal,8000,06/01/2023,05/31/2027,264000',
      ].join('\n'),
    );
    const analysis = analyzeSheet(rows);
    expect(analysis.headerRowIndex).toBe(3);
    expect(analysis.headers[0]).toBe('Suite');
    expect(analysis.dataRows).toHaveLength(2);
    expect(analysis.confidence).toBeGreaterThan(0.8);
  });

  it('matches common column synonyms', () => {
    expect(suggestField('Square Feet')).toBe('area');
    expect(suggestField('Rentable SF')).toBe('area');
    expect(suggestField('Tenant Name')).toBe('tenantName');
    expect(suggestField('Lease Expiration')).toBe('expirationDate');
    expect(suggestField('Annual Rent')).toBe('baseRent');
    expect(suggestField('Suite')).toBe('spaceCode');
    expect(suggestField('Colour of the door')).toBeNull();
  });

  it('never assigns one column to two fields', () => {
    const mapping = suggestMapping(['Suite', 'Tenant', 'SF', 'Start', 'End', 'Rent']);
    const columns = Object.values(mapping);
    expect(new Set(columns).size).toBe(columns.length);
  });
});

describe('row mapping', () => {
  const headers = [
    'Suite',
    'Tenant Name',
    'Square Feet',
    'Lease Start',
    'Lease End',
    'Annual Rent',
    'Type',
  ];
  const mapping = suggestMapping(headers);

  it('maps a clean rent roll', () => {
    const result = mapRows(
      [
        ['101', 'Northwind Trading', '12,500', '2024-01-01', '2028-12-31', '$375,000', 'NNN'],
        ['102', 'Contoso Legal', '8,000', '2023-06-01', '2027-05-31', '$264,000', 'Base Year'],
      ],
      { ...mapping, recoveryMethod: 6 },
    );

    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.leases).toHaveLength(2);
    const first = result.leases[0];
    expect(first?.spaceCode).toBe('101');
    expect(first?.tenantName).toBe('Northwind Trading');
    expect(first?.area).toBe('12500');
    expect(first?.baseRent).toBe('375000');
    expect(first?.commencementDate).toBe('2024-01-01');
    expect(first?.expirationDate).toBe('2028-12-31');
    expect(first?.recoveryMethod).toBe('triple_net');
    // 375,000 against 12,500 sf is far larger than the area, so it reads as a
    // total rather than a per-area rate.
    expect(first?.baseRentBasis).toBe('annual_amount');
    expect(result.leases[1]?.recoveryMethod).toBe('base_year');
  });

  it('infers a per-area rate when the rent is smaller than the area', () => {
    const result = mapRows(
      [['201', 'Small Rate Co', '20000', '2026-01-01', '2031-12-31', '30.00', 'NNN']],
      { ...mapping, recoveryMethod: 6 },
    );
    expect(result.leases[0]?.baseRentBasis).toBe('per_area_per_year');
  });

  it('reports a row whose dates are the wrong way round', () => {
    const result = mapRows(
      [['301', 'Backwards Ltd', '5000', '2028-01-01', '2026-01-01', '100000', 'NNN']],
      mapping,
    );
    const error = result.issues.find((issue) => issue.field === 'expirationDate');
    expect(error?.severity).toBe('error');
    expect(error?.message).toMatch(/expires before it commences/i);
    expect(result.leases).toHaveLength(0);
  });

  it('reports an unreadable number rather than importing a zero', () => {
    const result = mapRows(
      [['401', 'Unreadable Co', 'see lease', '2026-01-01', '2031-12-31', '100000', 'NNN']],
      mapping,
    );
    const error = result.issues.find((issue) => issue.field === 'area');
    expect(error?.severity).toBe('error');
    expect(error?.rawValue).toBe('see lease');
    expect(result.leases).toHaveLength(0);
  });

  it('reports a required field that was never mapped', () => {
    const { area: _area, ...withoutArea } = mapping;
    const result = mapRows(
      [['501', 'No Area Co', '', '2026-01-01', '2031-12-31', '1', '']],
      withoutArea,
    );
    const error = result.issues.find((issue) => issue.field === 'area' && issue.rowIndex === -1);
    expect(error?.severity).toBe('error');
    expect(error?.message).toMatch(/required/i);
  });

  it('detects a duplicated lease reference', () => {
    const withLease = { ...mapping, leaseCode: 0 };
    const result = mapRows(
      [
        ['L-1', 'First Co', '1000', '2026-01-01', '2031-12-31', '10000', ''],
        ['L-1', 'Second Co', '2000', '2026-01-01', '2031-12-31', '20000', ''],
      ],
      withLease,
    );
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.leaseCode).toBe('L-1');
    expect(result.issues.some((issue) => issue.message.includes('appears on rows'))).toBe(true);
  });

  it('warns about an ambiguous date instead of importing it silently', () => {
    const result = mapRows(
      [['601', 'Ambiguous Co', '1000', '01/02/2026', '01/02/2031', '10000', '']],
      mapping,
      { datePreference: 'mdy' },
    );
    const warning = result.issues.find((issue) => issue.severity === 'warning');
    expect(warning?.message).toMatch(/ambiguous/i);
    expect(result.leases[0]?.commencementDate).toBe('2026-01-02');
  });

  it('skips blank spacer rows without complaint', () => {
    const result = mapRows(
      [
        ['101', 'Real Tenant', '1000', '2026-01-01', '2031-12-31', '10000', ''],
        ['', '', '', '', '', '', ''],
        ['   ', '', '', '', '', '', ''],
      ],
      mapping,
    );
    expect(result.leases).toHaveLength(1);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });
});
