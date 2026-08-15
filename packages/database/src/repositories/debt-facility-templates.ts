import type { Sql } from '../client.js';

export interface DebtFacilityTemplateRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  type: string;
  commitment: string;
  initial_funding: string;
  funding_date: string;
  draws: unknown[];
  rate_type: string;
  fixed_rate: string;
  index_curve: string | null;
  spread: string;
  rate_floor: string | null;
  rate_cap: string | null;
  interest_only_months: number;
  amortization_months: number;
  term_months: number;
  origination_fee_percent: string;
  exit_fee_percent: string;
  unused_fee_percent: string;
  capitalize_interest: boolean;
  minimum_dscr: string | null;
  maximum_ltv: string | null;
  maximum_ltc: string | null;
  minimum_debt_yield: string | null;
  repay_on_sale: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  id, organization_id, code, name, type, commitment, initial_funding, funding_date, draws,
  rate_type, fixed_rate, index_curve, spread, rate_floor, rate_cap, interest_only_months,
  amortization_months, term_months, origination_fee_percent, exit_fee_percent,
  unused_fee_percent, capitalize_interest, minimum_dscr, maximum_ltv, maximum_ltc,
  minimum_debt_yield, repay_on_sale, created_by, created_at, updated_at
`;

export async function listDebtFacilityTemplates(
  sql: Sql,
  organizationId: string,
): Promise<DebtFacilityTemplateRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(COLUMNS)} FROM debt_facility_templates
    WHERE organization_id = ${organizationId}
    ORDER BY code
  `) as unknown as DebtFacilityTemplateRow[];
}

export interface UpsertDebtFacilityTemplateInput {
  organizationId: string;
  code: string;
  name: string;
  type?: string;
  commitment?: string;
  initialFunding?: string;
  fundingDate?: string;
  draws?: unknown[];
  rateType?: string;
  fixedRate?: string;
  indexCurve?: string | null;
  spread?: string;
  rateFloor?: string | null;
  rateCap?: string | null;
  interestOnlyMonths?: number;
  amortizationMonths?: number;
  termMonths?: number;
  originationFeePercent?: string;
  exitFeePercent?: string;
  unusedFeePercent?: string;
  capitalizeInterest?: boolean;
  minimumDscr?: string | null;
  maximumLtv?: string | null;
  maximumLtc?: string | null;
  minimumDebtYield?: string | null;
  repayOnSale?: boolean;
  createdBy: string;
}

/** Creates or replaces the named template — the same code-addressable upsert
 * shape every other assumption library uses. */
export async function upsertDebtFacilityTemplate(
  sql: Sql,
  input: UpsertDebtFacilityTemplateInput,
): Promise<DebtFacilityTemplateRow> {
  const rows = (await sql`
    INSERT INTO debt_facility_templates (
      organization_id, code, name, type, commitment, initial_funding, funding_date, draws,
      rate_type, fixed_rate, index_curve, spread, rate_floor, rate_cap, interest_only_months,
      amortization_months, term_months, origination_fee_percent, exit_fee_percent,
      unused_fee_percent, capitalize_interest, minimum_dscr, maximum_ltv, maximum_ltc,
      minimum_debt_yield, repay_on_sale, created_by
    ) VALUES (
      ${input.organizationId}, ${input.code}, ${input.name}, ${input.type ?? 'permanent'},
      ${input.commitment ?? '0'}, ${input.initialFunding ?? '0'},
      ${input.fundingDate ?? '2020-01-01'}, ${sql.json((input.draws ?? []) as never)},
      ${input.rateType ?? 'fixed'}, ${input.fixedRate ?? '0'}, ${input.indexCurve ?? null},
      ${input.spread ?? '0'}, ${input.rateFloor ?? null}, ${input.rateCap ?? null},
      ${input.interestOnlyMonths ?? 0}, ${input.amortizationMonths ?? 0},
      ${input.termMonths ?? 120}, ${input.originationFeePercent ?? '0'},
      ${input.exitFeePercent ?? '0'}, ${input.unusedFeePercent ?? '0'},
      ${input.capitalizeInterest ?? false}, ${input.minimumDscr ?? null},
      ${input.maximumLtv ?? null}, ${input.maximumLtc ?? null},
      ${input.minimumDebtYield ?? null}, ${input.repayOnSale ?? true}, ${input.createdBy}
    )
    ON CONFLICT (organization_id, code) DO UPDATE SET
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
      repay_on_sale = EXCLUDED.repay_on_sale, updated_at = now()
    RETURNING ${sql.unsafe(COLUMNS)}
  `) as unknown as DebtFacilityTemplateRow[];
  return rows[0] as DebtFacilityTemplateRow;
}

export async function deleteDebtFacilityTemplate(
  sql: Sql,
  organizationId: string,
  code: string,
): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM debt_facility_templates
    WHERE organization_id = ${organizationId} AND code = ${code}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}
