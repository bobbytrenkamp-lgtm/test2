import type { AccountCategory, BudgetPeriodKind } from '@cre/domain-models';
import type { BudgetLine } from '@cre/calculation-engine';
import type { Sql } from '../client.js';

/**
 * Budgets, actuals and variance commentary.
 *
 * Every query is scoped by organization through the property, so a caller
 * holding only a budget period identifier cannot reach another tenant's
 * numbers. A period that does not belong to the caller's organization is
 * indistinguishable from one that does not exist, which is deliberate: a 403
 * confirms the row is real.
 */

export interface BudgetPeriodRow {
  id: string;
  property_id: string;
  model_id: string | null;
  kind: BudgetPeriodKind;
  fiscal_year: number;
  label: string;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
  entry_count?: number;
}

export interface BudgetEntryRow {
  id: string;
  account_code: string;
  account_name: string;
  account_category: AccountCategory;
  period_month: string;
  amount: string;
  department: string | null;
  commentary: string | null;
}

export async function listBudgetPeriods(
  sql: Sql,
  organizationId: string,
  filters: { propertyId?: string | null; fiscalYear?: number | null } = {},
): Promise<BudgetPeriodRow[]> {
  return (await sql`
    SELECT b.id, b.property_id, b.model_id, b.kind, b.fiscal_year, b.label,
           b.approved_by, b.approved_at, b.created_at,
           (SELECT count(*) FROM budget_entries e WHERE e.budget_period_id = b.id)::int
             AS entry_count
    FROM budget_periods b
    JOIN properties p ON p.id = b.property_id
    WHERE b.organization_id = ${organizationId}
      AND p.organization_id = ${organizationId}
      ${filters.propertyId ? sql`AND b.property_id = ${filters.propertyId}` : sql``}
      ${filters.fiscalYear ? sql`AND b.fiscal_year = ${filters.fiscalYear}` : sql``}
    ORDER BY b.fiscal_year DESC, b.kind, b.label
  `) as unknown as BudgetPeriodRow[];
}

export async function getBudgetPeriod(
  sql: Sql,
  organizationId: string,
  id: string,
): Promise<BudgetPeriodRow | null> {
  const rows = (await sql`
    SELECT b.id, b.property_id, b.model_id, b.kind, b.fiscal_year, b.label,
           b.approved_by, b.approved_at, b.created_at
    FROM budget_periods b
    WHERE b.id = ${id} AND b.organization_id = ${organizationId}
  `) as unknown as BudgetPeriodRow[];
  return rows[0] ?? null;
}

export async function createBudgetPeriod(
  sql: Sql,
  organizationId: string,
  input: {
    propertyId: string;
    modelId?: string | null;
    kind: BudgetPeriodKind;
    fiscalYear: number;
    label: string;
  },
): Promise<BudgetPeriodRow> {
  const rows = (await sql`
    INSERT INTO budget_periods (organization_id, property_id, model_id, kind, fiscal_year, label)
    VALUES (
      ${organizationId}, ${input.propertyId}, ${input.modelId ?? null},
      ${input.kind}, ${input.fiscalYear}, ${input.label}
    )
    RETURNING id, property_id, model_id, kind, fiscal_year, label,
              approved_by, approved_at, created_at
  `) as unknown as BudgetPeriodRow[];
  return rows[0] as BudgetPeriodRow;
}

export async function deleteBudgetPeriod(
  sql: Sql,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM budget_periods
    WHERE id = ${id} AND organization_id = ${organizationId}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Replaces a period's entries wholesale.
 *
 * A budget upload is a statement of the whole period, not a patch: leaving
 * yesterday's rows behind alongside today's would silently double every
 * account. The delete and the insert share one transaction so a failure part
 * way through cannot leave the period half loaded.
 */
export async function replaceBudgetEntries(
  sql: Sql,
  budgetPeriodId: string,
  entries: Array<{
    accountCode: string;
    accountName: string;
    accountCategory: AccountCategory;
    periodMonth: string;
    amount: string;
    department?: string | null;
    commentary?: string | null;
  }>,
): Promise<number> {
  return (await sql.begin(async (tx) => {
    await tx`DELETE FROM budget_entries WHERE budget_period_id = ${budgetPeriodId}`;
    if (entries.length === 0) return 0;

    // Duplicate account/month pairs would violate the table's unique index. The
    // last one entered wins, which is what someone correcting a row expects.
    const deduplicated = new Map<string, (typeof entries)[number]>();
    for (const entry of entries) {
      deduplicated.set(`${entry.accountCode}|${entry.periodMonth}`, entry);
    }

    const rows = [...deduplicated.values()].map((entry) => ({
      budget_period_id: budgetPeriodId,
      account_code: entry.accountCode,
      account_name: entry.accountName,
      account_category: entry.accountCategory,
      period_month: entry.periodMonth,
      amount: entry.amount,
      department: entry.department ?? null,
      commentary: entry.commentary ?? null,
    }));

    await tx`INSERT INTO budget_entries ${tx(rows as never)}`;
    return rows.length;
  })) as number;
}

export async function listBudgetEntries(
  sql: Sql,
  budgetPeriodId: string,
): Promise<BudgetEntryRow[]> {
  return (await sql`
    SELECT id, account_code, account_name, account_category,
           to_char(period_month, 'YYYY-MM-DD') AS period_month,
           amount, department, commentary
    FROM budget_entries
    WHERE budget_period_id = ${budgetPeriodId}
    ORDER BY account_code, period_month
  `) as unknown as BudgetEntryRow[];
}

/** Entries in the shape the variance calculation consumes. */
export async function budgetLinesFor(sql: Sql, budgetPeriodId: string): Promise<BudgetLine[]> {
  const rows = await listBudgetEntries(sql, budgetPeriodId);
  return rows.map((row) => ({
    accountCode: row.account_code,
    accountName: row.account_name,
    category: row.account_category,
    periodMonth: row.period_month,
    amount: row.amount,
  }));
}

export async function approveBudgetPeriod(
  sql: Sql,
  organizationId: string,
  id: string,
  userId: string,
): Promise<BudgetPeriodRow | null> {
  const rows = (await sql`
    UPDATE budget_periods
    SET approved_by = ${userId}, approved_at = now()
    WHERE id = ${id} AND organization_id = ${organizationId} AND approved_at IS NULL
    RETURNING id, property_id, model_id, kind, fiscal_year, label,
              approved_by, approved_at, created_at
  `) as unknown as BudgetPeriodRow[];
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Variance commentary                                                        */
/* -------------------------------------------------------------------------- */

export interface VarianceCommentaryRow {
  id: string;
  property_id: string;
  fiscal_year: number;
  period_month: string;
  account_code: string;
  commentary: string;
  approved_text: string | null;
  author_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
}

export async function listVarianceCommentary(
  sql: Sql,
  organizationId: string,
  propertyId: string,
  fiscalYear: number,
): Promise<VarianceCommentaryRow[]> {
  return (await sql`
    SELECT c.id, c.property_id, c.fiscal_year,
           to_char(c.period_month, 'YYYY-MM-DD') AS period_month,
           c.account_code, c.commentary, c.approved_text, c.author_id,
           c.approved_by, c.approved_at, c.created_at
    FROM variance_commentary c
    JOIN properties p ON p.id = c.property_id
    WHERE c.property_id = ${propertyId}
      AND c.fiscal_year = ${fiscalYear}
      AND p.organization_id = ${organizationId}
    ORDER BY c.period_month, c.account_code
  `) as unknown as VarianceCommentaryRow[];
}

/**
 * Writes or replaces the commentary on one account in one month.
 *
 * Editing after approval clears the approval rather than keeping it. A reviewer
 * signed off particular words; letting those words change underneath the
 * signature would make the approval a decoration. `approved_text` preserves
 * what was actually agreed to, so the change is visible rather than lost.
 */
export async function upsertVarianceCommentary(
  sql: Sql,
  input: {
    propertyId: string;
    fiscalYear: number;
    periodMonth: string;
    accountCode: string;
    commentary: string;
    authorId: string | null;
  },
): Promise<VarianceCommentaryRow> {
  const rows = (await sql`
    INSERT INTO variance_commentary
      (property_id, fiscal_year, period_month, account_code, commentary, author_id)
    VALUES (
      ${input.propertyId}, ${input.fiscalYear}, ${input.periodMonth},
      ${input.accountCode}, ${input.commentary}, ${input.authorId}
    )
    ON CONFLICT (property_id, fiscal_year, period_month, account_code)
    DO UPDATE SET
      commentary  = EXCLUDED.commentary,
      author_id   = EXCLUDED.author_id,
      approved_by = NULL,
      approved_at = NULL
    RETURNING id, property_id, fiscal_year,
              to_char(period_month, 'YYYY-MM-DD') AS period_month,
              account_code, commentary, approved_text, author_id,
              approved_by, approved_at, created_at
  `) as unknown as VarianceCommentaryRow[];
  return rows[0] as VarianceCommentaryRow;
}

/**
 * Approves commentary, recording the exact text approved.
 *
 * Refuses to approve the author's own commentary. One person writing the
 * explanation and another agreeing to it is the whole point of the step; if
 * both can be the same person, the approval records nothing.
 */
export async function approveVarianceCommentary(
  sql: Sql,
  organizationId: string,
  id: string,
  userId: string,
): Promise<{ row: VarianceCommentaryRow | null; refusedSelfApproval: boolean }> {
  const existing = (await sql`
    SELECT c.id, c.author_id
    FROM variance_commentary c
    JOIN properties p ON p.id = c.property_id
    WHERE c.id = ${id} AND p.organization_id = ${organizationId}
  `) as unknown as Array<{ id: string; author_id: string | null }>;

  const found = existing[0];
  if (!found) return { row: null, refusedSelfApproval: false };
  if (found.author_id === userId) return { row: null, refusedSelfApproval: true };

  const rows = (await sql`
    UPDATE variance_commentary
    SET approved_by = ${userId}, approved_at = now(), approved_text = commentary
    WHERE id = ${id}
    RETURNING id, property_id, fiscal_year,
              to_char(period_month, 'YYYY-MM-DD') AS period_month,
              account_code, commentary, approved_text, author_id,
              approved_by, approved_at, created_at
  `) as unknown as VarianceCommentaryRow[];
  return { row: rows[0] ?? null, refusedSelfApproval: false };
}
