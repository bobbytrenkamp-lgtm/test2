import type { DiagnosticSeverity } from './enums.js';

/**
 * Engine output types. Every numeric value leaves the engine as a decimal
 * string so that JSON transport, database storage and report rendering all see
 * the exact figure the engine computed.
 */

export interface PeriodMeta {
  /** 1-based index within the forecast. */
  index: number;
  /** First day of the month, "YYYY-MM-01". */
  startDate: string;
  /** Last day of the month. */
  endDate: string;
  year: number;
  month: number;
  /** Fiscal year the period rolls up into. */
  fiscalYear: number;
  /** 1-based period within the fiscal year. */
  fiscalPeriod: number;
  daysInMonth: number;
}

/** The ordered revenue-to-return line items the engine retains. */
export const CASH_FLOW_LINES = [
  'potentialBaseRent',
  'absorptionAndTurnoverVacancy',
  'contractualBaseRent',
  'freeRent',
  'scheduledBaseRent',
  'percentageRent',
  'expenseRecoveries',
  'otherLeaseRevenue',
  'otherPropertyRevenue',
  'grossPotentialRevenue',
  'generalVacancy',
  'creditLoss',
  'effectiveGrossRevenue',
  'operatingExpenses',
  'netOperatingIncome',
  'tenantImprovements',
  'leasingCommissions',
  'capitalExpenditures',
  'unleveredCashFlow',
  'debtProceeds',
  'interestExpense',
  'principalAmortization',
  'financingFees',
  'leveredCashFlow',
  'grossSaleProceeds',
  'sellingCosts',
  'debtPayoff',
  'netDispositionProceeds',
  'netCashFlow',
] as const;

export type CashFlowLine = (typeof CASH_FLOW_LINES)[number];

/** One line item across every forecast period, as decimal strings. */
export type CashFlowSeries = Record<CashFlowLine, string[]>;

export interface OccupancyReconciliation {
  periodIndex: number;
  totalRentableArea: string;
  occupiedArea: string;
  leasedArea: string;
  availableArea: string;
  physicalVacantArea: string;
  physicalOccupancyPercent: string;
  economicOccupancyPercent: string;
}

export interface LeaseCashFlowRow {
  leaseId: string;
  tenantId: string;
  tenantName: string;
  /** Present when the row is generated rollover rather than a contract lease. */
  rolloverOf?: string;
  scenario?: 'renewal' | 'new_lease' | 'contract';
  baseRent: string[];
  freeRent: string[];
  percentageRent: string[];
  recoveries: string[];
  otherRevenue: string[];
  tenantImprovements: string[];
  leasingCommissions: string[];
  occupiedArea: string[];
}

export interface RecoveryDetailRow {
  leaseId: string;
  fiscalYear: number;
  /**
   * Which pool this row settles. Leases with one implicit pool report the
   * historical `default`, so a reader does not have to know whether the model
   * was written before pools existed.
   */
  poolCode: string;
  poolName: string;
  method: string;
  includedCategories: string[];
  tenantArea: string;
  denominatorArea: string;
  proRataShare: string;
  grossExpensePool: string;
  grossedUpExpensePool: string;
  baseYearAmount: string;
  expenseStopAmount: string;
  recoveryBeforeCaps: string;
  capAdjustment: string;
  adminFee: string;
  /** What the year settles at, before the split between estimate and true-up. */
  finalRecovery: string;
  /** Billed monthly through the year. Equals `finalRecovery` when nothing is estimated. */
  estimatedRecovery: string;
  /** `finalRecovery` less `estimatedRecovery`. Positive when the tenant underpaid. */
  trueUpAmount: string;
  /**
   * The period the true-up lands in, or null when there is none. Null with a
   * non-zero `trueUpAmount` means it fell outside the forecast and was dropped;
   * a diagnostic says so.
   */
  trueUpPeriodIndex: number | null;
}

export interface DebtScheduleRow {
  periodIndex: number;
  beginningBalance: string;
  draws: string;
  capitalizedInterest: string;
  cashInterest: string;
  principal: string;
  fees: string;
  endingBalance: string;
  appliedRate: string;
  dscr: string | null;
  debtYield: string | null;
  ltv: string | null;
}

export interface DebtSchedule {
  facilityId: string;
  facilityName: string;
  rows: DebtScheduleRow[];
  covenantBreaches: Array<{ periodIndex: number; covenant: string; value: string; limit: string }>;
}

export interface ValuationResult {
  method: 'dcf' | 'direct_capitalization';
  /** Concluded value for the method. */
  value: string;
  detail: Record<string, string>;
  /** Per-period present value detail, DCF only. */
  presentValueByPeriod?: Array<{
    periodIndex: number;
    cashFlow: string;
    discountFactor: string;
    presentValue: string;
  }>;
}

export interface ReturnMetrics {
  unleveredIrr: string | null;
  leveredIrr: string | null;
  unleveredXirr: string | null;
  leveredXirr: string | null;
  equityMultiple: string | null;
  netPresentValue: string | null;
  profit: string | null;
  goingInCapRate: string | null;
  stabilizedCapRate: string | null;
  exitCapRate: string | null;
  yieldOnCost: string | null;
  cashOnCashByYear: Array<{ fiscalYear: number; value: string }>;
  averageDscr: string | null;
  minimumDscr: string | null;
  debtYieldYear1: string | null;
  loanToValue: string | null;
  loanToCost: string | null;
  breakevenOccupancy: string | null;
  valuePerArea: string | null;
  valuePerUnit: string | null;
}

export interface WaterfallDistribution {
  partnerId: string;
  partnerName: string;
  contributions: string;
  distributions: string;
  profit: string;
  irr: string | null;
  equityMultiple: string | null;
  byTier: Array<{ tierId: string; tierName: string; amount: string }>;
}

/**
 * A single recorded step of the calculation. Traces are what make the numbers
 * auditable: every material output can be walked back to the assumption and
 * formula that produced it.
 */
export interface TraceEntry {
  /** Stable identifier of the produced value, e.g. "lease:L1:baseRent:24". */
  target: string;
  /** Formula identifier, e.g. "lease.baseRent.step". */
  formula: string;
  formulaVersion: string;
  /** Human readable explanation of what the formula did. */
  description: string;
  inputs: Record<string, string>;
  result: string;
  /** Record ids the value depends on. */
  sources: string[];
  periodIndex?: number;
  rounding?: string;
}

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  /** Entity the finding relates to, e.g. "lease:L1". */
  subject?: string;
  field?: string;
}

export interface AnnualSummaryRow {
  fiscalYear: number;
  /** Number of forecast months rolled into this year (12 except at the ends). */
  months: number;
  lines: Record<CashFlowLine, string>;
}

export interface ModelResult {
  engineVersion: string;
  modelId: string;
  calculatedAt: string;
  currency: string;
  areaUnit: string;
  periods: PeriodMeta[];
  monthly: CashFlowSeries;
  annual: AnnualSummaryRow[];
  occupancy: OccupancyReconciliation[];
  leaseCashFlows: LeaseCashFlowRow[];
  recoveryDetail: RecoveryDetailRow[];
  debtSchedules: DebtSchedule[];
  valuations: ValuationResult[];
  returns: ReturnMetrics;
  waterfall: WaterfallDistribution[];
  diagnostics: Diagnostic[];
  trace: TraceEntry[];
}
