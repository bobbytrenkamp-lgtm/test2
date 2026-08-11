import type { Diagnostic, ModelInput, ModelResult } from '@cre/domain-models';
import { ENGINE_VERSION, calculate } from '@cre/calculation-engine';
import type { Sql } from '../client.js';
import { buildModelInput } from './models.js';

/**
 * Calculation persistence.
 *
 * A run stores the result and, separately, the trace. Traces are an order of
 * magnitude larger than the result and are only read when a user opens the
 * calculation inspector, so keeping them in their own table stops every cash
 * flow request from dragging them along.
 */

export interface CalculationRunRow {
  id: string;
  model_id: string;
  model_version_id: string | null;
  engine_version: string;
  status: string;
  diagnostics: Diagnostic[];
  duration_ms: number | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface RunOptions {
  /** Records a trace alongside the result so values can be inspected later. */
  withTrace?: boolean;
  modelVersionId?: string | null;
  requestedBy?: string | null;
}

export async function runAndStoreCalculation(
  sql: Sql,
  organizationId: string,
  modelId: string,
  options: RunOptions = {},
): Promise<{ run: CalculationRunRow; result: ModelResult }> {
  const input = await buildModelInput(sql, organizationId, modelId);
  return runAndStoreCalculationFromInput(sql, modelId, input, options);
}

export async function runAndStoreCalculationFromInput(
  sql: Sql,
  modelId: string,
  input: ModelInput,
  options: RunOptions = {},
): Promise<{ run: CalculationRunRow; result: ModelResult }> {
  const startedAt = Date.now();
  let result: ModelResult;
  try {
    result = calculate(input, { trace: { enabled: options.withTrace ?? false } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rows = (await sql`
      INSERT INTO calculation_runs
        (model_id, model_version_id, engine_version, status, error_message, duration_ms, requested_by, completed_at)
      VALUES (
        ${modelId}, ${options.modelVersionId ?? null}, ${ENGINE_VERSION}, 'failed',
        ${message}, ${Date.now() - startedAt}, ${options.requestedBy ?? null}, now()
      )
      RETURNING id, model_id, model_version_id, engine_version, status, diagnostics, duration_ms, created_at, completed_at
    `) as unknown as CalculationRunRow[];
    void rows;
    throw error;
  }

  const durationMs = Date.now() - startedAt;
  const { trace, ...resultWithoutTrace } = result;

  const run = (await sql.begin(async (tx) => {
    const rows = (await tx`
      INSERT INTO calculation_runs
        (model_id, model_version_id, engine_version, status, result, diagnostics, duration_ms, requested_by, completed_at)
      VALUES (
        ${modelId}, ${options.modelVersionId ?? null}, ${result.engineVersion}, 'succeeded',
        ${tx.json({ ...resultWithoutTrace, trace: [] } as never)},
        ${tx.json(result.diagnostics as never)},
        ${durationMs}, ${options.requestedBy ?? null}, now()
      )
      RETURNING id, model_id, model_version_id, engine_version, status, diagnostics, duration_ms, created_at, completed_at
    `) as unknown as CalculationRunRow[];
    const inserted = rows[0] as CalculationRunRow;

    if (trace.length > 0) {
      await tx`
        INSERT INTO calculation_traces (calculation_run_id, entries)
        VALUES (${inserted.id}, ${tx.json(trace as never)})
      `;
    }
    return inserted;
  })) as CalculationRunRow;

  return { run, result };
}

export async function getLatestCalculation(
  sql: Sql,
  modelId: string,
): Promise<{ run: CalculationRunRow; result: ModelResult } | null> {
  const rows = (await sql`
    SELECT id, model_id, model_version_id, engine_version, status, result, diagnostics,
           duration_ms, created_at, completed_at
    FROM calculation_runs
    WHERE model_id = ${modelId} AND status = 'succeeded'
    ORDER BY created_at DESC
    LIMIT 1
  `) as unknown as Array<CalculationRunRow & { result: ModelResult }>;
  const row = rows[0];
  if (!row) return null;
  const { result, ...run } = row;
  return { run, result };
}

/**
 * A trace by run id, scoped to the model it is claimed to belong to.
 *
 * `runId` reaches this from a query parameter (`GET /models/:id/trace`), so
 * it is not to be trusted on its own: without the join to `calculation_runs`
 * and the `model_id` filter, a caller who already has `model:read` on one of
 * their own models could supply any run id and read another organization's
 * trace — the trace table itself carries no organization column to check.
 */
export async function getTrace(
  sql: Sql,
  modelId: string,
  runId: string,
): Promise<ModelResult['trace']> {
  const rows = (await sql`
    SELECT ct.entries
    FROM calculation_traces ct
    JOIN calculation_runs cr ON cr.id = ct.calculation_run_id
    WHERE ct.calculation_run_id = ${runId} AND cr.model_id = ${modelId}
  `) as unknown as Array<{ entries: ModelResult['trace'] }>;
  return rows[0]?.entries ?? [];
}
