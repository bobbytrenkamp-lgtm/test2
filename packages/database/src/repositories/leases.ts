import type { Sql } from '../client.js';

/**
 * Lease and model-scoped assumption writes.
 *
 * Every write here is scoped by model_id and every read joins back to the
 * model, so a caller that has already been authorized for a model cannot reach
 * another organization's rows through a guessed identifier.
 */

export interface TenantRow {
  id: string;
  organization_id: string;
  property_id: string | null;
  name: string;
  parent_company: string | null;
  industry: string | null;
  credit_rating: string | null;
  is_anchor: boolean;
}

export async function listTenants(
  sql: Sql,
  organizationId: string,
  propertyId?: string,
): Promise<TenantRow[]> {
  return (await sql`
    SELECT id, organization_id, property_id, name, parent_company, industry, credit_rating, is_anchor
    FROM tenants
    WHERE organization_id = ${organizationId}
      AND (${propertyId ?? null}::uuid IS NULL OR property_id = ${propertyId ?? null}::uuid)
    ORDER BY name
  `) as unknown as TenantRow[];
}

export async function createTenant(
  sql: Sql,
  input: {
    organizationId: string;
    propertyId?: string | null;
    name: string;
    parentCompany?: string | null;
    industry?: string | null;
    creditRating?: string | null;
    isAnchor?: boolean;
  },
): Promise<TenantRow> {
  const rows = (await sql`
    INSERT INTO tenants (organization_id, property_id, name, parent_company, industry, credit_rating, is_anchor)
    VALUES (
      ${input.organizationId}, ${input.propertyId ?? null}, ${input.name.trim()},
      ${input.parentCompany ?? null}, ${input.industry ?? null}, ${input.creditRating ?? null},
      ${input.isAnchor ?? false}
    )
    RETURNING id, organization_id, property_id, name, parent_company, industry, credit_rating, is_anchor
  `) as unknown as TenantRow[];
  return rows[0] as TenantRow;
}

export interface LeaseRow {
  id: string;
  model_id: string;
  tenant_id: string;
  code: string;
  status: string;
  area: string;
  unit_count: number;
  commencement_date: string;
  rent_start_date: string | null;
  expiration_date: string;
  base_rent: string;
  base_rent_basis: string;
  escalation: Record<string, unknown>;
  free_rent: unknown[];
  percentage_rent: Record<string, unknown>;
  recovery: Record<string, unknown>;
  options: unknown[];
  leasing_costs: Record<string, unknown>;
  other_revenue: unknown[];
  market_leasing_profile_id: string | null;
  exclude_from_rollover: boolean;
  notes: string | null;
}

export async function listLeases(
  sql: Sql,
  modelId: string,
): Promise<
  Array<
    LeaseRow & {
      tenant_name: string;
      space_codes: string[];
      rent_steps: Array<{ startDate: string; amount: string; basis: string }>;
    }
  >
> {
  return (await sql`
    SELECT
      l.*,
      t.name AS tenant_name,
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
    JOIN tenants t ON t.id = l.tenant_id
    WHERE l.model_id = ${modelId}
    ORDER BY l.code
  `) as never;
}

export interface UpsertLeaseInput {
  modelId: string;
  code: string;
  tenantId: string;
  status: string;
  area: string;
  unitCount?: number;
  spaceIds?: string[];
  commencementDate: string;
  rentStartDate?: string | null;
  expirationDate: string;
  baseRent: string;
  baseRentBasis: string;
  escalation?: Record<string, unknown>;
  freeRent?: unknown[];
  percentageRent?: Record<string, unknown>;
  recovery?: Record<string, unknown>;
  options?: unknown[];
  leasingCosts?: Record<string, unknown>;
  otherRevenue?: unknown[];
  rentSteps?: Array<{ startDate: string; amount: string; basis: string }>;
  marketLeasingProfileId?: string | null;
  excludeFromRollover?: boolean;
  notes?: string | null;
}

/**
 * Writes a lease and its child rows in one transaction. Rent steps and space
 * assignments are replaced wholesale rather than diffed: a lease is edited as a
 * unit in the grid, and a partial write would leave a half-updated schedule.
 */
export async function upsertLease(sql: Sql, input: UpsertLeaseInput): Promise<LeaseRow> {
  return (await sql.begin(async (tx) => {
    const rows = (await tx`
      INSERT INTO leases (
        model_id, tenant_id, code, status, area, unit_count, commencement_date,
        rent_start_date, expiration_date, base_rent, base_rent_basis, escalation,
        free_rent, percentage_rent, recovery, options, leasing_costs, other_revenue,
        market_leasing_profile_id, exclude_from_rollover, notes
      ) VALUES (
        ${input.modelId}, ${input.tenantId}, ${input.code}, ${input.status}, ${input.area},
        ${input.unitCount ?? 0}, ${input.commencementDate}, ${input.rentStartDate ?? null},
        ${input.expirationDate}, ${input.baseRent}, ${input.baseRentBasis},
        ${tx.json((input.escalation ?? {}) as never)},
        ${tx.json((input.freeRent ?? []) as never)},
        ${tx.json((input.percentageRent ?? {}) as never)},
        ${tx.json((input.recovery ?? {}) as never)},
        ${tx.json((input.options ?? []) as never)},
        ${tx.json((input.leasingCosts ?? {}) as never)},
        ${tx.json((input.otherRevenue ?? []) as never)},
        ${input.marketLeasingProfileId ?? null}, ${input.excludeFromRollover ?? false},
        ${input.notes ?? null}
      )
      ON CONFLICT (model_id, code) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        status = EXCLUDED.status,
        area = EXCLUDED.area,
        unit_count = EXCLUDED.unit_count,
        commencement_date = EXCLUDED.commencement_date,
        rent_start_date = EXCLUDED.rent_start_date,
        expiration_date = EXCLUDED.expiration_date,
        base_rent = EXCLUDED.base_rent,
        base_rent_basis = EXCLUDED.base_rent_basis,
        escalation = EXCLUDED.escalation,
        free_rent = EXCLUDED.free_rent,
        percentage_rent = EXCLUDED.percentage_rent,
        recovery = EXCLUDED.recovery,
        options = EXCLUDED.options,
        leasing_costs = EXCLUDED.leasing_costs,
        other_revenue = EXCLUDED.other_revenue,
        market_leasing_profile_id = EXCLUDED.market_leasing_profile_id,
        exclude_from_rollover = EXCLUDED.exclude_from_rollover,
        notes = EXCLUDED.notes,
        updated_at = now()
      RETURNING *
    `) as unknown as LeaseRow[];
    const lease = rows[0] as LeaseRow;

    await tx`DELETE FROM lease_rent_steps WHERE lease_id = ${lease.id}`;
    for (const [index, step] of (input.rentSteps ?? []).entries()) {
      await tx`
        INSERT INTO lease_rent_steps (lease_id, start_date, amount, basis, sort_order)
        VALUES (${lease.id}, ${step.startDate}, ${step.amount}, ${step.basis}, ${index})
      `;
    }

    await tx`DELETE FROM lease_spaces WHERE lease_id = ${lease.id}`;
    for (const spaceCode of input.spaceIds ?? []) {
      await tx`
        INSERT INTO lease_spaces (lease_id, space_id)
        SELECT ${lease.id}, s.id
        FROM spaces s
        JOIN models m ON m.property_id = s.property_id
        WHERE m.id = ${input.modelId} AND s.code = ${spaceCode}
        ON CONFLICT DO NOTHING
      `;
    }

    return lease;
  })) as LeaseRow;
}

export async function deleteLease(sql: Sql, modelId: string, code: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM leases WHERE model_id = ${modelId} AND code = ${code} RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Model-scoped assumption tables                                             */
/* -------------------------------------------------------------------------- */

export async function upsertExpense(
  sql: Sql,
  input: {
    modelId: string;
    code: string;
    name: string;
    category: string;
    accountCode?: string | null;
    method: string;
    amount: string;
    growthCurve?: string | null;
    recoverableShare?: string;
    variableShare?: string;
    monthlySchedule?: string[];
    isCapitalized?: boolean;
    sortOrder?: number;
  },
): Promise<{ id: string }> {
  const rows = (await sql`
    INSERT INTO operating_expenses (
      model_id, code, name, category, account_code, method, amount, growth_curve,
      recoverable_share, variable_share, monthly_schedule, is_capitalized, sort_order
    ) VALUES (
      ${input.modelId}, ${input.code}, ${input.name}, ${input.category},
      ${input.accountCode ?? null}, ${input.method}, ${input.amount},
      ${input.growthCurve ?? null}, ${input.recoverableShare ?? '0'},
      ${input.variableShare ?? '0'}, ${sql.json((input.monthlySchedule ?? []) as never)},
      ${input.isCapitalized ?? false}, ${input.sortOrder ?? 0}
    )
    ON CONFLICT (model_id, code) DO UPDATE SET
      name = EXCLUDED.name, category = EXCLUDED.category, account_code = EXCLUDED.account_code,
      method = EXCLUDED.method, amount = EXCLUDED.amount, growth_curve = EXCLUDED.growth_curve,
      recoverable_share = EXCLUDED.recoverable_share, variable_share = EXCLUDED.variable_share,
      monthly_schedule = EXCLUDED.monthly_schedule, is_capitalized = EXCLUDED.is_capitalized,
      sort_order = EXCLUDED.sort_order, updated_at = now()
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0] as { id: string };
}

export async function upsertGrowthCurve(
  sql: Sql,
  input: {
    modelId: string;
    code: string;
    name: string;
    defaultRate: string;
    byYear?: Array<{ year: number; rate: string }>;
  },
): Promise<{ id: string }> {
  const rows = (await sql`
    INSERT INTO growth_curves (model_id, code, name, default_rate, by_year)
    VALUES (${input.modelId}, ${input.code}, ${input.name}, ${input.defaultRate},
            ${sql.json((input.byYear ?? []) as never)})
    ON CONFLICT (model_id, code) DO UPDATE SET
      name = EXCLUDED.name, default_rate = EXCLUDED.default_rate, by_year = EXCLUDED.by_year
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0] as { id: string };
}

export async function upsertMarketLeasingProfile(
  sql: Sql,
  input: {
    modelId: string;
    code: string;
    name: string;
    marketRent: string;
    marketRentBasis?: string;
    marketRentGrowthCurve?: string | null;
    renewalProbability?: string;
    renewalTermMonths?: number;
    newLeaseTermMonths?: number;
    downtimeMonths?: number;
    renewalFreeRentMonths?: number;
    newFreeRentMonths?: number;
    renewalTiPerArea?: string;
    newTiPerArea?: string;
    renewalLcPercent?: string;
    newLcPercent?: string;
    renewalEscalation?: Record<string, unknown>;
    newEscalation?: Record<string, unknown>;
    recovery?: Record<string, unknown>;
    precedence?: number;
  },
): Promise<{ id: string }> {
  const rows = (await sql`
    INSERT INTO market_leasing_profiles (
      model_id, code, name, market_rent, market_rent_basis, market_rent_growth_curve,
      renewal_probability, renewal_term_months, new_lease_term_months, downtime_months,
      renewal_free_rent_months, new_free_rent_months, renewal_ti_per_area, new_ti_per_area,
      renewal_lc_percent, new_lc_percent, renewal_escalation, new_escalation, recovery, precedence
    ) VALUES (
      ${input.modelId}, ${input.code}, ${input.name}, ${input.marketRent},
      ${input.marketRentBasis ?? 'per_area_per_year'}, ${input.marketRentGrowthCurve ?? null},
      ${input.renewalProbability ?? '0.65'}, ${input.renewalTermMonths ?? 60},
      ${input.newLeaseTermMonths ?? 60}, ${input.downtimeMonths ?? 6},
      ${input.renewalFreeRentMonths ?? 0}, ${input.newFreeRentMonths ?? 3},
      ${input.renewalTiPerArea ?? '0'}, ${input.newTiPerArea ?? '0'},
      ${input.renewalLcPercent ?? '0'}, ${input.newLcPercent ?? '0'},
      ${sql.json((input.renewalEscalation ?? {}) as never)},
      ${sql.json((input.newEscalation ?? {}) as never)},
      ${sql.json((input.recovery ?? {}) as never)}, ${input.precedence ?? 0}
    )
    ON CONFLICT (model_id, code) DO UPDATE SET
      name = EXCLUDED.name, market_rent = EXCLUDED.market_rent,
      market_rent_basis = EXCLUDED.market_rent_basis,
      market_rent_growth_curve = EXCLUDED.market_rent_growth_curve,
      renewal_probability = EXCLUDED.renewal_probability,
      renewal_term_months = EXCLUDED.renewal_term_months,
      new_lease_term_months = EXCLUDED.new_lease_term_months,
      downtime_months = EXCLUDED.downtime_months,
      renewal_free_rent_months = EXCLUDED.renewal_free_rent_months,
      new_free_rent_months = EXCLUDED.new_free_rent_months,
      renewal_ti_per_area = EXCLUDED.renewal_ti_per_area,
      new_ti_per_area = EXCLUDED.new_ti_per_area,
      renewal_lc_percent = EXCLUDED.renewal_lc_percent,
      new_lc_percent = EXCLUDED.new_lc_percent,
      renewal_escalation = EXCLUDED.renewal_escalation,
      new_escalation = EXCLUDED.new_escalation,
      recovery = EXCLUDED.recovery, precedence = EXCLUDED.precedence, updated_at = now()
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0] as { id: string };
}

export async function upsertDebtFacility(
  sql: Sql,
  input: Record<string, unknown> & { modelId: string; code: string },
): Promise<{ id: string }> {
  const rows = (await sql`
    INSERT INTO debt_facilities (
      model_id, code, name, type, commitment, initial_funding, funding_date, draws,
      rate_type, fixed_rate, index_curve, spread, rate_floor, rate_cap,
      interest_only_months, amortization_months, term_months, origination_fee_percent,
      exit_fee_percent, unused_fee_percent, capitalize_interest, minimum_dscr,
      maximum_ltv, maximum_ltc, minimum_debt_yield, repay_on_sale, sort_order
    ) VALUES (
      ${input.modelId}, ${input.code}, ${input.name as string}, ${input.type as string},
      ${(input.commitment as string) ?? '0'}, ${(input.initialFunding as string) ?? '0'},
      ${input.fundingDate as string}, ${sql.json((input.draws ?? []) as never)},
      ${(input.rateType as string) ?? 'fixed'}, ${(input.fixedRate as string) ?? '0'},
      ${(input.indexCurve as string) ?? null}, ${(input.spread as string) ?? '0'},
      ${(input.rateFloor as string) ?? null}, ${(input.rateCap as string) ?? null},
      ${(input.interestOnlyMonths as number) ?? 0}, ${(input.amortizationMonths as number) ?? 0},
      ${input.termMonths as number}, ${(input.originationFeePercent as string) ?? '0'},
      ${(input.exitFeePercent as string) ?? '0'}, ${(input.unusedFeePercent as string) ?? '0'},
      ${(input.capitalizeInterest as boolean) ?? false}, ${(input.minimumDscr as string) ?? null},
      ${(input.maximumLtv as string) ?? null}, ${(input.maximumLtc as string) ?? null},
      ${(input.minimumDebtYield as string) ?? null}, ${(input.repayOnSale as boolean) ?? true},
      ${(input.sortOrder as number) ?? 0}
    )
    ON CONFLICT (model_id, code) DO UPDATE SET
      name = EXCLUDED.name, type = EXCLUDED.type, commitment = EXCLUDED.commitment,
      initial_funding = EXCLUDED.initial_funding, funding_date = EXCLUDED.funding_date,
      draws = EXCLUDED.draws, rate_type = EXCLUDED.rate_type, fixed_rate = EXCLUDED.fixed_rate,
      index_curve = EXCLUDED.index_curve, spread = EXCLUDED.spread,
      rate_floor = EXCLUDED.rate_floor, rate_cap = EXCLUDED.rate_cap,
      interest_only_months = EXCLUDED.interest_only_months,
      amortization_months = EXCLUDED.amortization_months, term_months = EXCLUDED.term_months,
      origination_fee_percent = EXCLUDED.origination_fee_percent,
      exit_fee_percent = EXCLUDED.exit_fee_percent,
      unused_fee_percent = EXCLUDED.unused_fee_percent,
      capitalize_interest = EXCLUDED.capitalize_interest,
      minimum_dscr = EXCLUDED.minimum_dscr, maximum_ltv = EXCLUDED.maximum_ltv,
      maximum_ltc = EXCLUDED.maximum_ltc, minimum_debt_yield = EXCLUDED.minimum_debt_yield,
      repay_on_sale = EXCLUDED.repay_on_sale
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0] as { id: string };
}

export async function upsertCapitalItem(
  sql: Sql,
  input: {
    modelId: string;
    code: string;
    name: string;
    category: string;
    method: string;
    amount: string;
    startDate?: string | null;
    endDate?: string | null;
    growthCurve?: string | null;
    monthlySchedule?: string[];
    capitalized?: boolean;
    fundingSource?: string | null;
    sortOrder?: number;
  },
): Promise<{ id: string }> {
  const rows = (await sql`
    INSERT INTO capital_items (
      model_id, code, name, category, method, amount, start_date, end_date,
      growth_curve, monthly_schedule, capitalized, funding_source, sort_order
    ) VALUES (
      ${input.modelId}, ${input.code}, ${input.name}, ${input.category}, ${input.method},
      ${input.amount}, ${input.startDate ?? null}, ${input.endDate ?? null},
      ${input.growthCurve ?? null}, ${sql.json((input.monthlySchedule ?? []) as never)},
      ${input.capitalized ?? true}, ${input.fundingSource ?? null}, ${input.sortOrder ?? 0}
    )
    ON CONFLICT (model_id, code) DO UPDATE SET
      name = EXCLUDED.name, category = EXCLUDED.category, method = EXCLUDED.method,
      amount = EXCLUDED.amount, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
      growth_curve = EXCLUDED.growth_curve, monthly_schedule = EXCLUDED.monthly_schedule,
      capitalized = EXCLUDED.capitalized, funding_source = EXCLUDED.funding_source,
      sort_order = EXCLUDED.sort_order
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0] as { id: string };
}

export async function upsertOtherRevenue(
  sql: Sql,
  input: {
    modelId: string;
    code: string;
    name: string;
    category?: string;
    method: string;
    amount: string;
    growthCurve?: string | null;
    varyWithOccupancy?: boolean;
    monthlySchedule?: string[];
    sortOrder?: number;
  },
): Promise<{ id: string }> {
  const rows = (await sql`
    INSERT INTO other_revenue_items (
      model_id, code, name, category, method, amount, growth_curve, vary_with_occupancy,
      monthly_schedule, sort_order
    ) VALUES (
      ${input.modelId}, ${input.code}, ${input.name}, ${input.category ?? 'other'},
      ${input.method}, ${input.amount}, ${input.growthCurve ?? null},
      ${input.varyWithOccupancy ?? false}, ${sql.json((input.monthlySchedule ?? []) as never)},
      ${input.sortOrder ?? 0}
    )
    ON CONFLICT (model_id, code) DO UPDATE SET
      name = EXCLUDED.name, category = EXCLUDED.category, method = EXCLUDED.method,
      amount = EXCLUDED.amount, growth_curve = EXCLUDED.growth_curve,
      vary_with_occupancy = EXCLUDED.vary_with_occupancy,
      monthly_schedule = EXCLUDED.monthly_schedule, sort_order = EXCLUDED.sort_order
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0] as { id: string };
}
