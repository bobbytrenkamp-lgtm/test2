import { z } from 'zod';

/** ISO-8601 calendar date with no time component, e.g. "2026-01-01". */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date formatted as YYYY-MM-DD');

/**
 * Money, rates and areas travel as decimal strings so that no value is ever
 * routed through binary floating point on its way in or out of the engine.
 * `-0.0725`, `12500`, `27.50` are all valid.
 */
export const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .refine((v) => /^-?(\d+(\.\d+)?|\.\d+)$/.test(v), {
    message: 'Expected a decimal number',
  });

export const propertyTypeEnum = z.enum([
  'office',
  'industrial',
  'retail',
  'multifamily',
  'mixed_use',
  'student_housing',
  'self_storage',
  'medical_office',
  'life_science',
  'data_center',
  'hotel',
  'senior_housing',
  'manufactured_housing',
  'parking',
  'land',
  'ground_lease',
]);
export type PropertyType = z.infer<typeof propertyTypeEnum>;

export const areaUnitEnum = z.enum(['sqft', 'sqm']);
export type AreaUnit = z.infer<typeof areaUnitEnum>;

export const leaseStatusEnum = z.enum([
  'occupied',
  'future',
  'vacant',
  'month_to_month',
  'holdover',
  'expired',
  'terminated',
  'pending',
  'proposed',
  'sublease',
]);
export type LeaseStatus = z.infer<typeof leaseStatusEnum>;

export const rentBasisEnum = z.enum([
  /** Amount is an annual rate per area unit. */
  'per_area_per_year',
  /** Amount is a monthly rate per area unit. */
  'per_area_per_month',
  /** Amount is a total annual figure for the whole lease. */
  'annual_amount',
  /** Amount is a total monthly figure for the whole lease. */
  'monthly_amount',
  /** Amount is a monthly figure per unit (multifamily, storage, parking). */
  'per_unit_per_month',
]);
export type RentBasis = z.infer<typeof rentBasisEnum>;

export const escalationTypeEnum = z.enum([
  'none',
  /** Compounding or simple percentage applied on an anniversary cadence. */
  'fixed_percent',
  /** Fixed currency amount added to the rate on each escalation date. */
  'fixed_amount',
  /** Percentage taken from a named index curve (CPI or other). */
  'index',
  /** Rent resets to the prevailing market rent from a leasing profile. */
  'market_reset',
]);
export type EscalationType = z.infer<typeof escalationTypeEnum>;

export const recoveryMethodEnum = z.enum([
  /** Landlord bears all operating expenses; no recovery billed. */
  'full_service_gross',
  /** Tenant reimburses its share of every recoverable category. */
  'triple_net',
  /** Tenant reimburses growth above a base-year expense level. */
  'base_year',
  /** Tenant reimburses above a stated stop expressed per area unit. */
  'expense_stop',
  /** Fixed reimbursement amount that escalates on its own schedule. */
  'fixed_amount',
  /** No recovery of any kind. */
  'none',
]);
export type RecoveryMethod = z.infer<typeof recoveryMethodEnum>;

export const expenseMethodEnum = z.enum([
  'fixed_annual',
  'per_area_per_year',
  'per_unit_per_year',
  'percent_of_effective_gross_revenue',
  'percent_of_base_rent',
  'custom_monthly_schedule',
]);
export type ExpenseMethod = z.infer<typeof expenseMethodEnum>;

export const debtTypeEnum = z.enum([
  'acquisition',
  'permanent',
  'construction',
  'bridge',
  'revolver',
  'mezzanine',
  'preferred_equity',
  'seller_financing',
  'supplemental',
]);
export type DebtType = z.infer<typeof debtTypeEnum>;

export const modelClassificationEnum = z.enum([
  'acquisition',
  'valuation',
  'budget',
  'reforecast',
  'business_plan',
  'base_case',
  'upside_case',
  'downside_case',
  'lender_case',
  'appraisal_case',
  'development_case',
  'disposition_case',
]);
export type ModelClassification = z.infer<typeof modelClassificationEnum>;

export const modelStatusEnum = z.enum([
  'draft',
  'analyst_review',
  'manager_review',
  'approved',
  'published',
  'superseded',
  'archived',
]);
export type ModelStatus = z.infer<typeof modelStatusEnum>;

export const roleEnum = z.enum([
  'organization_owner',
  'administrator',
  'portfolio_manager',
  'asset_manager',
  'acquisitions',
  'valuation',
  'analyst',
  'reviewer',
  'read_only',
]);
export type Role = z.infer<typeof roleEnum>;

export const diagnosticSeverityEnum = z.enum([
  'error',
  'warning',
  'informational',
  'accepted_exception',
]);
export type DiagnosticSeverity = z.infer<typeof diagnosticSeverityEnum>;
