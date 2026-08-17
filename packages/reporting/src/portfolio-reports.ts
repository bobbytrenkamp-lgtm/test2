import type { FundSummary, PortfolioAggregate } from '@cre/calculation-engine';
import type { ReportTable } from './reports.js';

/**
 * Reports above the level of a single asset.
 *
 * A property report answers "how is this building doing". These answer the two
 * questions asked of the level above it — how is the portfolio composed, and
 * what does an investor's position look like — and they take different inputs,
 * so they are a separate definition rather than a `ModelResult` report with a
 * portfolio-shaped hole in it.
 *
 * The investor statement is the one that leaves the building. It is what a
 * manager sends to a limited partner, so every figure on it must be one the
 * platform can defend: each is either recorded (a commitment, a capital call)
 * or derived from recorded figures by arithmetic stated in the footnotes.
 * Nothing on it is estimated.
 */

export interface PortfolioReportContext {
  portfolioName: string;
  currency: string;
  areaUnit: string;
}

export interface PortfolioReportDefinition {
  id: string;
  title: string;
  description: string;
  build: (aggregate: PortfolioAggregate, context: PortfolioReportContext) => ReportTable;
}

export interface FundReportContext {
  fundName: string;
  currency: string;
  /** The date residual value is measured at, which the statement must state. */
  valuationDate: string;
  /** Where the residual value came from, verbatim from the API. */
  residualBasis: string;
}

export interface FundReportDefinition {
  id: string;
  title: string;
  description: string;
  build: (summary: FundSummary, context: FundReportContext) => ReportTable;
}

/* -------------------------------------------------------------------------- */
/* Portfolio                                                                  */
/* -------------------------------------------------------------------------- */

export const portfolioSummaryReport: PortfolioReportDefinition = {
  id: 'portfolio-summary',
  title: 'Portfolio summary',
  description: 'Value, debt, income and the rates the portfolio actually earns.',
  build(aggregate, context) {
    const rows: Array<Record<string, string | number | null>> = [
      { measure: 'Properties', value: String(aggregate.propertyCount), basis: 'Count' },
      {
        measure: 'Gross asset value',
        value: aggregate.grossAssetValue,
        basis: 'Ownership weighted',
      },
      { measure: 'Net asset value', value: aggregate.netAssetValue, basis: 'Gross less debt' },
      { measure: 'Debt', value: aggregate.totalDebt, basis: 'Ownership weighted' },
      {
        measure: 'Year 1 net operating income',
        value: aggregate.year1NetOperatingIncome,
        basis: '',
      },
      {
        measure: 'Going-in capitalisation rate',
        value: aggregate.weightedGoingInCapRate,
        // The rule the portfolio module is built on, restated where a reader of
        // the report will see it rather than only in the code.
        basis: 'Portfolio NOI over portfolio value — not an average of rates',
      },
      {
        measure: 'Exit capitalisation rate',
        value: aggregate.weightedExitCapRate,
        basis: 'Rebuilt from portfolio numerator and denominator',
      },
      { measure: 'Loan to value', value: aggregate.loanToValue, basis: 'Debt over value' },
      {
        measure: 'Physical occupancy',
        value: aggregate.physicalOccupancy,
        basis: 'Occupied over rentable area',
      },
      {
        measure: 'Unlevered IRR',
        value: aggregate.portfolioUnleveredIrr,
        basis: 'Solved from combined portfolio cash flows',
      },
      {
        measure: 'Levered IRR',
        value: aggregate.portfolioLeveredIrr,
        basis: 'Solved from combined portfolio cash flows',
      },
    ];

    return {
      id: this.id,
      title: `${context.portfolioName} — portfolio summary`,
      description: 'Ownership-weighted totals, with the basis of every rate stated.',
      columns: [
        { key: 'measure', label: 'Measure', align: 'left', format: 'text' },
        { key: 'value', label: 'Value', align: 'right', format: 'text' },
        { key: 'basis', label: 'Basis', align: 'left', format: 'text' },
      ],
      rows,
      footnotes: [
        `Amounts in ${context.currency}.`,
        'A rate is never averaged across properties. Each is rebuilt from the portfolio’s own numerator and denominator, which is the only way it stays the rate the portfolio actually earns.',
        'The portfolio IRR is solved from combined cash flows, never averaged from property returns — averaging is wrong whenever the assets differ in size or timing.',
      ],
    };
  },
};

export const concentrationReport: PortfolioReportDefinition = {
  id: 'portfolio-concentration',
  title: 'Concentration',
  description: 'Where the value sits, by property type, market and tenant.',
  build(aggregate, context) {
    const rows: Array<Record<string, string | number | null>> = [];
    for (const entry of aggregate.byPropertyType) {
      rows.push({
        dimension: 'Property type',
        key: entry.key,
        value: entry.value,
        share: entry.share,
      });
    }
    for (const entry of aggregate.byMarket) {
      rows.push({ dimension: 'Market', key: entry.key, value: entry.value, share: entry.share });
    }
    for (const entry of aggregate.tenantConcentration) {
      rows.push({
        dimension: 'Tenant',
        key: entry.tenantName,
        value: entry.annualRent,
        share: entry.share,
      });
    }

    return {
      id: this.id,
      title: `${context.portfolioName} — concentration`,
      description: 'Exposure by property type and market on value, and by tenant on annual rent.',
      columns: [
        { key: 'dimension', label: 'Dimension', align: 'left', format: 'text' },
        { key: 'key', label: 'Category', align: 'left', format: 'text' },
        { key: 'value', label: 'Amount', align: 'right', format: 'currency' },
        { key: 'share', label: 'Share', align: 'right', format: 'percent' },
      ],
      rows,
      footnotes: [
        `Amounts in ${context.currency}.`,
        'Property type and market shares are of portfolio value; tenant shares are of annual rent, because a tenant does not own a share of the buildings.',
      ],
    };
  },
};

export const leaseExpirationScheduleReport: PortfolioReportDefinition = {
  id: 'portfolio-lease-expiration',
  title: 'Lease expiration schedule',
  description: 'Area and rent expiring in each fiscal year, across the portfolio.',
  build(aggregate, context) {
    return {
      id: this.id,
      title: `${context.portfolioName} — lease expiration schedule`,
      description: 'The rollover the portfolio has to re-let, year by year.',
      columns: [
        { key: 'fiscalYear', label: 'Fiscal year', align: 'left', format: 'text' },
        {
          key: 'expiringArea',
          label: `Expiring area (${context.areaUnit})`,
          align: 'right',
          format: 'area',
        },
        { key: 'expiringRent', label: 'Expiring rent', align: 'right', format: 'currency' },
      ],
      rows: aggregate.leaseExpirationByYear.map((entry) => ({
        fiscalYear: String(entry.fiscalYear),
        expiringArea: entry.expiringArea,
        expiringRent: entry.expiringRent,
      })),
      footnotes: [
        `Amounts in ${context.currency}; areas in ${context.areaUnit}.`,
        'Contract leases only. Rollover the engine generated against a market leasing profile is a forecast, not an expiry, and mixing the two would overstate the exposure.',
      ],
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Fund                                                                       */
/* -------------------------------------------------------------------------- */

export const investorStatementReport: FundReportDefinition = {
  id: 'fund-investor-statement',
  title: 'Investor statement',
  description: 'Each investor’s commitment, capital called, distributions and position.',
  build(summary, context) {
    const rows = summary.positions.map((position) => ({
      investor: position.investorName,
      class: position.investorClass.toUpperCase(),
      commitment: position.commitment,
      contributed: position.contributed,
      unfunded: position.unfunded,
      percentCalled: position.percentCalled,
      distributed: position.distributed,
      recallableOutstanding: position.recallableOutstanding,
      netAssetValue: position.netAssetValue,
      dpi: position.dpi,
      rvpi: position.rvpi,
      tvpi: position.tvpi,
      netIrr: position.netIrr,
    }));

    return {
      id: this.id,
      title: `${context.fundName} — investor statement at ${context.valuationDate}`,
      description:
        'Position by investor. Every figure is recorded or derived from recorded figures.',
      columns: [
        { key: 'investor', label: 'Investor', align: 'left', format: 'text' },
        { key: 'class', label: 'Class', align: 'left', format: 'text' },
        { key: 'commitment', label: 'Commitment', align: 'right', format: 'currency' },
        { key: 'contributed', label: 'Capital called', align: 'right', format: 'currency' },
        { key: 'unfunded', label: 'Unfunded', align: 'right', format: 'currency' },
        { key: 'percentCalled', label: 'Called', align: 'right', format: 'percent' },
        { key: 'distributed', label: 'Distributed', align: 'right', format: 'currency' },
        {
          key: 'recallableOutstanding',
          label: 'Recallable outstanding',
          align: 'right',
          format: 'currency',
        },
        { key: 'netAssetValue', label: 'Unrealised value', align: 'right', format: 'currency' },
        { key: 'dpi', label: 'DPI', align: 'right', format: 'text' },
        { key: 'rvpi', label: 'RVPI', align: 'right', format: 'text' },
        { key: 'tvpi', label: 'TVPI', align: 'right', format: 'text' },
        { key: 'netIrr', label: 'Net IRR', align: 'right', format: 'percent' },
      ],
      rows,
      totals: {
        investor: 'Fund',
        class: '',
        commitment: summary.totalCommitment,
        contributed: summary.totalContributed,
        unfunded: summary.totalUnfunded,
        percentCalled: summary.percentCalled,
        distributed: summary.totalDistributed,
        recallableOutstanding: summary.totalRecallableOutstanding,
        netAssetValue: summary.netAssetValue,
        dpi: summary.dpi,
        rvpi: summary.rvpi,
        tvpi: summary.tvpi,
        netIrr: summary.netIrr,
      },
      footnotes: [
        `Amounts in ${context.currency}. Unrealised value is measured at ${context.valuationDate}.`,
        context.residualBasis,
        'DPI is distributions over capital called; RVPI is unrealised value over capital called; TVPI is the two together. Each is rebuilt from its own numerator and denominator at every level, so the fund’s figure is not the average of its investors’.',
        'Net IRR is solved from each investor’s own dated flows, with unrealised value treated as received on the valuation date. It is not annualised from a multiple.',
        'Distributed is net of any recall, and recallable outstanding is how much recall right is still live on distributions marked recallable — both are facts the caller records, not inferences. A recall does not restore or expand unfunded commitment. Fund-level carried interest and management fee mechanics are not modelled. Where a partnership agreement provides for either, this statement will differ from one prepared under it.',
      ],
    };
  },
};

export const capitalAccountReport: FundReportDefinition = {
  id: 'fund-capital-account',
  title: 'Capital account',
  description: 'Every call and distribution, in the order they happened.',
  build(summary, context) {
    return {
      id: this.id,
      title: `${context.fundName} — capital account`,
      description: 'The dated flows the fund’s return is solved from.',
      columns: [
        { key: 'date', label: 'Date', align: 'left', format: 'text' },
        { key: 'label', label: 'Movement', align: 'left', format: 'text' },
        { key: 'amount', label: 'Amount', align: 'right', format: 'currency' },
      ],
      rows: summary.cashFlows.map((flow) => ({
        date: flow.date,
        label: flow.label,
        amount: flow.amount,
      })),
      footnotes: [
        `Amounts in ${context.currency}. Capital called is negative to the investor; distributions and unrealised value are positive.`,
        'A return nobody can check is not an answer, so these are the exact flows the net IRR was solved from rather than a summary of them.',
      ],
    };
  },
};

export const PORTFOLIO_REPORTS: PortfolioReportDefinition[] = [
  portfolioSummaryReport,
  concentrationReport,
  leaseExpirationScheduleReport,
];

export const FUND_REPORTS: FundReportDefinition[] = [investorStatementReport, capitalAccountReport];
