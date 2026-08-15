import type { Sql } from '../client.js';

export interface OperatingExpenseTemplateRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  category: string;
  account_code: string | null;
  method: string;
  amount: string;
  growth_curve: string | null;
  recoverable_share: string;
  variable_share: string;
  monthly_schedule: unknown[];
  is_capitalized: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  id, organization_id, code, name, category, account_code, method, amount, growth_curve,
  recoverable_share, variable_share, monthly_schedule, is_capitalized,
  created_by, created_at, updated_at
`;

export async function listOperatingExpenseTemplates(
  sql: Sql,
  organizationId: string,
): Promise<OperatingExpenseTemplateRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(COLUMNS)} FROM operating_expense_templates
    WHERE organization_id = ${organizationId}
    ORDER BY code
  `) as unknown as OperatingExpenseTemplateRow[];
}

export interface UpsertOperatingExpenseTemplateInput {
  organizationId: string;
  code: string;
  name: string;
  category?: string;
  accountCode?: string | null;
  method?: string;
  amount?: string;
  growthCurve?: string | null;
  recoverableShare?: string;
  variableShare?: string;
  monthlySchedule?: string[];
  isCapitalized?: boolean;
  createdBy: string;
}

/** Creates or replaces the named template — the same code-addressable upsert
 * shape `growth_curve_templates` and `market_leasing_profile_templates`
 * already use. */
export async function upsertOperatingExpenseTemplate(
  sql: Sql,
  input: UpsertOperatingExpenseTemplateInput,
): Promise<OperatingExpenseTemplateRow> {
  const rows = (await sql`
    INSERT INTO operating_expense_templates (
      organization_id, code, name, category, account_code, method, amount, growth_curve,
      recoverable_share, variable_share, monthly_schedule, is_capitalized, created_by
    ) VALUES (
      ${input.organizationId}, ${input.code}, ${input.name}, ${input.category ?? 'operating'},
      ${input.accountCode ?? null}, ${input.method ?? 'fixed_annual'}, ${input.amount ?? '0'},
      ${input.growthCurve ?? null}, ${input.recoverableShare ?? '0'},
      ${input.variableShare ?? '0'}, ${sql.json((input.monthlySchedule ?? []) as never)},
      ${input.isCapitalized ?? false}, ${input.createdBy}
    )
    ON CONFLICT (organization_id, code) DO UPDATE SET
      name = EXCLUDED.name, category = EXCLUDED.category, account_code = EXCLUDED.account_code,
      method = EXCLUDED.method, amount = EXCLUDED.amount, growth_curve = EXCLUDED.growth_curve,
      recoverable_share = EXCLUDED.recoverable_share, variable_share = EXCLUDED.variable_share,
      monthly_schedule = EXCLUDED.monthly_schedule, is_capitalized = EXCLUDED.is_capitalized,
      updated_at = now()
    RETURNING ${sql.unsafe(COLUMNS)}
  `) as unknown as OperatingExpenseTemplateRow[];
  return rows[0] as OperatingExpenseTemplateRow;
}

export async function deleteOperatingExpenseTemplate(
  sql: Sql,
  organizationId: string,
  code: string,
): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM operating_expense_templates
    WHERE organization_id = ${organizationId} AND code = ${code}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}
