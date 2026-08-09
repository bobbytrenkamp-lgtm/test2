import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildModelInput,
  enqueueJob,
  getLatestCalculation,
  getModel,
  getModelVersionInput,
  getTrace,
  runAndStoreCalculation,
  runAndStoreCalculationFromInput,
  writeAudit,
} from '@cre/database';
import { ENGINE_VERSION, calculate, compareVersions } from '@cre/calculation-engine';
import type { ModelInput } from '@cre/domain-models';
import { badRequest, notFound, requireCapability, unprocessable } from '../context.js';

/**
 * Calculation routes.
 *
 * A model of ordinary size calculates in well under a second, so the default
 * path is synchronous. Large batches (a sensitivity grid, a portfolio roll-up)
 * are queued to the worker instead, and the caller polls the job.
 */
export async function registerCalculationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/models/:id/calculate', async (request) => {
    const context = requireCapability(request, 'model:calculate');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ withTrace: z.boolean().default(false), async: z.boolean().default(false) })
      .parse(request.body ?? {});

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound('That model does not exist in this organization.');

    if (body.async) {
      const job = await enqueueJob(request.db, {
        organizationId: context.organizationId,
        kind: 'calculate_model',
        payload: { modelId: id, withTrace: body.withTrace },
        requestedBy: context.userId,
      });
      return { jobId: job.id, status: job.status };
    }

    const { run, result } = await runAndStoreCalculation(request.db, context.organizationId, id, {
      withTrace: body.withTrace,
      requestedBy: context.userId,
    });

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'model.calculated',
      entityType: 'calculation_run',
      entityId: run.id,
      modelId: id,
      propertyId: model.property_id,
      metadata: { engineVersion: run.engine_version, durationMs: run.duration_ms },
      ipAddress: request.ip,
    });

    return {
      runId: run.id,
      engineVersion: result.engineVersion,
      diagnostics: result.diagnostics,
      annual: result.annual,
      returns: result.returns,
      valuations: result.valuations,
    };
  });

  /** The most recent stored result, without re-running the engine. */
  app.get('/models/:id/cashflow', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z
      .object({ granularity: z.enum(['monthly', 'annual', 'both']).default('both') })
      .parse(request.query);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();

    const latest = await getLatestCalculation(request.db, id);
    if (!latest) {
      throw unprocessable(
        'This model has not been calculated yet. Run a calculation to produce a cash flow.',
      );
    }

    const { result, run } = latest;
    return {
      runId: run.id,
      engineVersion: result.engineVersion,
      calculatedAt: result.calculatedAt,
      currency: result.currency,
      areaUnit: result.areaUnit,
      periods: result.periods,
      ...(query.granularity !== 'annual' ? { monthly: result.monthly } : {}),
      ...(query.granularity !== 'monthly' ? { annual: result.annual } : {}),
      occupancy: result.occupancy,
      valuations: result.valuations,
      returns: result.returns,
      diagnostics: result.diagnostics,
      debtSchedules: result.debtSchedules,
      waterfall: result.waterfall,
      recoveryDetail: result.recoveryDetail,
      leaseCashFlows: result.leaseCashFlows,
    };
  });

  /**
   * Calculation inspector. Returns the trace entries that produced a value,
   * optionally filtered to a target prefix so the client can ask "explain this
   * cell" rather than downloading the whole trace.
   */
  app.get('/models/:id/trace', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z
      .object({
        runId: z.string().uuid().optional(),
        target: z.string().max(200).optional(),
        formula: z.string().max(120).optional(),
        /**
         * Matches the start of the formula name, e.g. `recovery.`.
         *
         * Several lines share a target prefix — everything a lease occurrence
         * produces sits under `occurrence:` — so narrowing by target alone
         * cannot separate a recovery derivation from a base-rent one. Doing it
         * client-side does not work either: the limit is applied after
         * filtering, so a month with three hundred base-rent entries pushes the
         * recoveries past it and the caller sees none.
         */
        formulaPrefix: z.string().max(120).optional(),
        periodIndex: z.coerce.number().int().min(1).optional(),
        /**
         * An inclusive span of periods, for a figure that covers more than one.
         *
         * A fiscal-year column on the cash flow is twelve months, and several
         * derivations — a recovery settlement above all — are recorded in the
         * month they settle rather than in every month they affect. Filtering
         * such a figure to the first month of its year returns nothing and the
         * panel truthfully reports that it has no trace, which is unhelpful
         * and reads as a defect.
         *
         * `periodIndex` still works and still means exactly one period.
         */
        periodFrom: z.coerce.number().int().min(1).optional(),
        periodTo: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(2000).default(500),
      })
      .parse(request.query);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();

    let runId = query.runId;
    if (!runId) {
      const latest = await getLatestCalculation(request.db, id);
      if (!latest) throw unprocessable('This model has not been calculated yet.');
      runId = latest.run.id;
    }

    const entries = await getTrace(request.db, runId);
    if (entries.length === 0) {
      throw unprocessable(
        'That calculation was run without a trace. Re-run the calculation with tracing enabled to inspect its values.',
      );
    }

    const filtered = entries.filter((entry) => {
      if (query.target && !entry.target.startsWith(query.target)) return false;
      if (query.formula && entry.formula !== query.formula) return false;
      if (query.formulaPrefix && !entry.formula.startsWith(query.formulaPrefix)) return false;
      if (query.periodIndex && entry.periodIndex !== query.periodIndex) return false;
      if (query.periodFrom !== undefined || query.periodTo !== undefined) {
        // An entry with no period at all — a valuation, say — is not in any
        // span, so it is excluded rather than let through.
        if (entry.periodIndex === undefined) return false;
        if (query.periodFrom !== undefined && entry.periodIndex < query.periodFrom) return false;
        if (query.periodTo !== undefined && entry.periodIndex > query.periodTo) return false;
      }
      return true;
    });

    return { runId, total: filtered.length, entries: filtered.slice(0, query.limit) };
  });

  /**
   * Recalculates a stored version from its frozen input.
   *
   * The result is not written back: the point is to show what the approved
   * assumptions produce under the current engine, which is how an engine
   * upgrade is assessed before it is adopted.
   */
  app.post('/models/:id/versions/:versionId/recalculate', async (request) => {
    const context = requireCapability(request, 'model:calculate');
    const params = z
      .object({ id: z.string().uuid(), versionId: z.string().uuid() })
      .parse(request.params);
    const model = await getModel(request.db, context.organizationId, params.id);
    if (!model) throw notFound();

    const input = await getModelVersionInput(request.db, params.id, params.versionId);
    if (!input) throw notFound('That version does not exist on this model.');

    const result = calculate(input, { trace: { enabled: false } });
    return {
      engineVersion: result.engineVersion,
      annual: result.annual,
      returns: result.returns,
      valuations: result.valuations,
      diagnostics: result.diagnostics,
    };
  });

  /**
   * Side-by-side comparison of two frozen versions.
   *
   * Both are recalculated under the *current* engine rather than read from
   * their stored results, so the comparison isolates what someone edited. Two
   * results produced by different engine versions can differ for reasons nobody
   * changed, and attributing that to an assumption is exactly the mistake this
   * screen exists to prevent. The engine versions each was originally
   * calculated under are reported alongside, so the reader can see when a
   * stored figure will not match what is shown here.
   */
  app.get('/models/:id/versions/:beforeId/compare/:afterId', async (request) => {
    const context = requireCapability(request, 'model:read');
    const params = z
      .object({
        id: z.string().uuid(),
        beforeId: z.string().uuid(),
        afterId: z.string().uuid(),
      })
      .parse(request.params);

    const model = await getModel(request.db, context.organizationId, params.id);
    if (!model) throw notFound();
    if (params.beforeId === params.afterId) {
      throw badRequest('A version cannot be compared with itself.');
    }

    const [beforeInput, afterInput] = await Promise.all([
      getModelVersionInput(request.db, params.id, params.beforeId),
      getModelVersionInput(request.db, params.id, params.afterId),
    ]);
    if (!beforeInput) throw notFound('The earlier version does not exist on this model.');
    if (!afterInput) throw notFound('The later version does not exist on this model.');

    const stored = (await request.db`
      SELECT id, version_number, label, engine_version, created_at
      FROM model_versions
      WHERE model_id = ${params.id} AND id IN (${params.beforeId}, ${params.afterId})
    `) as unknown as Array<Record<string, unknown>>;
    const byId = new Map(stored.map((row) => [row.id as string, row]));

    const comparison = compareVersions(
      { input: beforeInput, result: calculate(beforeInput, { trace: { enabled: false } }) },
      { input: afterInput, result: calculate(afterInput, { trace: { enabled: false } }) },
    );

    return {
      engineVersion: ENGINE_VERSION,
      before: byId.get(params.beforeId) ?? null,
      after: byId.get(params.afterId) ?? null,
      comparison,
    };
  });

  /**
   * Sensitivity analysis. One-way and two-way grids over named assumptions,
   * each cell a full engine run against a modified copy of the model input.
   */
  app.post('/models/:id/sensitivity', async (request) => {
    const context = requireCapability(request, 'model:calculate');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        rows: z.object({
          variable: z.enum(SENSITIVITY_VARIABLES),
          values: z.array(z.string()).min(1).max(15),
        }),
        columns: z
          .object({
            variable: z.enum(SENSITIVITY_VARIABLES),
            values: z.array(z.string()).min(1).max(15),
          })
          .nullish(),
        metric: z
          .enum(['dcfValue', 'unleveredIrr', 'leveredIrr', 'equityMultiple', 'year1Noi'])
          .default('dcfValue'),
      })
      .parse(request.body);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();
    const baseInput = await buildModelInput(request.db, context.organizationId, id);

    const columnValues = body.columns?.values ?? [null];
    const grid: string[][] = [];
    for (const rowValue of body.rows.values) {
      const row: string[] = [];
      for (const columnValue of columnValues) {
        let input = applySensitivity(baseInput, body.rows.variable, rowValue);
        if (body.columns && columnValue !== null) {
          input = applySensitivity(input, body.columns.variable, columnValue);
        }
        const result = calculate(input, { trace: { enabled: false } });
        row.push(extractMetric(result, body.metric));
      }
      grid.push(row);
    }

    return {
      engineVersion: ENGINE_VERSION,
      metric: body.metric,
      rows: { variable: body.rows.variable, values: body.rows.values },
      columns: body.columns ?? null,
      grid,
    };
  });

  /** Runs a batch of scenarios in the worker and returns a job to poll. */
  app.post('/models/:id/scenario-batch', async (request) => {
    const context = requireCapability(request, 'model:calculate');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        scenarios: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              overrides: z.array(
                z.object({ variable: z.enum(SENSITIVITY_VARIABLES), value: z.string() }),
              ),
            }),
          )
          .min(1)
          .max(50),
      })
      .parse(request.body);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();

    const job = await enqueueJob(request.db, {
      organizationId: context.organizationId,
      kind: 'run_scenario_batch',
      payload: { modelId: id, scenarios: body.scenarios },
      requestedBy: context.userId,
    });
    return { jobId: job.id, status: job.status };
  });
}

const SENSITIVITY_VARIABLES = [
  'discountRate',
  'terminalCapRate',
  'saleCostPercent',
  'saleMonth',
  'acquisitionPrice',
  'generalVacancyRate',
  'creditLossRate',
  'directCapRate',
] as const;

type SensitivityVariable = (typeof SENSITIVITY_VARIABLES)[number];

/**
 * Returns a copy of the model input with one assumption replaced. The base
 * input is never mutated, so a grid of runs cannot contaminate each other.
 */
function applySensitivity(
  input: ModelInput,
  variable: SensitivityVariable,
  value: string,
): ModelInput {
  const next: ModelInput = {
    ...input,
    valuation: { ...input.valuation },
    vacancy: { ...input.vacancy },
  };
  switch (variable) {
    case 'discountRate':
      next.valuation.discountRate = value;
      break;
    case 'terminalCapRate':
      next.valuation.terminalCapRate = value;
      break;
    case 'saleCostPercent':
      next.valuation.saleCostPercent = value;
      break;
    case 'saleMonth': {
      const month = Number(value);
      if (!Number.isInteger(month) || month < 1) {
        throw badRequest('A sale month must be a positive whole number of months.');
      }
      next.valuation.saleMonth = month;
      break;
    }
    case 'acquisitionPrice':
      next.valuation.acquisitionPrice = value;
      break;
    case 'directCapRate':
      next.valuation.directCapRate = value;
      break;
    case 'generalVacancyRate':
      next.vacancy.generalVacancyRate = value;
      break;
    case 'creditLossRate':
      next.vacancy.creditLossRate = value;
      break;
  }
  return next;
}

function extractMetric(
  result: ReturnType<typeof calculate>,
  metric: 'dcfValue' | 'unleveredIrr' | 'leveredIrr' | 'equityMultiple' | 'year1Noi',
): string {
  switch (metric) {
    case 'dcfValue':
      return result.valuations.find((v) => v.method === 'dcf')?.value ?? '0';
    case 'unleveredIrr':
      return result.returns.unleveredIrr ?? '';
    case 'leveredIrr':
      return result.returns.leveredIrr ?? '';
    case 'equityMultiple':
      return result.returns.equityMultiple ?? '';
    case 'year1Noi':
      return result.annual[0]?.lines.netOperatingIncome ?? '0';
  }
}

export { runAndStoreCalculationFromInput };
