import type { ModelInput, ModelInputDraft } from '@cre/domain-models';
import { parseModelInput } from '@cre/domain-models';
import type { Sql } from '../client.js';

/**
 * Model repository.
 *
 * The important job here is `buildModelInput`: it reads a model's normalised
 * rows and assembles the exact, self-contained input the calculation engine
 * expects. Everything the engine needs comes from this one function, which is
 * what lets a stored version be recalculated years later without the rest of
 * the application being involved.
 */

export interface ModelRow {
  id: string;
  organization_id: string;
  property_id: string;
  name: string;
  classification: string;
  status: string;
  owner_id: string | null;
  valuation_date: string;
  forecast_start_date: string;
  forecast_months: number;
  fiscal_year_start_month: number;
  proration_convention: 'actual_days' | 'thirty_360' | 'full_month';
  currency: string;
  area_unit: 'sqft' | 'sqm';
  notes: string | null;
  discount_rate: string | null;
  discounting_convention: 'end_of_period' | 'mid_period';
  terminal_cap_rate: string | null;
  terminal_noi_basis: 'forward_12' | 'trailing_12';
  sale_cost_percent: string;
  sale_month: number | null;
  gross_sale_price_override: string | null;
  direct_cap_rate: string | null;
  direct_cap_noi_basis: 'year_1' | 'stabilized' | 'trailing_12';
  direct_cap_adjustments: string;
  acquisition_price: string | null;
  acquisition_costs: string;
  acquisition_date: string | null;
  general_vacancy_rate: string;
  net_against_modelled_vacancy: boolean;
  credit_loss_rate: string;
  default_market_leasing_profile_id: string | null;
  equity_structure: unknown;
  created_at: Date;
  updated_at: Date;
}

/** Dates arrive from the driver as either Date or string depending on column type. */
function toIsoDate(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

export async function getModel(
  sql: Sql,
  organizationId: string,
  modelId: string,
): Promise<ModelRow | null> {
  const rows = (await sql`
    SELECT * FROM models
    WHERE id = ${modelId} AND organization_id = ${organizationId} AND deleted_at IS NULL
  `) as unknown as ModelRow[];
  return rows[0] ?? null;
}

export async function listModels(
  sql: Sql,
  organizationId: string,
  propertyId?: string,
): Promise<ModelRow[]> {
  if (propertyId) {
    return (await sql`
      SELECT * FROM models
      WHERE organization_id = ${organizationId} AND property_id = ${propertyId} AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `) as unknown as ModelRow[];
  }
  return (await sql`
    SELECT * FROM models
    WHERE organization_id = ${organizationId} AND deleted_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 500
  `) as unknown as ModelRow[];
}

/**
 * Assembles the engine input for a model.
 *
 * Database rows carry opaque UUIDs; the engine works in stable human-meaningful
 * codes so that a trace entry reads "lease:SUITE-1000" rather than a UUID. Each
 * entity therefore exposes a `code`, and this function maps UUID references
 * onto those codes as it builds the input.
 */
export async function buildModelInput(
  sql: Sql,
  organizationId: string,
  modelId: string,
): Promise<ModelInput> {
  const model = await getModel(sql, organizationId, modelId);
  if (!model) throw new Error(`Model ${modelId} was not found in this organization.`);

  const [property] = (await sql`
    SELECT id, name, property_type, rentable_area, unit_count, ownership_percent, market, submarket
    FROM properties WHERE id = ${model.property_id} AND organization_id = ${organizationId}
  `) as unknown as Array<{
    id: string;
    name: string;
    property_type: string;
    rentable_area: string | null;
    unit_count: number;
    ownership_percent: string;
    market: string | null;
    submarket: string | null;
  }>;
  if (!property) throw new Error('The property this model belongs to was not found.');

  const spaces = (await sql`
    SELECT s.id, s.code, s.building_id, s.floor, s.area, s.space_type, s.unit_count, s.is_non_revenue
    FROM spaces s
    WHERE s.property_id = ${model.property_id}
    ORDER BY s.sort_order, s.code
  `) as unknown as Array<{
    id: string;
    code: string;
    building_id: string | null;
    floor: string | null;
    area: string;
    space_type: string;
    unit_count: number;
    is_non_revenue: boolean;
  }>;

  const profiles = (await sql`
    SELECT * FROM market_leasing_profiles WHERE model_id = ${modelId} ORDER BY code
  `) as unknown as Array<Record<string, unknown>>;
  const profileCodeById = new Map(profiles.map((row) => [row.id as string, row.code as string]));

  const curves = (await sql`
    SELECT code, name, default_rate, by_year FROM growth_curves WHERE model_id = ${modelId} ORDER BY code
  `) as unknown as Array<{ code: string; name: string; default_rate: string; by_year: unknown }>;

  const tenants = (await sql`
    SELECT DISTINCT t.id, t.name, t.parent_company, t.industry, t.credit_rating, t.is_anchor
    FROM tenants t
    JOIN leases l ON l.tenant_id = t.id
    WHERE l.model_id = ${modelId}
  `) as unknown as Array<{
    id: string;
    name: string;
    parent_company: string | null;
    industry: string | null;
    credit_rating: string | null;
    is_anchor: boolean;
  }>;

  const leases = (await sql`
    SELECT
      l.*,
      COALESCE(
        (SELECT array_agg(s.code ORDER BY s.code)
         FROM lease_spaces ls JOIN spaces s ON s.id = ls.space_id
         WHERE ls.lease_id = l.id),
        '{}'
      ) AS space_codes,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
            'startDate', to_char(rs.start_date, 'YYYY-MM-DD'),
            'amount', rs.amount::text,
            'basis', rs.basis) ORDER BY rs.start_date)
         FROM lease_rent_steps rs WHERE rs.lease_id = l.id),
        '[]'::jsonb
      ) AS rent_steps
    FROM leases l
    WHERE l.model_id = ${modelId}
    ORDER BY l.code
  `) as unknown as Array<Record<string, unknown>>;

  const expenses = (await sql`
    SELECT * FROM operating_expenses WHERE model_id = ${modelId} ORDER BY sort_order, code
  `) as unknown as Array<Record<string, unknown>>;

  const otherRevenue = (await sql`
    SELECT * FROM other_revenue_items WHERE model_id = ${modelId} ORDER BY sort_order, code
  `) as unknown as Array<Record<string, unknown>>;

  const capital = (await sql`
    SELECT * FROM capital_items WHERE model_id = ${modelId} ORDER BY sort_order, code
  `) as unknown as Array<Record<string, unknown>>;

  const debt = (await sql`
    SELECT * FROM debt_facilities WHERE model_id = ${modelId} ORDER BY sort_order, code
  `) as unknown as Array<Record<string, unknown>>;

  const draft: ModelInputDraft = {
    modelId: model.id,
    modelName: model.name,
    currency: model.currency,
    areaUnit: model.area_unit,
    forecast: {
      startDate: toIsoDate(model.forecast_start_date) as string,
      months: model.forecast_months,
      fiscalYearStartMonth: model.fiscal_year_start_month,
      proration: model.proration_convention,
    },
    property: {
      id: property.id,
      name: property.name,
      propertyType: property.property_type as ModelInputDraft['property']['propertyType'],
      rentableArea: property.rentable_area,
      unitCount: property.unit_count,
      ownershipPercent: property.ownership_percent,
      market: property.market,
      submarket: property.submarket,
    },
    growthCurves: curves.map((curve) => ({
      id: curve.code,
      name: curve.name,
      defaultRate: curve.default_rate,
      byYear: (curve.by_year as Array<{ year: number; rate: string }>) ?? [],
    })),
    spaces: spaces.map((space) => ({
      id: space.code,
      code: space.code,
      buildingId: space.building_id,
      floor: space.floor,
      area: space.area,
      spaceType: space.space_type,
      unitCount: space.unit_count,
      isNonRevenue: space.is_non_revenue,
      marketLeasingProfileId: null,
    })),
    tenants: tenants.map((tenant) => ({
      id: tenant.id,
      name: tenant.name,
      parentCompany: tenant.parent_company,
      industry: tenant.industry,
      creditRating: tenant.credit_rating,
      isAnchor: tenant.is_anchor,
    })),
    leases: leases.map((row) => ({
      id: row.code as string,
      tenantId: row.tenant_id as string,
      spaceIds: (row.space_codes as string[]) ?? [],
      status: row.status as never,
      area: row.area as string,
      unitCount: row.unit_count as number,
      commencementDate: toIsoDate(row.commencement_date as string) as string,
      rentStartDate: toIsoDate(row.rent_start_date as string | null),
      expirationDate: toIsoDate(row.expiration_date as string) as string,
      baseRent: row.base_rent as string,
      baseRentBasis: row.base_rent_basis as never,
      rentSteps: (row.rent_steps as never) ?? [],
      escalation: (row.escalation as never) ?? {},
      freeRent: (row.free_rent as never) ?? [],
      percentageRent: (row.percentage_rent as never) ?? {},
      recovery: (row.recovery as never) ?? {},
      options: (row.options as never) ?? [],
      leasingCosts: (row.leasing_costs as never) ?? {},
      otherRevenue: (row.other_revenue as never) ?? [],
      marketLeasingProfileId: row.market_leasing_profile_id
        ? (profileCodeById.get(row.market_leasing_profile_id as string) ?? null)
        : null,
      excludeFromRollover: row.exclude_from_rollover as boolean,
      notes: row.notes as string | null,
    })),
    marketLeasingProfiles: profiles.map((row) => ({
      id: row.code as string,
      name: row.name as string,
      marketRent: row.market_rent as string,
      marketRentBasis: row.market_rent_basis as never,
      marketRentGrowthCurveId: row.market_rent_growth_curve as string | null,
      renewalProbability: row.renewal_probability as string,
      renewalTermMonths: row.renewal_term_months as number,
      newLeaseTermMonths: row.new_lease_term_months as number,
      downtimeMonths: Number(row.downtime_months),
      renewalFreeRentMonths: Number(row.renewal_free_rent_months),
      newFreeRentMonths: Number(row.new_free_rent_months),
      renewalTiPerArea: row.renewal_ti_per_area as string,
      newTiPerArea: row.new_ti_per_area as string,
      renewalLcPercent: row.renewal_lc_percent as string,
      newLcPercent: row.new_lc_percent as string,
      renewalEscalation: (row.renewal_escalation as never) ?? {},
      newEscalation: (row.new_escalation as never) ?? {},
      recovery: (row.recovery as never) ?? {},
      precedence: row.precedence as number,
    })),
    defaultMarketLeasingProfileId: model.default_market_leasing_profile_id
      ? (profileCodeById.get(model.default_market_leasing_profile_id) ?? null)
      : null,
    otherRevenue: otherRevenue.map((row) => ({
      id: row.code as string,
      name: row.name as string,
      category: row.category as string,
      method: row.method as never,
      amount: row.amount as string,
      growthCurveId: row.growth_curve as string | null,
      varyWithOccupancy: row.vary_with_occupancy as boolean,
      monthlySchedule: (row.monthly_schedule as string[]) ?? [],
    })),
    expenses: expenses.map((row) => ({
      id: row.code as string,
      name: row.name as string,
      category: row.category as string,
      accountCode: row.account_code as string | null,
      method: row.method as never,
      amount: row.amount as string,
      growthCurveId: row.growth_curve as string | null,
      recoverableShare: row.recoverable_share as string,
      variableShare: row.variable_share as string,
      monthlySchedule: (row.monthly_schedule as string[]) ?? [],
      isCapitalized: row.is_capitalized as boolean,
    })),
    vacancy: {
      generalVacancyRate: model.general_vacancy_rate,
      netAgainstModelledVacancy: model.net_against_modelled_vacancy,
      creditLossRate: model.credit_loss_rate,
    },
    capital: capital.map((row) => ({
      id: row.code as string,
      name: row.name as string,
      category: row.category as never,
      method: row.method as never,
      amount: row.amount as string,
      startDate: toIsoDate(row.start_date as string | null),
      endDate: toIsoDate(row.end_date as string | null),
      growthCurveId: row.growth_curve as string | null,
      monthlySchedule: (row.monthly_schedule as string[]) ?? [],
      capitalized: row.capitalized as boolean,
      fundingSource: row.funding_source as string | null,
    })),
    debt: debt.map((row) => ({
      id: row.code as string,
      name: row.name as string,
      type: row.type as never,
      commitment: row.commitment as string,
      initialFunding: row.initial_funding as string,
      fundingDate: toIsoDate(row.funding_date as string) as string,
      draws: (row.draws as never) ?? [],
      rateType: row.rate_type as never,
      fixedRate: row.fixed_rate as string,
      indexCurveId: row.index_curve as string | null,
      spread: row.spread as string,
      rateFloor: row.rate_floor as string | null,
      rateCap: row.rate_cap as string | null,
      interestOnlyMonths: row.interest_only_months as number,
      amortizationMonths: row.amortization_months as number,
      termMonths: row.term_months as number,
      originationFeePercent: row.origination_fee_percent as string,
      exitFeePercent: row.exit_fee_percent as string,
      unusedFeePercent: row.unused_fee_percent as string,
      capitalizeInterest: row.capitalize_interest as boolean,
      minimumDscr: row.minimum_dscr as string | null,
      maximumLtv: row.maximum_ltv as string | null,
      maximumLtc: row.maximum_ltc as string | null,
      minimumDebtYield: row.minimum_debt_yield as string | null,
      repayOnSale: row.repay_on_sale as boolean,
    })),
    equity: (model.equity_structure as never) ?? { partners: [], tiers: [], fees: [] },
    valuation: {
      discountRate: model.discount_rate ?? '0',
      discountingConvention: model.discounting_convention,
      terminalCapRate: model.terminal_cap_rate,
      terminalNoiBasis: model.terminal_noi_basis,
      saleCostPercent: model.sale_cost_percent,
      saleMonth: model.sale_month,
      grossSalePriceOverride: model.gross_sale_price_override,
      directCapRate: model.direct_cap_rate,
      directCapNoiBasis: model.direct_cap_noi_basis,
      directCapAdjustments: model.direct_cap_adjustments,
      acquisitionPrice: model.acquisition_price,
      acquisitionCosts: model.acquisition_costs,
      acquisitionDate: toIsoDate(model.acquisition_date),
    },
  };

  // Space-level market leasing assignment is expressed on the lease today; the
  // space column is reserved for the per-space override described in
  // docs/feature-status.md.
  return parseModelInput(draft);
}

export interface ModelVersionRow {
  id: string;
  model_id: string;
  version_number: number;
  status: string;
  engine_version: string;
  label: string | null;
  notes: string | null;
  created_at: Date;
  approved_at: Date | null;
}

/**
 * Freezes the current state of a model as an immutable version.
 * The stored input is the exact engine input, so the version can be
 * recalculated without reading any of the live tables again.
 */
export async function createModelVersion(
  sql: Sql,
  input: {
    modelId: string;
    modelInput: ModelInput;
    engineVersion: string;
    label?: string | null;
    notes?: string | null;
    createdBy?: string | null;
  },
): Promise<ModelVersionRow> {
  return (await sql.begin(async (tx) => {
    const [next] = (await tx`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
      FROM model_versions WHERE model_id = ${input.modelId}
    `) as unknown as Array<{ version_number: number }>;

    const rows = (await tx`
      INSERT INTO model_versions
        (model_id, version_number, input, engine_version, label, notes, created_by)
      VALUES (
        ${input.modelId}, ${next?.version_number ?? 1},
        ${tx.json(input.modelInput as never)}, ${input.engineVersion},
        ${input.label ?? null}, ${input.notes ?? null}, ${input.createdBy ?? null}
      )
      RETURNING id, model_id, version_number, status, engine_version, label, notes, created_at, approved_at
    `) as unknown as ModelVersionRow[];
    return rows[0] as ModelVersionRow;
  })) as ModelVersionRow;
}

export async function listModelVersions(sql: Sql, modelId: string): Promise<ModelVersionRow[]> {
  return (await sql`
    SELECT id, model_id, version_number, status, engine_version, label, notes, created_at, approved_at
    FROM model_versions WHERE model_id = ${modelId}
    ORDER BY version_number DESC
  `) as unknown as ModelVersionRow[];
}

export async function getModelVersionInput(
  sql: Sql,
  modelId: string,
  versionId: string,
): Promise<ModelInput | null> {
  const rows = (await sql`
    SELECT input FROM model_versions WHERE id = ${versionId} AND model_id = ${modelId}
  `) as unknown as Array<{ input: unknown }>;
  if (!rows[0]) return null;
  return parseModelInput(rows[0].input);
}
