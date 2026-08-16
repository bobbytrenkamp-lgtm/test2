import {
  buildModelInput,
  getLatestCalculation,
  getModel,
  runAndStoreCalculation,
  type JobRow,
  type Sql,
} from '@cre/database';
import {
  ENGINE_VERSION,
  aggregatePortfolio,
  calculate,
  type PortfolioMember,
} from '@cre/calculation-engine';
import { REPORTS, reportToWorkbook } from '@cre/reporting';
import { decimalString, type ModelInput } from '@cre/domain-models';

/**
 * Job handlers.
 *
 * A handler receives the claimed job and returns the value stored on it. It
 * must be safe to run twice: a worker can be killed after doing the work but
 * before recording success, so the queue will hand the job to someone else.
 */
export type JobHandler = (sql: Sql, job: JobRow) => Promise<unknown>;

export const handlers: Record<string, JobHandler> = {
  async calculate_model(sql, job) {
    const modelId = job.payload.modelId as string;
    const organizationId = job.organization_id;
    if (!organizationId) throw new Error('calculate_model requires an organization.');
    const { run, result } = await runAndStoreCalculation(sql, organizationId, modelId, {
      withTrace: Boolean(job.payload.withTrace),
      requestedBy: job.payload.requestedBy as string | null,
    });
    return {
      runId: run.id,
      engineVersion: result.engineVersion,
      errorCount: result.diagnostics.filter((entry) => entry.severity === 'error').length,
    };
  },

  /**
   * Runs a set of named scenarios against one model. Each scenario is a full
   * engine run on a modified copy of the input, so the results are directly
   * comparable and every one records the engine version that produced it.
   */
  async run_scenario_batch(sql, job) {
    const modelId = job.payload.modelId as string;
    const organizationId = job.organization_id;
    if (!organizationId) throw new Error('run_scenario_batch requires an organization.');
    const scenarios = job.payload.scenarios as Array<{
      name: string;
      overrides: Array<{ variable: string; value: string }>;
    }>;

    const baseInput = await buildModelInput(sql, organizationId, modelId);
    const results = scenarios.map((scenario) => {
      const input = applyOverrides(baseInput, scenario.overrides);
      const result = calculate(input, { trace: { enabled: false } });
      return {
        name: scenario.name,
        overrides: scenario.overrides,
        dcfValue: result.valuations.find((v) => v.method === 'dcf')?.value ?? null,
        unleveredIrr: result.returns.unleveredIrr,
        leveredIrr: result.returns.leveredIrr,
        equityMultiple: result.returns.equityMultiple,
        year1Noi: result.annual[0]?.lines.netOperatingIncome ?? null,
        errorCount: result.diagnostics.filter((entry) => entry.severity === 'error').length,
      };
    });

    return { engineVersion: ENGINE_VERSION, scenarios: results };
  },

  /**
   * Renders every property report for a model into a single workbook and
   * stores it as a base64 payload on the job. Large exports belong in object
   * storage; see docs/architecture.md for the storage abstraction.
   */
  async export_workbook(sql, job) {
    const modelId = job.payload.modelId as string;
    const organizationId = job.organization_id;
    if (!organizationId) throw new Error('export_workbook requires an organization.');

    const model = await getModel(sql, organizationId, modelId);
    if (!model) throw new Error(`Model ${modelId} was not found.`);
    const latest = await getLatestCalculation(sql, modelId);
    if (!latest) throw new Error('The model has not been calculated, so no workbook can be built.');

    const context = {
      propertyName: (job.payload.propertyName as string) ?? 'Property',
      modelName: model.name,
      currency: latest.result.currency,
      areaUnit: latest.result.areaUnit,
    };
    const tables = REPORTS.filter((report) => report.category === 'property').map((report) =>
      report.build(latest.result, context),
    );
    const buffer = await reportToWorkbook(tables);
    return { bytes: buffer.byteLength, encoding: 'base64', content: buffer.toString('base64') };
  },

  /** Recomputes a portfolio roll-up from each member's latest calculation. */
  async aggregate_portfolio(sql, job) {
    const portfolioId = job.payload.portfolioId as string;
    const organizationId = job.organization_id;
    if (!organizationId) throw new Error('aggregate_portfolio requires an organization.');

    // The portfolio itself must belong to this job's organization: nothing
    // upstream of this query re-checks that, so without it a job whose
    // payload names another organization's portfolio id would aggregate
    // that organization's property data across the boundary.
    const portfolioRows = (await sql`
      SELECT id FROM portfolios
      WHERE id = ${portfolioId} AND organization_id = ${organizationId} AND deleted_at IS NULL
    `) as unknown as Array<{ id: string }>;
    if (!portfolioRows[0]) {
      throw new Error(`Portfolio ${portfolioId} was not found in this organization.`);
    }

    const properties = (await sql`
      SELECT p.id, p.name, p.property_type, p.market, p.rentable_area, p.unit_count,
             pp.ownership_percent
      FROM portfolio_properties pp
      JOIN properties p ON p.id = pp.property_id
      WHERE pp.portfolio_id = ${portfolioId}
        AND p.organization_id = ${organizationId}
        AND p.deleted_at IS NULL
    `) as unknown as Array<Record<string, unknown>>;

    const members: PortfolioMember[] = [];
    const excluded: string[] = [];
    for (const property of properties) {
      const modelRows = (await sql`
        SELECT id FROM models
        WHERE property_id = ${property.id as string} AND deleted_at IS NULL
        ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, updated_at DESC
        LIMIT 1
      `) as unknown as Array<{ id: string }>;
      const modelId = modelRows[0]?.id;
      if (!modelId) {
        excluded.push(property.name as string);
        continue;
      }
      const latest = await getLatestCalculation(sql, modelId);
      if (!latest) {
        excluded.push(property.name as string);
        continue;
      }
      members.push({
        propertyId: property.id as string,
        propertyName: property.name as string,
        propertyType: property.property_type as string,
        market: (property.market as string | null) ?? null,
        ownershipPercent: (property.ownership_percent as string) ?? '1',
        rentableArea: (property.rentable_area as string | null) ?? null,
        unitCount: (property.unit_count as number) ?? 0,
        result: latest.result,
      });
    }

    if (members.length === 0) {
      throw new Error('No property in this portfolio has a calculated model.');
    }
    return { aggregate: aggregatePortfolio(members), excluded };
  },
};

const OVERRIDABLE = new Set([
  'discountRate',
  'terminalCapRate',
  'saleCostPercent',
  'saleMonth',
  'acquisitionPrice',
  'generalVacancyRate',
  'creditLossRate',
  'directCapRate',
]);

/**
 * Rejects an override value the API layer should already have validated
 * before enqueueing this job — defense in depth against a job inserted by
 * some future caller that bypasses the route, the same reasoning behind this
 * codebase's CHECK constraints under application-level zod validation. A
 * `saleMonth` that isn't a positive whole number, or any other override that
 * isn't a decimal string, would otherwise flow straight into the engine as
 * `NaN` or an unparsable string and throw a decimal.js error with no
 * reference to which scenario or variable was at fault.
 */
function validateOverrideValue(variable: string, value: string): void {
  if (variable === 'saleMonth') {
    const month = Number(value);
    if (!Number.isInteger(month) || month < 1) {
      throw new Error('A sale month must be a positive whole number of months.');
    }
    return;
  }
  if (!decimalString.safeParse(value).success) {
    throw new Error(`"${variable}" must be a decimal number, got "${value}".`);
  }
}

function applyOverrides(
  input: ModelInput,
  overrides: Array<{ variable: string; value: string }>,
): ModelInput {
  const next: ModelInput = {
    ...input,
    valuation: { ...input.valuation },
    vacancy: { ...input.vacancy },
  };
  for (const override of overrides) {
    if (!OVERRIDABLE.has(override.variable)) {
      throw new Error(`"${override.variable}" is not an overridable scenario variable.`);
    }
    validateOverrideValue(override.variable, override.value);
    switch (override.variable) {
      case 'discountRate':
        next.valuation.discountRate = override.value;
        break;
      case 'terminalCapRate':
        next.valuation.terminalCapRate = override.value;
        break;
      case 'saleCostPercent':
        next.valuation.saleCostPercent = override.value;
        break;
      case 'saleMonth':
        next.valuation.saleMonth = Number(override.value);
        break;
      case 'acquisitionPrice':
        next.valuation.acquisitionPrice = override.value;
        break;
      case 'directCapRate':
        next.valuation.directCapRate = override.value;
        break;
      case 'generalVacancyRate':
        next.vacancy.generalVacancyRate = override.value;
        break;
      case 'creditLossRate':
        next.vacancy.creditLossRate = override.value;
        break;
    }
  }
  return next;
}
