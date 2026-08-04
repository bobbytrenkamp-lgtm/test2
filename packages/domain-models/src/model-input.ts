import { z } from 'zod';
import {
  areaUnitEnum,
  debtTypeEnum,
  decimalString,
  escalationTypeEnum,
  expenseMethodEnum,
  isoDate,
  leaseStatusEnum,
  propertyTypeEnum,
  recoveryMethodEnum,
  rentBasisEnum,
} from './enums.js';

/**
 * The complete, self-contained input to the calculation engine.
 *
 * Everything the engine needs to produce a cash flow must appear here. The
 * engine never reads the database, the session, or the clock, which is what
 * makes a given (engineVersion, ModelInput) pair reproducible forever.
 */

/* -------------------------------------------------------------------------- */
/* Forecast calendar                                                          */
/* -------------------------------------------------------------------------- */

export const prorationConventionEnum = z.enum([
  /** Partial periods are prorated by actual days in the month. */
  'actual_days',
  /** Every month counts as 1/12 regardless of length. */
  'thirty_360',
  /** Rent is billed in full for any month the lease touches. */
  'full_month',
]);

export const forecastSchema = z.object({
  /** First day of the first forecast month. Coerced to the 1st internally. */
  startDate: isoDate,
  /** Number of monthly periods in the explicit forecast. */
  months: z.number().int().min(1).max(600),
  /** 1 = January. Drives annual roll-ups and base-year windows. */
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  proration: prorationConventionEnum.default('actual_days'),
});
export type Forecast = z.infer<typeof forecastSchema>;

/* -------------------------------------------------------------------------- */
/* Growth / index curves                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A named curve of annual growth rates. `defaultRate` applies to any year not
 * explicitly listed. Years are offsets from the forecast start (1 = first
 * forecast year), which keeps curves reusable across valuation dates.
 */
export const growthCurveSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  defaultRate: decimalString.default('0'),
  byYear: z.array(z.object({ year: z.number().int().min(1), rate: decimalString })).default([]),
});
export type GrowthCurve = z.infer<typeof growthCurveSchema>;

/* -------------------------------------------------------------------------- */
/* Physical structure                                                         */
/* -------------------------------------------------------------------------- */

export const spaceSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  buildingId: z.string().nullish(),
  floor: z.string().nullish(),
  /** Rentable area in the model's area unit. */
  area: decimalString,
  spaceType: z.string().default('office'),
  /** Units represented by this space (multifamily / storage / parking). */
  unitCount: z.number().int().min(0).default(0),
  /** Excluded from the recovery denominator and from occupancy statistics. */
  isNonRevenue: z.boolean().default(false),
  /** Market leasing profile used when the space is or becomes vacant. */
  marketLeasingProfileId: z.string().nullish(),
});
export type Space = z.infer<typeof spaceSchema>;

/* -------------------------------------------------------------------------- */
/* Lease                                                                      */
/* -------------------------------------------------------------------------- */

export const rentStepSchema = z.object({
  /** Date the new rate takes effect. */
  startDate: isoDate,
  amount: decimalString,
  basis: rentBasisEnum,
});

export const escalationSchema = z.object({
  type: escalationTypeEnum.default('none'),
  /** Percentage as a decimal fraction: "0.03" is 3%. */
  rate: decimalString.default('0'),
  /** Currency amount per area unit per year for `fixed_amount`. */
  amount: decimalString.default('0'),
  /** Growth curve consulted when type is `index`. */
  indexCurveId: z.string().nullish(),
  /** Months between escalations. 12 = annual. */
  frequencyMonths: z.number().int().min(1).default(12),
  /** First escalation date. Defaults to the first lease anniversary. */
  firstEscalationDate: isoDate.nullish(),
  compounding: z.boolean().default(true),
  floorRate: decimalString.nullish(),
  capRate: decimalString.nullish(),
});
export type Escalation = z.infer<typeof escalationSchema>;

export const freeRentSchema = z.object({
  startDate: isoDate,
  months: z.number().min(0),
  /** 1 = fully abated, 0.5 = half abated. */
  abatementShare: decimalString.default('1'),
  /** Which components the abatement touches. */
  appliesTo: z.array(z.enum(['base_rent', 'recoveries', 'other'])).default(['base_rent']),
});

export const percentageRentSchema = z.object({
  enabled: z.boolean().default(false),
  /** Annual sales for the first forecast year, in currency. */
  baseSales: decimalString.default('0'),
  salesGrowthCurveId: z.string().nullish(),
  /** Overage percentage as a fraction, e.g. "0.06". */
  overagePercent: decimalString.default('0'),
  /**
   * `natural` derives the breakpoint from base rent / overagePercent.
   * `artificial` uses `breakpointAmount`. `none` charges from the first dollar.
   */
  breakpointType: z.enum(['natural', 'artificial', 'none']).default('natural'),
  breakpointAmount: decimalString.default('0'),
  /** Sales excluded from the calculation, as an annual currency amount. */
  exclusions: decimalString.default('0'),
});

export const recoveryConfigSchema = z.object({
  method: recoveryMethodEnum.default('none'),
  /**
   * Categories the tenant reimburses. Empty means "every category flagged
   * recoverable at the expense level".
   */
  includedCategories: z.array(z.string()).default([]),
  excludedCategories: z.array(z.string()).default([]),
  /** Fiscal year used as the base year, e.g. 2026. Null = first forecast year. */
  baseYear: z.number().int().nullish(),
  /** Stop expressed per area unit per year. */
  expenseStopPerArea: decimalString.nullish(),
  /** Fixed annual recovery for `fixed_amount`, escalated by `fixedEscalation`. */
  fixedAmount: decimalString.nullish(),
  fixedEscalationRate: decimalString.default('0'),
  /**
   * Denominator override for the tenant's pro-rata share. When absent the
   * engine uses total revenue-producing area from the space list.
   */
  proRataShareOverride: decimalString.nullish(),
  /** Gross up variable expenses to this occupancy before allocating. */
  grossUpPercent: decimalString.nullish(),
  /** Administrative markup on recovered amounts, e.g. "0.15". */
  adminFeePercent: decimalString.default('0'),
  /** Maximum year-over-year increase in the recovered amount. */
  capPercent: decimalString.nullish(),
  capIsCumulative: z.boolean().default(false),
  /** Minimum recovery growth, applied the same way as the cap. */
  floorPercent: decimalString.nullish(),
});
export type RecoveryConfig = z.infer<typeof recoveryConfigSchema>;

export const leaseOptionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['renewal', 'expansion', 'contraction', 'termination', 'purchase', 'rofr', 'rofo']),
  exerciseDate: isoDate,
  noticeDate: isoDate.nullish(),
  /** Probability the option is exercised, "0".."1". */
  probability: decimalString.default('0'),
  termMonths: z.number().int().min(0).default(0),
  /** How rent is set if exercised. */
  rentMethod: z.enum(['fixed', 'market', 'percent_of_market', 'prior_rent']).default('market'),
  rentAmount: decimalString.nullish(),
  rentBasis: rentBasisEnum.nullish(),
  /** One-off cost of exercise (termination fee, expansion TI, etc.). */
  cost: decimalString.default('0'),
  areaChange: decimalString.default('0'),
});
export type LeaseOption = z.infer<typeof leaseOptionSchema>;

export const leasingCostSchema = z.object({
  /** Tenant improvement allowance. */
  tiPerArea: decimalString.default('0'),
  tiTotal: decimalString.default('0'),
  /** Leasing commission expressed as a percent of total lease base rent. */
  lcPercentOfRent: decimalString.default('0'),
  lcPerArea: decimalString.default('0'),
  lcTotal: decimalString.default('0'),
  /** Month, relative to lease commencement, the cost is paid. Negative = before. */
  paymentOffsetMonths: z.number().int().default(0),
  otherCosts: decimalString.default('0'),
});

export const leaseSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  spaceIds: z.array(z.string().min(1)).default([]),
  status: leaseStatusEnum,
  /** Rentable area attributed to the lease. */
  area: decimalString,
  unitCount: z.number().int().min(0).default(0),

  commencementDate: isoDate,
  /** Date rent begins if later than commencement. */
  rentStartDate: isoDate.nullish(),
  expirationDate: isoDate,

  /** Opening rent. Steps override it from their start dates onward. */
  baseRent: decimalString,
  baseRentBasis: rentBasisEnum,
  rentSteps: z.array(rentStepSchema).default([]),
  escalation: escalationSchema.default({}),
  freeRent: z.array(freeRentSchema).default([]),
  percentageRent: percentageRentSchema.default({}),
  recovery: recoveryConfigSchema.default({}),
  options: z.array(leaseOptionSchema).default([]),
  leasingCosts: leasingCostSchema.default({}),

  /** Other recurring lease revenue (parking, storage, signage). */
  otherRevenue: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        monthlyAmount: decimalString,
        growthCurveId: z.string().nullish(),
      }),
    )
    .default([]),

  /** Profile that governs rollover when this lease expires. */
  marketLeasingProfileId: z.string().nullish(),
  /** Suppresses rollover modelling, e.g. for a lease already re-signed. */
  excludeFromRollover: z.boolean().default(false),
  notes: z.string().nullish(),
});
export type Lease = z.infer<typeof leaseSchema>;

export const tenantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentCompany: z.string().nullish(),
  industry: z.string().nullish(),
  creditRating: z.string().nullish(),
  isAnchor: z.boolean().default(false),
});
export type Tenant = z.infer<typeof tenantSchema>;

/* -------------------------------------------------------------------------- */
/* Market leasing assumptions                                                 */
/* -------------------------------------------------------------------------- */

export const marketLeasingProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Market rent at the forecast start, grown by `marketRentGrowthCurveId`. */
  marketRent: decimalString,
  marketRentBasis: rentBasisEnum,
  marketRentGrowthCurveId: z.string().nullish(),
  /** Probability an expiring tenant renews, "0".."1". */
  renewalProbability: decimalString.default('0.65'),
  renewalTermMonths: z.number().int().min(1).default(60),
  newLeaseTermMonths: z.number().int().min(1).default(60),
  /** Months of vacancy between leases, weighted by (1 - renewalProbability). */
  downtimeMonths: z.number().min(0).default(6),
  renewalFreeRentMonths: z.number().min(0).default(0),
  newFreeRentMonths: z.number().min(0).default(3),
  renewalTiPerArea: decimalString.default('0'),
  newTiPerArea: decimalString.default('0'),
  renewalLcPercent: decimalString.default('0'),
  newLcPercent: decimalString.default('0'),
  renewalEscalation: escalationSchema.default({}),
  newEscalation: escalationSchema.default({}),
  recovery: recoveryConfigSchema.default({}),
  /**
   * Precedence when several profiles could apply. Higher wins. The engine
   * resolves lease -> space -> property default, and records the winner in the
   * calculation trace.
   */
  precedence: z.number().int().default(0),
});
export type MarketLeasingProfile = z.infer<typeof marketLeasingProfileSchema>;

/* -------------------------------------------------------------------------- */
/* Property revenue and expenses                                              */
/* -------------------------------------------------------------------------- */

export const otherPropertyRevenueSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().default('other'),
  method: z.enum([
    'fixed_annual',
    'per_unit_per_month',
    'per_area_per_year',
    'percent_of_base_rent',
    'custom_monthly_schedule',
  ]),
  amount: decimalString.default('0'),
  growthCurveId: z.string().nullish(),
  /** Scales the amount by physical occupancy when true. */
  varyWithOccupancy: z.boolean().default(false),
  monthlySchedule: z.array(decimalString).default([]),
});
export type OtherPropertyRevenue = z.infer<typeof otherPropertyRevenueSchema>;

export const operatingExpenseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Account code used for recovery pools and reporting hierarchy. */
  category: z.string().min(1),
  accountCode: z.string().nullish(),
  method: expenseMethodEnum,
  amount: decimalString.default('0'),
  growthCurveId: z.string().nullish(),
  /** Share of the expense that is recoverable from tenants, "0".."1". */
  recoverableShare: decimalString.default('0'),
  /**
   * Portion of the expense that varies with occupancy, "0".."1". Used both for
   * forecasting the expense and for grossing up recoveries.
   */
  variableShare: decimalString.default('0'),
  monthlySchedule: z.array(decimalString).default([]),
  /** Capitalized costs sit below NOI. */
  isCapitalized: z.boolean().default(false),
});
export type OperatingExpense = z.infer<typeof operatingExpenseSchema>;

/* -------------------------------------------------------------------------- */
/* Vacancy and capital                                                        */
/* -------------------------------------------------------------------------- */

export const vacancySchema = z.object({
  /** General vacancy allowance as a fraction of gross potential revenue. */
  generalVacancyRate: decimalString.default('0'),
  /**
   * Absorption-and-turnover vacancy already modelled lease-by-lease is netted
   * out of the general allowance when true, which is what prevents the same
   * vacancy being deducted twice.
   */
  netAgainstModelledVacancy: z.boolean().default(true),
  creditLossRate: decimalString.default('0'),
  /** Components the allowances are applied against. */
  appliesTo: z
    .array(z.enum(['base_rent', 'recoveries', 'percentage_rent', 'other_revenue']))
    .default(['base_rent', 'recoveries', 'other_revenue']),
});
export type VacancyAssumptions = z.infer<typeof vacancySchema>;

export const capitalItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.enum([
    'recurring_capital',
    'replacement_reserve',
    'major_project',
    'building_improvement',
    'deferred_maintenance',
    'development_hard_cost',
    'development_soft_cost',
    'contingency',
    'other',
  ]),
  method: z.enum([
    'fixed_annual',
    'per_area_per_year',
    'per_unit_per_year',
    'custom_monthly_schedule',
    'one_time',
  ]),
  amount: decimalString.default('0'),
  startDate: isoDate.nullish(),
  endDate: isoDate.nullish(),
  growthCurveId: z.string().nullish(),
  monthlySchedule: z.array(decimalString).default([]),
  /** Included in the depreciable/holding basis rather than expensed. */
  capitalized: z.boolean().default(true),
  fundingSource: z.string().nullish(),
});
export type CapitalItem = z.infer<typeof capitalItemSchema>;

/* -------------------------------------------------------------------------- */
/* Debt                                                                       */
/* -------------------------------------------------------------------------- */

export const debtDrawSchema = z.object({ date: isoDate, amount: decimalString });

export const debtFacilitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: debtTypeEnum,
  commitment: decimalString,
  initialFunding: decimalString.default('0'),
  fundingDate: isoDate,
  draws: z.array(debtDrawSchema).default([]),

  rateType: z.enum(['fixed', 'floating']).default('fixed'),
  fixedRate: decimalString.default('0'),
  /** Growth curve holding the forward index path for floating facilities. */
  indexCurveId: z.string().nullish(),
  spread: decimalString.default('0'),
  rateFloor: decimalString.nullish(),
  rateCap: decimalString.nullish(),

  /** Months of interest-only from funding. */
  interestOnlyMonths: z.number().int().min(0).default(0),
  /** Amortization schedule length in months; 0 = fully interest-only. */
  amortizationMonths: z.number().int().min(0).default(0),
  termMonths: z.number().int().min(1),

  originationFeePercent: decimalString.default('0'),
  exitFeePercent: decimalString.default('0'),
  unusedFeePercent: decimalString.default('0'),
  /** Interest accrues to principal instead of being paid in cash. */
  capitalizeInterest: z.boolean().default(false),

  minimumDscr: decimalString.nullish(),
  maximumLtv: decimalString.nullish(),
  maximumLtc: decimalString.nullish(),
  minimumDebtYield: decimalString.nullish(),
  /** Facility repaid in full when the property is sold. */
  repayOnSale: z.boolean().default(true),
});
export type DebtFacility = z.infer<typeof debtFacilitySchema>;

/* -------------------------------------------------------------------------- */
/* Equity / waterfall                                                         */
/* -------------------------------------------------------------------------- */

export const waterfallTierSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum([
    'preferred_return',
    'return_of_capital',
    'catch_up',
    'residual_split',
    'irr_hurdle',
  ]),
  /** Annual hurdle rate for preferred_return / irr_hurdle tiers. */
  hurdleRate: decimalString.nullish(),
  compounding: z.boolean().default(true),
  /** Equity multiple hurdle, if the tier is multiple-based. */
  hurdleMultiple: decimalString.nullish(),
  /** Share of cash in this tier, by partner id. Fractions summing to 1. */
  splits: z.array(z.object({ partnerId: z.string().min(1), share: decimalString })),
  /** For catch-up tiers, the GP share of profit being caught up to. */
  catchUpTargetShare: decimalString.nullish(),
});

export const equityStructureSchema = z.object({
  partners: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        role: z.enum(['lp', 'gp', 'co_invest']),
        /** Share of every capital call. Fractions summing to 1. */
        contributionShare: decimalString,
      }),
    )
    .default([]),
  tiers: z.array(waterfallTierSchema).default([]),
  /** Sponsor fees paid out of property cash flow before distributions. */
  fees: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        type: z.enum([
          'acquisition',
          'asset_management',
          'development',
          'disposition',
          'refinance',
        ]),
        /** Fraction of the fee basis. */
        percent: decimalString,
        recipientPartnerId: z.string().nullish(),
      }),
    )
    .default([]),
});
export type EquityStructure = z.infer<typeof equityStructureSchema>;

/* -------------------------------------------------------------------------- */
/* Valuation                                                                  */
/* -------------------------------------------------------------------------- */

export const valuationSchema = z.object({
  /** Annual nominal discount rate as a fraction, e.g. "0.075". */
  discountRate: decimalString,
  discountingConvention: z.enum(['end_of_period', 'mid_period']).default('end_of_period'),
  /** Annual exit capitalization rate applied to the terminal NOI. */
  terminalCapRate: decimalString.nullish(),
  /**
   * Which NOI feeds the terminal value. `forward_12` is the 12 months after the
   * sale date; `trailing_12` is the 12 months ending on the sale date.
   */
  terminalNoiBasis: z.enum(['forward_12', 'trailing_12']).default('forward_12'),
  /** Costs of sale as a fraction of gross sale price. */
  saleCostPercent: decimalString.default('0'),
  /** Month index (1-based) of the sale. Defaults to the last forecast month. */
  saleMonth: z.number().int().min(1).nullish(),
  /** Optional override for the gross sale price. */
  grossSalePriceOverride: decimalString.nullish(),
  /** Direct capitalization inputs. */
  directCapRate: decimalString.nullish(),
  directCapNoiBasis: z.enum(['year_1', 'stabilized', 'trailing_12']).default('year_1'),
  directCapAdjustments: decimalString.default('0'),
  /** Purchase price / basis used for going-in yield and LTC. */
  acquisitionPrice: decimalString.nullish(),
  acquisitionCosts: decimalString.default('0'),
  acquisitionDate: isoDate.nullish(),
});
export type ValuationAssumptions = z.infer<typeof valuationSchema>;

/* -------------------------------------------------------------------------- */
/* Root                                                                       */
/* -------------------------------------------------------------------------- */

export const modelPropertySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  propertyType: propertyTypeEnum,
  /** Total rentable area; when absent, derived from the space list. */
  rentableArea: decimalString.nullish(),
  unitCount: z.number().int().min(0).default(0),
  ownershipPercent: decimalString.default('1'),
  market: z.string().nullish(),
  submarket: z.string().nullish(),
});

export const modelInputSchema = z.object({
  modelId: z.string().min(1),
  modelName: z.string().min(1).default('Untitled model'),
  currency: z.string().length(3).default('USD'),
  areaUnit: areaUnitEnum.default('sqft'),
  forecast: forecastSchema,
  property: modelPropertySchema,
  growthCurves: z.array(growthCurveSchema).default([]),
  spaces: z.array(spaceSchema).default([]),
  tenants: z.array(tenantSchema).default([]),
  leases: z.array(leaseSchema).default([]),
  marketLeasingProfiles: z.array(marketLeasingProfileSchema).default([]),
  /** Profile applied to any space or rollover without a more specific match. */
  defaultMarketLeasingProfileId: z.string().nullish(),
  otherRevenue: z.array(otherPropertyRevenueSchema).default([]),
  expenses: z.array(operatingExpenseSchema).default([]),
  vacancy: vacancySchema.default({}),
  capital: z.array(capitalItemSchema).default([]),
  debt: z.array(debtFacilitySchema).default([]),
  equity: equityStructureSchema.default({}),
  valuation: valuationSchema,
});

export type ModelInput = z.infer<typeof modelInputSchema>;
export type ModelInputDraft = z.input<typeof modelInputSchema>;

export function parseModelInput(value: unknown): ModelInput {
  return modelInputSchema.parse(value);
}
