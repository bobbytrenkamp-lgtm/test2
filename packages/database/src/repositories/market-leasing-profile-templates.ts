import type { Sql } from '../client.js';

export interface MarketLeasingProfileTemplateRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  market_rent: string;
  market_rent_basis: string;
  market_rent_growth_curve: string | null;
  renewal_probability: string;
  renewal_term_months: number;
  new_lease_term_months: number;
  downtime_months: string;
  renewal_free_rent_months: string;
  new_free_rent_months: string;
  renewal_ti_per_area: string;
  new_ti_per_area: string;
  renewal_lc_percent: string;
  new_lc_percent: string;
  renewal_escalation: Record<string, unknown>;
  new_escalation: Record<string, unknown>;
  recovery: Record<string, unknown>;
  precedence: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  id, organization_id, code, name, market_rent, market_rent_basis, market_rent_growth_curve,
  renewal_probability, renewal_term_months, new_lease_term_months, downtime_months,
  renewal_free_rent_months, new_free_rent_months, renewal_ti_per_area, new_ti_per_area,
  renewal_lc_percent, new_lc_percent, renewal_escalation, new_escalation, recovery, precedence,
  created_by, created_at, updated_at
`;

export async function listMarketLeasingProfileTemplates(
  sql: Sql,
  organizationId: string,
): Promise<MarketLeasingProfileTemplateRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(COLUMNS)} FROM market_leasing_profile_templates
    WHERE organization_id = ${organizationId}
    ORDER BY code
  `) as unknown as MarketLeasingProfileTemplateRow[];
}

export interface UpsertMarketLeasingProfileTemplateInput {
  organizationId: string;
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
  createdBy: string;
}

/** Creates or replaces the named template — the same code-addressable upsert
 * shape `growth_curve_templates` already uses. */
export async function upsertMarketLeasingProfileTemplate(
  sql: Sql,
  input: UpsertMarketLeasingProfileTemplateInput,
): Promise<MarketLeasingProfileTemplateRow> {
  const rows = (await sql`
    INSERT INTO market_leasing_profile_templates (
      organization_id, code, name, market_rent, market_rent_basis, market_rent_growth_curve,
      renewal_probability, renewal_term_months, new_lease_term_months, downtime_months,
      renewal_free_rent_months, new_free_rent_months, renewal_ti_per_area, new_ti_per_area,
      renewal_lc_percent, new_lc_percent, renewal_escalation, new_escalation, recovery,
      precedence, created_by
    ) VALUES (
      ${input.organizationId}, ${input.code}, ${input.name}, ${input.marketRent},
      ${input.marketRentBasis ?? 'per_area_per_year'}, ${input.marketRentGrowthCurve ?? null},
      ${input.renewalProbability ?? '0.65'}, ${input.renewalTermMonths ?? 60},
      ${input.newLeaseTermMonths ?? 60}, ${input.downtimeMonths ?? 6},
      ${input.renewalFreeRentMonths ?? 0}, ${input.newFreeRentMonths ?? 3},
      ${input.renewalTiPerArea ?? '0'}, ${input.newTiPerArea ?? '0'},
      ${input.renewalLcPercent ?? '0'}, ${input.newLcPercent ?? '0'},
      ${sql.json((input.renewalEscalation ?? {}) as never)},
      ${sql.json((input.newEscalation ?? {}) as never)},
      ${sql.json((input.recovery ?? {}) as never)}, ${input.precedence ?? 0}, ${input.createdBy}
    )
    ON CONFLICT (organization_id, code) DO UPDATE SET
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
      recovery = EXCLUDED.recovery, precedence = EXCLUDED.precedence,
      updated_at = now()
    RETURNING ${sql.unsafe(COLUMNS)}
  `) as unknown as MarketLeasingProfileTemplateRow[];
  return rows[0] as MarketLeasingProfileTemplateRow;
}

export async function deleteMarketLeasingProfileTemplate(
  sql: Sql,
  organizationId: string,
  code: string,
): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM market_leasing_profile_templates
    WHERE organization_id = ${organizationId} AND code = ${code}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}
