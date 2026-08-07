import type { CashFlowLine, ModelInput, ModelResult } from '@cre/domain-models';
import type { WorkbookModel } from '../model.js';
import { scheduleColumnWidths, seriesRow } from '../layout.js';
import type { TimeAxis } from '../layout.js';

/**
 * The revenue stack.
 *
 * Every *identity* here is a formula — contractual rent, scheduled rent, gross
 * potential revenue, the vacancy allowances and effective gross revenue are all
 * calculated in the workbook from the lines above them.
 *
 * What stays as engine values are the lease-engine outputs: potential base
 * rent, absorption-and-turnover vacancy, free rent, percentage rent and
 * recoveries. Those come from a per-occurrence simulation over rollover,
 * downtime and market leasing profiles, and reproducing it in Excel formulas
 * would be the second calculation engine this design exists to prevent. They
 * are marked `staticDerived`, so the coverage metric reports them as the gap
 * they are rather than hiding them.
 *
 * ## The vacancy allowance is exact
 *
 * `computeVacancyAllowances` applies the rate to whichever components the model
 * says it applies to, then — when `netAgainstModelledVacancy` is set — nets off
 * the vacancy already modelled lease by lease, flooring at zero so the
 * allowance can never become a credit:
 *
 *   general vacancy = MAX(base x rate - alreadyModelled, 0)
 *
 * `alreadyModelled` is the negation of the absorption line, and the absorption
 * line is stored negative, so in the workbook the subtraction becomes an
 * addition of that cell. That sign is easy to get backwards and is the reason
 * the reconciliation test checks this line specifically.
 */
export function buildRevenue(
  workbook: WorkbookModel,
  input: ModelInput,
  result: ModelResult,
  axis: TimeAxis,
): void {
  const sheet = workbook.sheet('Revenue', {
    freezeRows: 4,
    freezeColumns: 2,
    columnWidths: scheduleColumnWidths(axis),
  });

  sheet.at(sheet.claimRow(), 1, { kind: 'header', value: 'Revenue', format: 'text' });

  const engineValue = (line: CashFlowLine, period: number): number =>
    Number(result.monthly[line][period] ?? '0');

  /** A line the lease engine produced, carried across as a value. */
  const fromEngine = (line: CashFlowLine, label: string, indent = 1): void => {
    seriesRow(sheet, axis, { label, key: `revenue.${line}`, indent }, (period) => ({
      kind: 'staticDerived',
      value: engineValue(line, period),
    }));
  };

  fromEngine('absorptionAndTurnoverVacancy', 'Absorption and turnover vacancy');

  /*
   * Contractual base rent adds up the Rent Roll.
   *
   * Verified against every fixture: the engine's contractual base rent is
   * exactly the sum of the per-lease `baseRent` series. Summing the tenants
   * rather than importing the total is what makes the Rent Roll load-bearing —
   * a revenue figure traces to the leases behind it.
   */
  seriesRow(
    sheet,
    axis,
    { label: 'Contractual base rent', key: 'revenue.contractualBaseRent' },
    (period) => ({
      kind: 'formula',
      formula: (refs) => refs.ref('rentRoll.totalBaseRent', period),
      cachedValue: engineValue('contractualBaseRent', period),
    }),
  );

  // Potential base rent is contractual plus market rent on vacant space, and
  // the absorption line is that same figure negated — so this is a formula
  // rather than another imported total.
  seriesRow(
    sheet,
    axis,
    { label: 'Potential base rent', key: 'revenue.potentialBaseRent' },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        `${refs.ref('revenue.contractualBaseRent', period)}-` +
        `${refs.ref('revenue.absorptionAndTurnoverVacancy', period)}`,
      cachedValue: engineValue('potentialBaseRent', period),
    }),
  );

  fromEngine('freeRent', 'Free rent');

  seriesRow(
    sheet,
    axis,
    { label: 'Scheduled base rent', key: 'revenue.scheduledBaseRent', bold: true },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        `${refs.ref('revenue.contractualBaseRent', period)}+` +
        `${refs.ref('revenue.freeRent', period)}`,
      cachedValue: engineValue('scheduledBaseRent', period),
    }),
  );

  fromEngine('percentageRent', 'Percentage rent');
  fromEngine('expenseRecoveries', 'Expense recoveries');
  fromEngine('otherLeaseRevenue', 'Other lease revenue');
  fromEngine('otherPropertyRevenue', 'Other property revenue');

  seriesRow(
    sheet,
    axis,
    { label: 'Gross potential revenue', key: 'revenue.grossPotentialRevenue', bold: true },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        [
          'revenue.scheduledBaseRent',
          'revenue.percentageRent',
          'revenue.expenseRecoveries',
          'revenue.otherLeaseRevenue',
          'revenue.otherPropertyRevenue',
        ]
          .map((key) => refs.ref(key, period))
          .join('+'),
      cachedValue: engineValue('grossPotentialRevenue', period),
    }),
  );

  /*
   * The base the allowances apply to. Which components are included is a model
   * setting, so it is read from the model rather than assumed — a model that
   * excludes recoveries from the vacancy base would otherwise be exported with
   * a larger allowance than the engine applied.
   */
  const appliesTo = new Set(input.vacancy.appliesTo);
  const componentKeys: string[] = [];
  if (appliesTo.has('base_rent')) componentKeys.push('revenue.scheduledBaseRent');
  if (appliesTo.has('recoveries')) componentKeys.push('revenue.expenseRecoveries');
  if (appliesTo.has('percentage_rent')) componentKeys.push('revenue.percentageRent');
  if (appliesTo.has('other_revenue')) {
    componentKeys.push('revenue.otherLeaseRevenue', 'revenue.otherPropertyRevenue');
  }

  seriesRow(
    sheet,
    axis,
    {
      label: 'Vacancy and credit loss base',
      key: 'revenue.allowanceBase',
      indent: 1,
      note: `Components this model applies allowances to: ${input.vacancy.appliesTo.join(', ')}.`,
    },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        componentKeys.length === 0
          ? '0'
          : componentKeys.map((key) => refs.ref(key, period)).join('+'),
    }),
  );

  seriesRow(sheet, axis, { label: 'General vacancy', key: 'revenue.generalVacancy' }, (period) => ({
    kind: 'formula',
    formula: (refs) => {
      const target = `${refs.ref('revenue.allowanceBase', period)}*${refs.name('GeneralVacancy')}`;
      if (!input.vacancy.netAgainstModelledVacancy) return `-${target}`;
      // Two sign facts at once. The absorption cell is already negative, so
      // netting off vacancy modelled lease by lease is an addition; and the
      // engine reports deductions negative, so the floored allowance is then
      // negated. Both were wrong in the first draft and the identity test
      // caught it.
      return `-MAX(${target}+${refs.ref('revenue.absorptionAndTurnoverVacancy', period)},0)`;
    },
    cachedValue: engineValue('generalVacancy', period),
  }));

  seriesRow(sheet, axis, { label: 'Credit loss', key: 'revenue.creditLoss' }, (period) => ({
    kind: 'formula',
    formula: (refs) => `-${refs.ref('revenue.allowanceBase', period)}*${refs.name('CreditLoss')}`,
    cachedValue: engineValue('creditLoss', period),
  }));

  seriesRow(
    sheet,
    axis,
    { label: 'Effective gross revenue', key: 'revenue.effectiveGrossRevenue', bold: true },
    (period) => ({
      kind: 'formula',
      formula: (refs) =>
        `${refs.ref('revenue.grossPotentialRevenue', period)}+` +
        `${refs.ref('revenue.generalVacancy', period)}+` +
        `${refs.ref('revenue.creditLoss', period)}`,
      cachedValue: engineValue('effectiveGrossRevenue', period),
    }),
  );
}
