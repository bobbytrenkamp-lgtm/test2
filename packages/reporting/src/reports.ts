import type { HealthReport } from '@cre/calculation-engine';
import type { ModelResult } from '@cre/domain-models';

/**
 * Report definitions.
 *
 * A report is a pure function from a calculated model to a table. Keeping them
 * data-only means the same definition drives the on-screen grid, the CSV, the
 * spreadsheet export and the print view, so the three can never disagree about
 * what a report contains.
 */

export interface ReportColumn {
  key: string;
  label: string;
  align: 'left' | 'right';
  format: 'text' | 'currency' | 'percent' | 'area' | 'number' | 'date';
}

export interface ReportTable {
  id: string;
  title: string;
  description: string;
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
  /** Optional totals row rendered separately from the body. */
  totals?: Record<string, string | number | null>;
  footnotes: string[];
}

export interface ReportDefinition {
  id: string;
  title: string;
  category: 'property' | 'portfolio';
  description: string;
  build: (result: ModelResult, context: ReportContext) => ReportTable;
}

export interface ReportContext {
  propertyName: string;
  modelName: string;
  currency: string;
  areaUnit: string;
  /** Fiscal years to include. Empty means every year in the forecast. */
  fiscalYears?: number[];
}

const LINE_LABELS: Record<string, string> = {
  potentialBaseRent: 'Potential base rent',
  absorptionAndTurnoverVacancy: 'Absorption and turnover vacancy',
  contractualBaseRent: 'Contractual base rent',
  freeRent: 'Free rent and abatements',
  scheduledBaseRent: 'Scheduled base rent',
  percentageRent: 'Percentage rent',
  expenseRecoveries: 'Expense recoveries',
  otherLeaseRevenue: 'Other lease revenue',
  otherPropertyRevenue: 'Other property revenue',
  grossPotentialRevenue: 'Gross potential revenue',
  generalVacancy: 'General vacancy',
  creditLoss: 'Credit loss',
  effectiveGrossRevenue: 'Effective gross revenue',
  operatingExpenses: 'Operating expenses',
  netOperatingIncome: 'Net operating income',
  tenantImprovements: 'Tenant improvements',
  leasingCommissions: 'Leasing commissions',
  capitalExpenditures: 'Capital expenditures',
  unleveredCashFlow: 'Unlevered cash flow',
  debtProceeds: 'Debt proceeds',
  interestExpense: 'Interest expense',
  principalAmortization: 'Principal amortization',
  financingFees: 'Financing fees',
  leveredCashFlow: 'Levered cash flow',
  grossSaleProceeds: 'Gross sale proceeds',
  sellingCosts: 'Selling costs',
  debtPayoff: 'Debt payoff',
  netDispositionProceeds: 'Net disposition proceeds',
  netCashFlow: 'Net cash flow',
};

/** Annual cash flow: line items down, fiscal years across. */
export const annualCashFlowReport: ReportDefinition = {
  id: 'annual-cash-flow',
  title: 'Annual cash flow',
  category: 'property',
  description: 'The full revenue-to-cash-flow line stack, summarised by fiscal year.',
  build(result, context) {
    const years = context.fiscalYears?.length
      ? result.annual.filter((row) => context.fiscalYears?.includes(row.fiscalYear))
      : result.annual;

    const columns: ReportColumn[] = [
      { key: 'line', label: 'Line item', align: 'left', format: 'text' },
      ...years.map((row) => ({
        key: `fy${row.fiscalYear}`,
        label: row.months === 12 ? `FY${row.fiscalYear}` : `FY${row.fiscalYear} (${row.months}m)`,
        align: 'right' as const,
        format: 'currency' as const,
      })),
    ];

    const rows = Object.entries(LINE_LABELS).map(([key, label]) => {
      const row: Record<string, string | number | null> = { line: label };
      for (const year of years) {
        row[`fy${year.fiscalYear}`] = year.lines[key as keyof typeof year.lines];
      }
      return row;
    });

    return {
      id: this.id,
      title: `${context.propertyName} - annual cash flow`,
      description: `${context.modelName}. Amounts in ${context.currency}. Deductions are shown as negative.`,
      columns,
      rows,
      footnotes: [
        `Calculated by engine version ${result.engineVersion} on ${result.calculatedAt}.`,
        'General vacancy is net of the absorption and turnover vacancy already modelled lease by lease.',
      ],
    };
  },
};

/** Rent roll as at the first forecast period. */
export const rentRollReport: ReportDefinition = {
  id: 'rent-roll',
  title: 'Rent roll',
  category: 'property',
  description: 'Contract leases in place at the start of the forecast.',
  build(result, context) {
    const contracts = result.leaseCashFlows.filter((lease) => lease.scenario === 'contract');
    const rows = contracts.map((lease) => {
      const annualRent = lease.baseRent.slice(0, 12).reduce((acc, value) => acc + Number(value), 0);
      const area = Number(lease.occupiedArea[0] ?? '0');
      return {
        tenant: lease.tenantName,
        lease: lease.leaseId,
        area: area.toFixed(0),
        annualRent: annualRent.toFixed(2),
        rentPerArea: area > 0 ? (annualRent / area).toFixed(2) : '0.00',
        recoveries: lease.recoveries
          .slice(0, 12)
          .reduce((acc, v) => acc + Number(v), 0)
          .toFixed(2),
      };
    });

    const totalArea = rows.reduce((acc, row) => acc + Number(row.area), 0);
    const totalRent = rows.reduce((acc, row) => acc + Number(row.annualRent), 0);

    return {
      id: this.id,
      title: `${context.propertyName} - rent roll`,
      description: `Contract leases in place at the forecast start. Area in ${context.areaUnit}.`,
      columns: [
        { key: 'tenant', label: 'Tenant', align: 'left', format: 'text' },
        { key: 'lease', label: 'Lease', align: 'left', format: 'text' },
        { key: 'area', label: 'Area', align: 'right', format: 'area' },
        { key: 'annualRent', label: 'Year 1 base rent', align: 'right', format: 'currency' },
        {
          key: 'rentPerArea',
          label: `Rent per ${context.areaUnit}`,
          align: 'right',
          format: 'currency',
        },
        { key: 'recoveries', label: 'Year 1 recoveries', align: 'right', format: 'currency' },
      ],
      rows,
      totals: {
        tenant: `${rows.length} lease(s)`,
        area: totalArea.toFixed(0),
        annualRent: totalRent.toFixed(2),
        rentPerArea: totalArea > 0 ? (totalRent / totalArea).toFixed(2) : '0.00',
      },
      footnotes: [
        'Rollover leases generated by the market leasing assumptions are excluded; see the lease-expiration schedule for rollover exposure.',
      ],
    };
  },
};

export const valuationSummaryReport: ReportDefinition = {
  id: 'valuation-summary',
  title: 'Valuation summary',
  category: 'property',
  description: 'Concluded value by method, with the inputs each method used.',
  build(result, context) {
    const rows: Array<Record<string, string | null>> = [];
    for (const valuation of result.valuations) {
      rows.push({
        method: valuation.method === 'dcf' ? 'Discounted cash flow' : 'Direct capitalization',
        item: 'Concluded value',
        value: valuation.value,
      });
      for (const [key, value] of Object.entries(valuation.detail)) {
        rows.push({
          method: '',
          item: key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
          value,
        });
      }
    }
    return {
      id: this.id,
      title: `${context.propertyName} - valuation summary`,
      description: `${context.modelName}. Amounts in ${context.currency}.`,
      columns: [
        { key: 'method', label: 'Method', align: 'left', format: 'text' },
        { key: 'item', label: 'Input or result', align: 'left', format: 'text' },
        { key: 'value', label: 'Value', align: 'right', format: 'text' },
      ],
      rows,
      footnotes: [`Engine version ${result.engineVersion}.`],
    };
  },
};

export const returnSummaryReport: ReportDefinition = {
  id: 'return-summary',
  title: 'Return summary',
  category: 'property',
  description: 'Levered and unlevered returns, yields and credit metrics.',
  build(result, context) {
    const entries: Array<[string, string | null]> = [
      ['Unlevered IRR', result.returns.unleveredIrr],
      ['Levered IRR', result.returns.leveredIrr],
      ['Unlevered XIRR (actual dates)', result.returns.unleveredXirr],
      ['Levered XIRR (actual dates)', result.returns.leveredXirr],
      ['Equity multiple', result.returns.equityMultiple],
      ['Net present value', result.returns.netPresentValue],
      ['Profit', result.returns.profit],
      ['Going-in capitalization rate', result.returns.goingInCapRate],
      ['Stabilized capitalization rate', result.returns.stabilizedCapRate],
      ['Exit capitalization rate', result.returns.exitCapRate],
      ['Yield on cost', result.returns.yieldOnCost],
      ['Average DSCR', result.returns.averageDscr],
      ['Minimum DSCR', result.returns.minimumDscr],
      ['Year 1 debt yield', result.returns.debtYieldYear1],
      ['Loan to value', result.returns.loanToValue],
      ['Loan to cost', result.returns.loanToCost],
      ['Breakeven occupancy', result.returns.breakevenOccupancy],
      [`Value per ${context.areaUnit}`, result.returns.valuePerArea],
      ['Value per unit', result.returns.valuePerUnit],
    ];
    return {
      id: this.id,
      title: `${context.propertyName} - return summary`,
      description: context.modelName,
      columns: [
        { key: 'metric', label: 'Metric', align: 'left', format: 'text' },
        { key: 'value', label: 'Value', align: 'right', format: 'text' },
      ],
      rows: entries.map(([metric, value]) => ({ metric, value: value ?? 'Not available' })),
      footnotes: [
        'A metric reads "Not available" when the model lacks the input it needs, rather than defaulting to zero.',
      ],
    };
  },
};

export const leaseExpirationReport: ReportDefinition = {
  id: 'lease-expiration',
  title: 'Lease expiration schedule',
  category: 'property',
  description: 'Contract lease expiries by fiscal year, with expiring area and rent.',
  build(result, context) {
    const buckets = new Map<number, { area: number; rent: number; count: number }>();
    for (const lease of result.leaseCashFlows) {
      if (lease.scenario !== 'contract') continue;
      let lastOccupied = -1;
      for (let i = lease.occupiedArea.length - 1; i >= 0; i -= 1) {
        if (Number(lease.occupiedArea[i]) > 0) {
          lastOccupied = i;
          break;
        }
      }
      if (lastOccupied < 0 || lastOccupied >= result.periods.length - 1) continue;
      const fiscalYear = result.periods[lastOccupied]?.fiscalYear;
      if (fiscalYear === undefined) continue;
      const bucket = buckets.get(fiscalYear) ?? { area: 0, rent: 0, count: 0 };
      bucket.area += Number(lease.occupiedArea[lastOccupied] ?? 0);
      bucket.rent += lease.baseRent
        .slice(Math.max(0, lastOccupied - 11), lastOccupied + 1)
        .reduce((acc, value) => acc + Number(value), 0);
      bucket.count += 1;
      buckets.set(fiscalYear, bucket);
    }

    const totalArea = Number(result.occupancy[0]?.totalRentableArea ?? '0');
    const rows = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([fiscalYear, bucket]) => ({
        fiscalYear: String(fiscalYear),
        leases: bucket.count,
        expiringArea: bucket.area.toFixed(0),
        percentOfArea: totalArea > 0 ? (bucket.area / totalArea).toFixed(6) : '0',
        expiringRent: bucket.rent.toFixed(2),
      }));

    return {
      id: this.id,
      title: `${context.propertyName} - lease expiration schedule`,
      description: `Expiring area in ${context.areaUnit}; expiring rent is the trailing twelve months at expiry.`,
      columns: [
        { key: 'fiscalYear', label: 'Fiscal year', align: 'left', format: 'text' },
        { key: 'leases', label: 'Leases', align: 'right', format: 'number' },
        { key: 'expiringArea', label: 'Expiring area', align: 'right', format: 'area' },
        { key: 'percentOfArea', label: '% of rentable area', align: 'right', format: 'percent' },
        { key: 'expiringRent', label: 'Expiring rent', align: 'right', format: 'currency' },
      ],
      rows,
      footnotes: [
        'Leases expiring in the final forecast month are excluded because the forecast ends before the rollover would occur.',
      ],
    };
  },
};

export const recoveryDetailReport: ReportDefinition = {
  id: 'recovery-detail',
  title: 'Expense recovery detail',
  category: 'property',
  description: 'The full workings behind every recovery: pool, share, stop, caps and fees.',
  build(result, context) {
    return {
      id: this.id,
      title: `${context.propertyName} - expense recovery detail`,
      description: 'Every figure that produced each tenant reimbursement, by fiscal year.',
      columns: [
        { key: 'leaseId', label: 'Lease', align: 'left', format: 'text' },
        { key: 'fiscalYear', label: 'Fiscal year', align: 'left', format: 'text' },
        // A lease with several pools produces one row per pool per year. Without
        // the pool named, they are indistinguishable.
        { key: 'poolName', label: 'Pool', align: 'left', format: 'text' },
        { key: 'method', label: 'Structure', align: 'left', format: 'text' },
        { key: 'includedCategories', label: 'Included categories', align: 'left', format: 'text' },
        { key: 'tenantArea', label: 'Tenant area', align: 'right', format: 'area' },
        { key: 'denominatorArea', label: 'Denominator', align: 'right', format: 'area' },
        { key: 'proRataShare', label: 'Pro-rata share', align: 'right', format: 'percent' },
        { key: 'grossExpensePool', label: 'Expense pool', align: 'right', format: 'currency' },
        {
          key: 'grossedUpExpensePool',
          label: 'Grossed-up pool',
          align: 'right',
          format: 'currency',
        },
        { key: 'baseYearAmount', label: 'Base year', align: 'right', format: 'currency' },
        { key: 'expenseStopAmount', label: 'Stop', align: 'right', format: 'currency' },
        { key: 'adminFee', label: 'Admin fee', align: 'right', format: 'currency' },
        { key: 'capAdjustment', label: 'Cap adjustment', align: 'right', format: 'currency' },
        { key: 'finalRecovery', label: 'Settled', align: 'right', format: 'currency' },
        {
          key: 'estimatedRecovery',
          label: 'Billed as estimate',
          align: 'right',
          format: 'currency',
        },
        { key: 'trueUpAmount', label: 'True-up', align: 'right', format: 'currency' },
        { key: 'trueUpPeriod', label: 'True-up period', align: 'left', format: 'text' },
      ],
      rows: result.recoveryDetail.map((row) => ({
        ...row,
        fiscalYear: String(row.fiscalYear),
        includedCategories: row.includedCategories.join(', '),
        // Null means either nothing to reconcile or a true-up that fell beyond
        // the forecast; the true-up column distinguishes them.
        trueUpPeriod: row.trueUpPeriodIndex === null ? '-' : String(row.trueUpPeriodIndex + 1),
      })),
      footnotes: [
        `Amounts in ${context.currency}. Annualised where the fiscal year is partial.`,
        "Settled is the year's entitlement. Billed as estimate is what is charged monthly through the year; the true-up is the difference, charged in the period shown. A true-up with no period fell beyond the forecast and is excluded from the cash flow.",
      ],
    };
  },
};

export const debtScheduleReport: ReportDefinition = {
  id: 'debt-schedule',
  title: 'Debt schedule',
  category: 'property',
  description: 'Period-by-period balance, interest, amortization and covenant metrics.',
  build(result, context) {
    const rows: Array<Record<string, string | number | null>> = [];
    for (const schedule of result.debtSchedules) {
      for (const row of schedule.rows) {
        if (
          Number(row.beginningBalance) === 0 &&
          Number(row.draws) === 0 &&
          Number(row.endingBalance) === 0
        ) {
          continue;
        }
        rows.push({
          facility: schedule.facilityName,
          period: row.periodIndex,
          date: result.periods[row.periodIndex - 1]?.startDate ?? '',
          beginningBalance: row.beginningBalance,
          draws: row.draws,
          cashInterest: row.cashInterest,
          capitalizedInterest: row.capitalizedInterest,
          principal: row.principal,
          fees: row.fees,
          endingBalance: row.endingBalance,
          appliedRate: row.appliedRate,
          dscr: row.dscr,
        });
      }
    }
    return {
      id: this.id,
      title: `${context.propertyName} - debt schedule`,
      description: `Amounts in ${context.currency}.`,
      columns: [
        { key: 'facility', label: 'Facility', align: 'left', format: 'text' },
        { key: 'period', label: 'Period', align: 'right', format: 'number' },
        { key: 'date', label: 'Month', align: 'left', format: 'date' },
        { key: 'beginningBalance', label: 'Opening balance', align: 'right', format: 'currency' },
        { key: 'draws', label: 'Draws', align: 'right', format: 'currency' },
        { key: 'cashInterest', label: 'Cash interest', align: 'right', format: 'currency' },
        {
          key: 'capitalizedInterest',
          label: 'Capitalized interest',
          align: 'right',
          format: 'currency',
        },
        { key: 'principal', label: 'Principal', align: 'right', format: 'currency' },
        { key: 'fees', label: 'Fees', align: 'right', format: 'currency' },
        { key: 'endingBalance', label: 'Closing balance', align: 'right', format: 'currency' },
        { key: 'appliedRate', label: 'Rate', align: 'right', format: 'percent' },
        { key: 'dscr', label: 'DSCR', align: 'right', format: 'number' },
      ],
      rows,
      footnotes: [
        'DSCR is computed on trailing twelve-month NOI against annualised debt service for the period.',
        ...result.debtSchedules.flatMap((schedule) =>
          schedule.covenantBreaches.length > 0
            ? [
                `${schedule.facilityName}: ${schedule.covenantBreaches.length} covenant breach(es) detected.`,
              ]
            : [],
        ),
      ],
    };
  },
};

export const modelValidationReport: ReportDefinition = {
  id: 'model-validation',
  title: 'Model validation',
  category: 'property',
  description: 'Every diagnostic the engine raised, by severity.',
  build(result, context) {
    const order = { error: 0, warning: 1, informational: 2, accepted_exception: 3 };
    return {
      id: this.id,
      title: `${context.propertyName} - model validation`,
      description: 'Findings raised while calculating this model.',
      columns: [
        { key: 'severity', label: 'Severity', align: 'left', format: 'text' },
        { key: 'code', label: 'Code', align: 'left', format: 'text' },
        { key: 'subject', label: 'Subject', align: 'left', format: 'text' },
        { key: 'message', label: 'Finding', align: 'left', format: 'text' },
      ],
      rows: [...result.diagnostics]
        .sort((a, b) => order[a.severity] - order[b.severity])
        .map((entry) => ({
          severity: entry.severity,
          code: entry.code,
          subject: entry.subject ?? '',
          message: entry.message,
        })),
      footnotes: [
        'A critical error cannot be acknowledged away; it must be corrected before the model is approved.',
      ],
    };
  },
};

export const occupancyReport: ReportDefinition = {
  id: 'occupancy',
  title: 'Occupancy reconciliation',
  category: 'property',
  description: 'Occupied, available and vacant area against physical and economic occupancy.',
  build(result, context) {
    return {
      id: this.id,
      title: `${context.propertyName} - occupancy reconciliation`,
      description: `Area in ${context.areaUnit}.`,
      columns: [
        { key: 'period', label: 'Period', align: 'right', format: 'number' },
        { key: 'date', label: 'Month', align: 'left', format: 'date' },
        { key: 'totalRentableArea', label: 'Rentable area', align: 'right', format: 'area' },
        { key: 'occupiedArea', label: 'Occupied', align: 'right', format: 'area' },
        { key: 'availableArea', label: 'Available', align: 'right', format: 'area' },
        {
          key: 'physicalOccupancyPercent',
          label: 'Physical occupancy',
          align: 'right',
          format: 'percent',
        },
        {
          key: 'economicOccupancyPercent',
          label: 'Economic occupancy',
          align: 'right',
          format: 'percent',
        },
      ],
      rows: result.occupancy.map((row) => ({
        period: row.periodIndex,
        date: result.periods[row.periodIndex - 1]?.startDate ?? '',
        totalRentableArea: row.totalRentableArea,
        occupiedArea: row.occupiedArea,
        availableArea: row.availableArea,
        physicalOccupancyPercent: row.physicalOccupancyPercent,
        economicOccupancyPercent: row.economicOccupancyPercent,
      })),
      footnotes: [
        'Economic occupancy is effective gross revenue divided by revenue at full occupancy and market rent, so it captures free rent and credit loss as well as empty space.',
      ],
    };
  },
};

export const REPORTS: ReportDefinition[] = [
  annualCashFlowReport,
  rentRollReport,
  valuationSummaryReport,
  returnSummaryReport,
  leaseExpirationReport,
  recoveryDetailReport,
  debtScheduleReport,
  occupancyReport,
  modelValidationReport,
];

export interface IcSummaryContext extends ReportContext {
  acquisitionPrice: string | null;
  rentableArea: string | null;
  modelStatus: string;
}

/**
 * The investment committee summary, as a report table rather than a screen.
 *
 * Not a `ReportDefinition` in `REPORTS`: every other report's `build` takes
 * only a `ModelResult`, but the risk section here reads `HealthReport`,
 * which needs the model's `ModelInput` too (`assessHealth(input, result)`,
 * in `@cre/calculation-engine`) — a route composes this by hand rather than
 * widening the shared interface every other report relies on.
 *
 * Every figure is the same one `ICSummaryTab.tsx` reads from `useModelContext`
 * and `GET /models/:id/health` — `result.returns`, `result.valuations`,
 * `result.debtSchedules`, and the health findings themselves — so the
 * downloaded package can never disagree with the screen a reviewer would
 * otherwise have to visit five tabs to reconstruct by hand.
 */
export function buildIcSummaryReport(
  result: ModelResult,
  health: HealthReport,
  context: IcSummaryContext,
): ReportTable {
  const dcf = result.valuations.find((valuation) => valuation.method === 'dcf');
  const directCap = result.valuations.find(
    (valuation) => valuation.method === 'direct_capitalization',
  );
  const totalDebt = result.debtSchedules.reduce(
    (sum, schedule) => sum + Number(schedule.rows[0]?.beginningBalance ?? '0'),
    0,
  );
  const breaches = result.debtSchedules.flatMap((schedule) => schedule.covenantBreaches);
  const warnings = health.findings.filter((finding) => finding.severity === 'warning');
  const notes = health.findings.filter((finding) => finding.severity === 'note');

  const rows: Array<Record<string, string | null>> = [
    { section: 'Deal snapshot', metric: 'Status', value: context.modelStatus },
    { section: '', metric: 'Acquisition price', value: context.acquisitionPrice },
    {
      section: '',
      metric: 'Rentable area',
      value: context.rentableArea ? `${context.rentableArea} ${context.areaUnit}` : null,
    },
    { section: '', metric: 'Going-in cap rate', value: result.returns.goingInCapRate },
    { section: '', metric: 'Exit cap rate', value: result.returns.exitCapRate },
    { section: '', metric: 'Concluded value (DCF)', value: dcf?.value ?? null },
    {
      section: '',
      metric: 'Concluded value (direct capitalization)',
      value: directCap?.value ?? null,
    },
    { section: 'Returns', metric: 'Unlevered IRR', value: result.returns.unleveredIrr },
    { section: '', metric: 'Levered IRR', value: result.returns.leveredIrr },
    { section: '', metric: 'Equity multiple', value: result.returns.equityMultiple },
    { section: '', metric: 'Net present value', value: result.returns.netPresentValue },
    { section: '', metric: 'Average DSCR', value: result.returns.averageDscr },
    { section: '', metric: 'Minimum DSCR', value: result.returns.minimumDscr },
  ];

  if (result.debtSchedules.length > 0) {
    rows.push(
      {
        section: 'Debt',
        metric: 'Facilities',
        value: result.debtSchedules.map((schedule) => schedule.facilityName).join(', '),
      },
      { section: '', metric: 'Opening balance', value: String(totalDebt) },
      { section: '', metric: 'Debt yield, year 1', value: result.returns.debtYieldYear1 },
      { section: '', metric: 'Covenant breaches', value: String(breaches.length) },
    );
  }

  if (warnings.length === 0 && notes.length === 0) {
    rows.push({
      section: 'Risk',
      metric: 'Health',
      value: 'Nothing crossed a threshold on the last calculation.',
    });
  } else {
    [...warnings, ...notes].forEach((finding, index) => {
      rows.push({
        section: index === 0 ? 'Risk' : '',
        metric: `${finding.severity === 'warning' ? 'Warning' : 'Note'}: ${finding.title}`,
        value: finding.detail,
      });
    });
  }

  return {
    id: 'ic-summary',
    title: `${context.propertyName} - investment committee summary`,
    description: `${context.modelName}. Amounts in ${context.currency}.`,
    columns: [
      { key: 'section', label: 'Section', align: 'left', format: 'text' },
      { key: 'metric', label: 'Metric', align: 'left', format: 'text' },
      { key: 'value', label: 'Value', align: 'right', format: 'text' },
    ],
    rows,
    footnotes: [
      `Calculated by engine version ${result.engineVersion} on ${result.calculatedAt}.`,
      'Read from the same stored calculation the Returns and Health tabs show — nothing here is recomputed.',
    ],
  };
}

export function findReport(id: string): ReportDefinition | null {
  return REPORTS.find((report) => report.id === id) ?? null;
}
