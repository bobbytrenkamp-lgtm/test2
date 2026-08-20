import { describe, expect, it } from 'vitest';
import { decimalString } from '@cre/domain-models';
import {
  fieldText,
  fieldValue,
  mustBeNumber,
  readPath,
  validate,
  visibleFields,
  writePath,
  type FieldSpec,
  type RecordValues,
} from './spec.js';
import { DEBT_SPEC, EXPENSE_SPEC, MARKET_LEASING_SPEC, RECORD_SPECS } from './specs.js';

/**
 * The record editors, tested as data.
 *
 * The specs are the whole behaviour: which fields exist, which apply to which
 * method, what each will accept, and what the summary panel says. Rendering
 * them is mechanical, so it is checked in the browser; the rules are checked
 * here, where a wrong one is a failing assertion rather than a screenshot
 * somebody has to read.
 */

const keys = (fields: FieldSpec[]): string[] => fields.map((field) => field.key);

describe('dotted paths', () => {
  it('reads and writes a nested field without mutating', () => {
    const record: RecordValues = { recovery: { method: 'base_year', baseYear: 2026 } };
    expect(readPath(record, 'recovery.method')).toBe('base_year');

    const next = writePath(record, 'recovery.method', 'triple_net');
    expect(readPath(next, 'recovery.method')).toBe('triple_net');
    // The original is untouched, which is what lets the form hold history.
    expect(readPath(record, 'recovery.method')).toBe('base_year');
    // And the siblings survive: writing one key of a nested object must not
    // replace the object.
    expect(readPath(next, 'recovery.baseYear')).toBe(2026);
  });

  it('creates the intermediate object when the path does not exist yet', () => {
    const next = writePath({}, 'renewalEscalation.type', 'fixed_percent');
    expect(next).toEqual({ renewalEscalation: { type: 'fixed_percent' } });
  });

  it('replaces a non-object standing where an object should be', () => {
    // A record whose `recovery` came back as null must not throw on first edit.
    const next = writePath({ recovery: null }, 'recovery.method', 'none');
    expect(readPath(next, 'recovery.method')).toBe('none');
  });
});

describe('field values', () => {
  const decimal: FieldSpec = { key: 'amount', label: 'Amount', kind: 'decimal' };
  const integer: FieldSpec = { key: 'termMonths', label: 'Term', kind: 'integer' };
  const bool: FieldSpec = { key: 'repayOnSale', label: 'Repays', kind: 'boolean' };
  const schedule: FieldSpec = { key: 'monthlySchedule', label: 'Months', kind: 'schedule' };

  it('keeps a decimal as the string it was typed as', () => {
    /*
     * The convention the whole system rests on. Parsing here would turn
     * 1234.55 into 1234.5499999999999 before the value ever reached the engine,
     * which works in decimal precisely to avoid that.
     */
    expect(fieldValue('1234.55', decimal)).toBe('1234.55');
    expect(fieldValue('12345678901234.55', decimal)).toBe('12345678901234.55');
  });

  it('strips a thousands separator so the stored value is a real decimal string', () => {
    // mustBeNumber -- the validator these fields actually use (see specs.ts)
    // -- strips commas before checking the number is valid, so a form field
    // shows no error for "12,500". What gets stored has to agree with that
    // verdict: the API's own decimalString schema, the real boundary this
    // value is eventually validated against again, has no comma tolerance
    // at all and would refuse the raw text outright.
    const validated = mustBeNumber({ label: 'Amount' })('12,500');
    expect(validated).toBeUndefined();

    const stored = fieldValue('12,500', decimal);
    expect(stored).toBe('12500');
    expect(decimalString.safeParse(stored).success).toBe(true);
  });

  it('parses an integer, because a month count is a count', () => {
    expect(fieldValue('60', integer)).toBe(60);
    expect(fieldValue('', integer)).toBe(0);
  });

  it('reads a boolean and a schedule', () => {
    expect(fieldValue('true', bool)).toBe(true);
    expect(fieldValue('false', bool)).toBe(false);
    expect(fieldValue('1000, 1100,1200', schedule)).toEqual(['1000', '1100', '1200']);
    expect(fieldValue('  ', schedule)).toEqual([]);
  });

  it('turns an empty optional field into null rather than an empty string', () => {
    // A rate floor of "" is not a floor of zero, and storing "" would make the
    // engine read one.
    expect(fieldValue('', decimal)).toBeNull();
    expect(fieldValue('', { key: 'indexCurve', label: 'Curve', kind: 'curve' })).toBeNull();
  });

  it('renders a stored value back into its control', () => {
    expect(fieldText({ amount: '1234.55' }, decimal)).toBe('1234.55');
    expect(fieldText({ repayOnSale: true }, bool)).toBe('true');
    expect(fieldText({ monthlySchedule: ['1', '2'] }, schedule)).toBe('1, 2');
    expect(fieldText({ amount: null }, decimal)).toBe('');
    expect(
      fieldText(
        { fundingDate: '2026-01-01T00:00:00.000Z' },
        {
          key: 'fundingDate',
          label: 'Funds',
          kind: 'date',
        },
      ),
    ).toBe('2026-01-01');
  });
});

describe('the operating expense editor', () => {
  it('offers a monthly schedule only to the method that reads one', () => {
    /*
     * The whole point of replacing the JSON view. A `fixed_annual` expense
     * showing a twelve-month schedule invites somebody to fill it in and then
     * wonder why nothing moved.
     */
    const fixed = visibleFields(EXPENSE_SPEC, { method: 'fixed_annual' });
    expect(keys(fixed)).toContain('amount');
    expect(keys(fixed)).not.toContain('monthlySchedule');

    const scheduled = visibleFields(EXPENSE_SPEC, { method: 'custom_monthly_schedule' });
    expect(keys(scheduled)).toContain('monthlySchedule');
    // And the single amount goes, because the schedule is the amount.
    expect(keys(scheduled)).not.toContain('amount');
  });

  it('hides the growth curve from a percentage-based expense', () => {
    // A management fee at 3% of revenue follows the revenue it is charged on;
    // a curve on top of it would compound growth twice.
    const percentage = visibleFields(EXPENSE_SPEC, {
      method: 'percent_of_effective_gross_revenue',
    });
    expect(keys(percentage)).not.toContain('growthCurve');
    expect(keys(visibleFields(EXPENSE_SPEC, { method: 'fixed_annual' }))).toContain('growthCurve');
  });

  it('reads the amount aloud according to the method', () => {
    const summary = (record: RecordValues): string =>
      EXPENSE_SPEC.summary?.(record).find((entry) => entry.label === 'Reads as')?.value ?? '';

    expect(summary({ method: 'fixed_annual', amount: '120000' })).toBe('120000 per year');
    expect(summary({ method: 'per_area_per_year', amount: '4.5' })).toBe(
      '4.5 per area unit per year',
    );
    expect(summary({ method: 'percent_of_effective_gross_revenue', amount: '0.03' })).toBe(
      '3.00% of effective gross revenue',
    );
    expect(summary({ method: 'custom_monthly_schedule', monthlySchedule: ['1', '2', '3'] })).toBe(
      'A schedule of 3 month(s)',
    );
  });

  it('says where the expense sits relative to NOI', () => {
    const sits = (record: RecordValues): string =>
      EXPENSE_SPEC.summary?.(record).find((entry) => entry.label === 'Sits')?.value ?? '';
    expect(sits({ isCapitalized: true })).toBe('Below NOI');
    expect(sits({ isCapitalized: false })).toBe('Above NOI');
  });

  it('refuses a share above one, which would be more than the whole expense', () => {
    const problems = validate(EXPENSE_SPEC, {
      code: 'E1',
      name: 'Insurance',
      category: 'insurance',
      method: 'fixed_annual',
      amount: '1000',
      recoverableShare: '85',
    });
    expect(problems.recoverableShare).toContain('not a fraction');
  });

  it('requires the fields a record cannot exist without', () => {
    const problems = validate(EXPENSE_SPEC, { method: 'fixed_annual' });
    expect(problems.code).toBeDefined();
    expect(problems.name).toBeDefined();
    expect(problems.amount).toBeDefined();
  });
});

describe('the market leasing editor', () => {
  it('lays renewal and new-lease terms out as a pair', () => {
    // They are read against each other — what you give a tenant to stay versus
    // to arrive — so they must not be two lists you scroll between.
    const renewal = MARKET_LEASING_SPEC.sections.find((s) => s.title === 'If the tenant renews');
    expect(renewal?.pairWithNext).toBe(true);
    const index = MARKET_LEASING_SPEC.sections.indexOf(renewal!);
    expect(MARKET_LEASING_SPEC.sections[index + 1]?.title).toBe('If the tenant leaves');
  });

  it('shows an escalation rate only once a type has been chosen', () => {
    expect(
      keys(visibleFields(MARKET_LEASING_SPEC, { renewalEscalation: { type: 'none' } })),
    ).not.toContain('renewalEscalation.rate');
    expect(
      keys(visibleFields(MARKET_LEASING_SPEC, { renewalEscalation: { type: 'fixed_percent' } })),
    ).toContain('renewalEscalation.rate');
  });

  it('shows an expense stop only to the method that has one', () => {
    expect(
      keys(visibleFields(MARKET_LEASING_SPEC, { recovery: { method: 'triple_net' } })),
    ).not.toContain('recovery.expenseStopPerArea');
    expect(
      keys(visibleFields(MARKET_LEASING_SPEC, { recovery: { method: 'expense_stop' } })),
    ).toContain('recovery.expenseStopPerArea');
  });

  it('weights the cost of a rollover across both branches', () => {
    /*
     * The arithmetic analysts most often get wrong by eye. 70% renewal with 10
     * of renewal TI against 50 of new TI is not "somewhere in between" — it is
     * 0.7 × 10 + 0.3 × 50 = 22.
     */
    const summary = MARKET_LEASING_SPEC.summary?.({
      renewalProbability: '0.7',
      renewalTiPerArea: '10',
      newTiPerArea: '50',
      downtimeMonths: '6',
    });
    expect(summary?.find((entry) => entry.label === 'Weighted TI')?.value).toBe('22.00');
    // Downtime lands only on the new-lease branch, so it is weighted too.
    expect(summary?.find((entry) => entry.label === 'Vacancy on turnover')?.value).toBe(
      '1.8 months',
    );
  });

  it('refuses a renewal probability that is not a fraction', () => {
    const problems = validate(MARKET_LEASING_SPEC, {
      code: 'MLA',
      name: 'Office standard',
      marketRent: '30',
      renewalProbability: '70',
    });
    expect(problems.renewalProbability).toContain('not a fraction');
  });
});

describe('the debt editor', () => {
  it('shows the index terms to a floating loan and the fixed rate to a fixed one', () => {
    const fixed = keys(visibleFields(DEBT_SPEC, { rateType: 'fixed' }));
    expect(fixed).toContain('fixedRate');
    expect(fixed).not.toContain('spread');
    expect(fixed).not.toContain('indexCurve');
    expect(fixed).not.toContain('rateFloor');

    const floating = keys(visibleFields(DEBT_SPEC, { rateType: 'floating' }));
    expect(floating).toContain('indexCurve');
    expect(floating).toContain('spread');
    expect(floating).toContain('rateFloor');
    expect(floating).toContain('rateCap');
    expect(floating).not.toContain('fixedRate');
  });

  it('describes the amortisation structure in words', () => {
    const structure = (record: RecordValues): string =>
      DEBT_SPEC.summary?.(record).find((entry) => entry.label === 'Structure')?.value ?? '';

    expect(structure({ termMonths: 60, interestOnlyMonths: 0, amortizationMonths: 0 })).toBe(
      '60 months, interest only',
    );
    expect(structure({ termMonths: 120, interestOnlyMonths: 0, amortizationMonths: 360 })).toBe(
      '120 months, amortising over 360',
    );
    expect(structure({ termMonths: 120, interestOnlyMonths: 24, amortizationMonths: 360 })).toBe(
      '24 months interest only, then amortising over 360',
    );
  });

  it('flags a facility that amortises to nothing before it matures', () => {
    // Legal, and almost always a typo: an analyst meant a 360-month schedule
    // and typed 60. The loan silently repays itself and the levered return
    // looks better than the deal.
    const checks = DEBT_SPEC.summary?.({
      termMonths: 120,
      interestOnlyMonths: 0,
      amortizationMonths: 60,
    }).filter((entry) => entry.label === 'Check');
    expect(checks?.[0]?.value).toContain('Amortises to zero before maturity');
  });

  it('flags funding above the commitment', () => {
    const checks = DEBT_SPEC.summary?.({
      commitment: '5000000',
      initialFunding: '6000000',
      termMonths: 60,
    }).filter((entry) => entry.label === 'Check');
    expect(checks?.some((entry) => entry.value.includes('exceeds the commitment'))).toBe(true);
  });

  it('leaves a facility with sound terms unflagged', () => {
    const checks = DEBT_SPEC.summary?.({
      commitment: '5000000',
      initialFunding: '5000000',
      termMonths: 120,
      interestOnlyMonths: 24,
      amortizationMonths: 360,
      rateType: 'fixed',
      fixedRate: '0.055',
    }).filter((entry) => entry.label === 'Check');
    expect(checks).toEqual([]);
  });

  it('refuses a DSCR entered as a fraction', () => {
    // 1.20 is the covenant; 0.012 is somebody who thought it was a percentage.
    expect(validate(DEBT_SPEC, { minimumDscr: '-1' }).minimumDscr).toContain('cannot be below');
  });
});

describe('the specs as a set', () => {
  it('covers the three collections whose records are structured', () => {
    expect(Object.keys(RECORD_SPECS).sort()).toEqual(['debt', 'expenses', 'market-leasing']);
  });

  it('gives every field a label, and every non-obvious one an explanation', () => {
    /*
     * A field an analyst cannot interpret is a field they will guess at. This
     * does not demand help on everything — "Name" needs none — but on anything
     * whose meaning is a CRE convention rather than plain English.
     */
    const needsHelp =
      /share|escalation|stop|fee|curve|precedence|probability|amorti|capitalis|dscr|ltv|ltc|yield|downtime|commission/i;
    for (const spec of Object.values(RECORD_SPECS)) {
      for (const section of spec.sections) {
        for (const field of section.fields) {
          expect(field.label, `${spec.segment} field ${field.key} has no label`).toBeTruthy();
          if (needsHelp.test(field.key)) {
            expect(
              field.help ?? section.description,
              `${spec.segment}.${field.key} needs an explanation`,
            ).toBeTruthy();
          }
        }
      }
    }
  });

  it('marks the code fixed on every spec, because other records point at it', () => {
    for (const spec of Object.values(RECORD_SPECS)) {
      const code = spec.sections.flatMap((section) => section.fields).find((f) => f.key === 'code');
      expect(code?.fixedAfterCreate, `${spec.segment} lets its code change`).toBe(true);
    }
  });

  it('starts a new record from defaults that already validate', () => {
    // A form that opens with errors on it teaches people to ignore errors.
    for (const spec of Object.values(RECORD_SPECS)) {
      const problems = validate(spec, {
        ...(spec.defaults ?? {}),
        code: 'X',
        name: 'X',
        fundingDate: '2026-01-01',
      });
      expect(Object.keys(problems), `${spec.segment} opens with problems`).toEqual([]);
    }
  });
});
