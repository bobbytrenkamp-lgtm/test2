import type { Sql } from '@cre/database';
import {
  upsertCapitalItem,
  upsertDebtFacility,
  upsertExpense,
  upsertGrowthCurve,
  upsertMarketLeasingProfile,
  upsertOtherRevenue,
} from '@cre/database';
import type { AssumptionValueType } from '@cre/domain-models';

/**
 * How an accepted assumption actually reaches the database.
 *
 * Shared by the assumption-proposal decision route and the assumption-import
 * apply route, because both end at the same place: a value an analyst
 * accepted, written through the same `upsert` a typed edit in the UI uses.
 * Two independent copies of this file would be two independent chances to
 * get a column name or a type coercion wrong in only one of them.
 *
 * `MODEL_COLUMNS`'s keys and `COLLECTIONS`'s keys are checked against
 * `@cre/domain-models`'s target registry by
 * `assumption-write.test.ts` — the registry says what a target *means*
 * (its type, its label); this file says how to *write* it. Both have to
 * agree on which targets exist, or accepting a proposal the registry called
 * writable would fail here with no field to write it to.
 */

/** Model-level targets an acceptance may write, and their column names. */
export const MODEL_COLUMNS: Record<string, string> = {
  'valuation.discountRate': 'discount_rate',
  'valuation.discountingConvention': 'discounting_convention',
  'valuation.terminalCapRate': 'terminal_cap_rate',
  'valuation.terminalNoiBasis': 'terminal_noi_basis',
  'valuation.saleCostPercent': 'sale_cost_percent',
  'valuation.saleMonth': 'sale_month',
  'valuation.grossSalePriceOverride': 'gross_sale_price_override',
  'valuation.directCapRate': 'direct_cap_rate',
  'valuation.directCapNoiBasis': 'direct_cap_noi_basis',
  'valuation.directCapAdjustments': 'direct_cap_adjustments',
  'valuation.acquisitionPrice': 'acquisition_price',
  'valuation.acquisitionCosts': 'acquisition_costs',
  'valuation.acquisitionDate': 'acquisition_date',
  'vacancy.generalVacancyRate': 'general_vacancy_rate',
  'vacancy.netAgainstModelledVacancy': 'net_against_modelled_vacancy',
  'vacancy.creditLossRate': 'credit_loss_rate',
};

/** The SQL cast for a model-column write, chosen by the proposal's own type. */
const MODEL_COLUMN_CAST: Record<AssumptionValueType, string> = {
  decimal: '::numeric',
  integer: '::integer',
  date: '::date',
  boolean: '::boolean',
  string: '',
  enum: '',
};

/**
 * Collections an acceptance may write, and the table and writer for each.
 *
 * The write goes through the same `upsert` a person's edit uses, with the
 * proposed field merged onto the stored row. That is deliberate: it means an
 * accepted proposal cannot clear a recovery structure, a draw schedule or a
 * custom monthly profile that the contract knows nothing about, and it means
 * an invalid value is refused by the collection's own schema rather than
 * landing in a column.
 */
export const COLLECTIONS: Record<
  string,
  {
    table: string;
    upsert: (
      db: Sql,
      modelId: string,
      body: Record<string, unknown>,
    ) => Promise<{ id: string; version: number }>;
  }
> = {
  expenses: {
    table: 'operating_expenses',
    upsert: (db, modelId, body) =>
      upsertExpense(db, { ...body, modelId } as Parameters<typeof upsertExpense>[1]),
  },
  otherRevenue: {
    table: 'other_revenue_items',
    upsert: (db, modelId, body) =>
      upsertOtherRevenue(db, { ...body, modelId } as Parameters<typeof upsertOtherRevenue>[1]),
  },
  capital: {
    table: 'capital_items',
    upsert: (db, modelId, body) =>
      upsertCapitalItem(db, { ...body, modelId } as Parameters<typeof upsertCapitalItem>[1]),
  },
  debt: {
    table: 'debt_facilities',
    upsert: (db, modelId, body) =>
      upsertDebtFacility(db, { ...body, modelId } as Parameters<typeof upsertDebtFacility>[1]),
  },
  growthCurves: {
    table: 'growth_curves',
    upsert: (db, modelId, body) =>
      upsertGrowthCurve(db, { ...body, modelId } as Parameters<typeof upsertGrowthCurve>[1]),
  },
  marketLeasing: {
    table: 'market_leasing_profiles',
    upsert: (db, modelId, body) =>
      upsertMarketLeasingProfile(db, { ...body, modelId } as Parameters<
        typeof upsertMarketLeasingProfile
      >[1]),
  },
};

/**
 * A proposal's string value, coerced to the JS type its collection `upsert`
 * actually expects — `termMonths` wants a `number`, `capitalizeInterest`
 * wants a `boolean`, everything else wants the string as given.
 *
 * The proposal itself never holds anything but a string — that is the whole
 * point of keeping `assumption_proposals.value` a single scalar column — so
 * this coercion happens once, right before the value crosses into a typed
 * `upsert` call, and nowhere else.
 */
export function coerceForCollectionField(
  raw: string,
  valueType: AssumptionValueType,
): string | number | boolean {
  switch (valueType) {
    case 'integer':
      return Number(raw);
    case 'boolean':
      return raw === 'true';
    default:
      return raw;
  }
}

/**
 * Writes an accepted value into the model.
 *
 * Runs inside the caller's transaction, alongside the decision it belongs to.
 * `target`, `value` and `valueType` are assumed already validated by
 * `describeTarget` and `validateTypedValue` — this function only writes.
 */
export async function applyAssumption(
  tx: Sql,
  modelId: string,
  target: string,
  value: string,
  valueType: AssumptionValueType,
): Promise<void> {
  const column = MODEL_COLUMNS[target];
  if (column) {
    const cast = MODEL_COLUMN_CAST[valueType];
    // `column` and `cast` are literals from the tables above; `value` and
    // `modelId` are bound parameters. The cast is what refuses a value of the
    // wrong shape rather than silently truncating or mis-typing it.
    await tx.unsafe(
      `UPDATE models SET ${column} = $1${cast}, version = version + 1, updated_at = now()
       WHERE id = $2`,
      [value, modelId],
    );
    return;
  }

  const parts = target.split('.');
  const [head, code] = [parts[0] ?? '', parts[1] ?? ''];
  const field = parts.slice(2).join('.');
  const collection = COLLECTIONS[head];
  if (!collection || !code || !field) {
    // Unreachable: the caller checks `describeTarget` first. Kept because an
    // unchecked path here would write to the wrong row rather than fail.
    throw new Error(`${target} cannot be applied automatically.`);
  }

  const rows = (await tx.unsafe(
    `SELECT * FROM ${collection.table} WHERE model_id = $1 AND code = $2 FOR UPDATE`,
    [modelId, code],
  )) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) {
    throw new AssumptionApplyError(
      `${code} is not in this model, so ${target} has nowhere to go. It may have been renamed ` +
        'or deleted since the proposal was made.',
    );
  }

  await collection.upsert(tx, modelId, {
    ...toCamelCase(row),
    [field]: coerceForCollectionField(value, valueType),
    code,
  });
}

/** Raised for a condition the caller should report to the analyst, not log as a bug. */
export class AssumptionApplyError extends Error {}

/**
 * Rows come back snake_cased; every `upsert` takes camelCase.
 *
 * The same normalisation the batch collection write does, and for the same
 * reason: a `DATE` column arrives as a `Date`, and handing that back to an
 * upsert that expects `YYYY-MM-DD` writes a timestamp.
 */
function toCamelCase(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    out[camel] =
      value instanceof Date ? (value.toISOString().split('T')[0] as string) : (value as unknown);
  }
  return out;
}
