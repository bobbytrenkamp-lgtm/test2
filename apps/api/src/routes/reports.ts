import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildModelInput, getLatestCalculation, getModel, getProperty } from '@cre/database';
import { ENGINE_VERSION, assessHealth } from '@cre/calculation-engine';
import {
  REPORTS,
  buildIcSummaryReport,
  exportLiveModel,
  findReport,
  liveModelFilename,
  reportToCsv,
  reportToPrintableHtml,
  reportToWorkbook,
  toPortableDocument,
} from '@cre/reporting';
import { notFound, queryBoolean, requireCapability, unprocessable } from '../context.js';

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reports', async (request) => {
    requireCapability(request, 'report:read');
    return {
      reports: REPORTS.map((report) => ({
        id: report.id,
        title: report.title,
        category: report.category,
        description: report.description,
      })),
    };
  });

  /**
   * Renders a report from a model's most recent calculation. The same report
   * definition serves every format, so JSON, CSV, spreadsheet and print views
   * of a report can never disagree.
   */
  app.get('/models/:id/reports/:reportId', async (request, reply) => {
    const context = requireCapability(request, 'report:read');
    const params = z
      .object({ id: z.string().uuid(), reportId: z.string().max(60) })
      .parse(request.params);
    const query = z
      .object({
        format: z.enum(['json', 'csv', 'xlsx', 'html']).default('json'),
        fiscalYears: z.string().optional(),
      })
      .parse(request.query);

    const report = findReport(params.reportId);
    if (!report) throw notFound('No report with that identifier exists.');

    const model = await getModel(request.db, context.organizationId, params.id);
    if (!model) throw notFound();
    const property = await getProperty(request.db, context.organizationId, model.property_id);

    const latest = await getLatestCalculation(request.db, params.id);
    if (!latest) {
      throw unprocessable('This model has not been calculated yet, so no report can be produced.');
    }

    const table = report.build(latest.result, {
      propertyName: property?.name ?? 'Property',
      modelName: model.name,
      currency: latest.result.currency,
      areaUnit: latest.result.areaUnit,
      fiscalYears: query.fiscalYears
        ? query.fiscalYears
            .split(',')
            .map((value) => Number(value.trim()))
            .filter(Number.isFinite)
        : undefined,
    });

    const safeName = report.id;
    switch (query.format) {
      case 'csv':
        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', `attachment; filename="${safeName}.csv"`);
        return reportToCsv(table);
      case 'xlsx': {
        requireCapability(request, 'export:run');
        const buffer = await reportToWorkbook([table]);
        reply.header(
          'content-type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        reply.header('content-disposition', `attachment; filename="${safeName}.xlsx"`);
        return reply.send(buffer);
      }
      case 'html':
        reply.header('content-type', 'text/html; charset=utf-8');
        return reportToPrintableHtml(table);
      default:
        return { report: table };
    }
  });

  /** A workbook containing every property report for a model. */
  app.get('/models/:id/export/workbook', async (request, reply) => {
    const context = requireCapability(request, 'export:run');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();
    const property = await getProperty(request.db, context.organizationId, model.property_id);
    const latest = await getLatestCalculation(request.db, id);
    if (!latest) throw unprocessable('This model has not been calculated yet.');

    const reportContext = {
      propertyName: property?.name ?? 'Property',
      modelName: model.name,
      currency: latest.result.currency,
      areaUnit: latest.result.areaUnit,
    };
    const tables = REPORTS.filter((report) => report.category === 'property').map((report) =>
      report.build(latest.result, reportContext),
    );

    const buffer = await reportToWorkbook(tables);
    reply.header(
      'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    reply.header(
      'content-disposition',
      `attachment; filename="${slug(reportContext.propertyName)}-model.xlsx"`,
    );
    return reply.send(buffer);
  });

  /**
   * The underwriting package: one workbook, one click, everything a
   * committee needs to decide.
   *
   * The same property reports `/export/workbook` already produces, plus a
   * new first sheet — the investment committee summary, built by
   * `buildIcSummaryReport` from the exact figures `ICSummaryTab.tsx` reads
   * on screen (`result.returns`, `result.valuations`, `result.debtSchedules`
   * and `assessHealth`'s own findings). Nothing is recomputed a second way:
   * this is the same stored calculation every other export and every other
   * tab reads, just assembled into the one file a reviewer used to have to
   * build by hand from five separate tabs and downloads.
   */
  app.get('/models/:id/export/underwriting-package', async (request, reply) => {
    const context = requireCapability(request, 'export:run');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();
    const property = await getProperty(request.db, context.organizationId, model.property_id);
    const latest = await getLatestCalculation(request.db, id);
    if (!latest) throw unprocessable('This model has not been calculated yet.');
    const input = await buildModelInput(request.db, context.organizationId, id);
    const health = assessHealth(input, latest.result);

    const reportContext = {
      propertyName: property?.name ?? 'Property',
      modelName: model.name,
      currency: latest.result.currency,
      areaUnit: latest.result.areaUnit,
    };
    const icSummary = buildIcSummaryReport(latest.result, health, {
      ...reportContext,
      acquisitionPrice: model.acquisition_price,
      rentableArea: property?.rentable_area ?? null,
      modelStatus: model.status.replace(/_/g, ' '),
    });
    const propertyTables = REPORTS.filter((report) => report.category === 'property').map(
      (report) => report.build(latest.result, reportContext),
    );

    const buffer = await reportToWorkbook([icSummary, ...propertyTables]);
    reply.header(
      'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    reply.header(
      'content-disposition',
      `attachment; filename="${slug(reportContext.propertyName)}-underwriting-package.xlsx"`,
    );
    return reply.send(buffer);
  });

  /**
   * The Excel Live Model: a formula-driven workbook.
   *
   * Distinct from `/export/workbook`, which writes the same figures as static
   * values. This one exports the assumptions as editable cells and the
   * calculations as Excel formulas, so changing a cap rate in Excel moves the
   * sale price and the return without coming back to the platform.
   *
   * The formula-coverage figure is returned as a response header rather than
   * being hidden in a log: anyone can see how much of the workbook is genuinely
   * calculated, which is the honest form of the claim this feature makes.
   */
  app.get('/models/:id/export/live-model', async (request, reply) => {
    const context = requireCapability(request, 'export:run');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();
    const latest = await getLatestCalculation(request.db, id);
    if (!latest) throw unprocessable('This model has not been calculated yet.');

    // The workbook needs the assumptions, not only the results: the whole point
    // is that the inputs arrive as editable cells.
    const modelInput = await buildModelInput(request.db, context.organizationId, id);
    const property = await getProperty(request.db, context.organizationId, model.property_id);

    const { buffer, coverage } = await exportLiveModel(modelInput, latest.result);

    reply.header(
      'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    reply.header(
      'content-disposition',
      `attachment; filename="${liveModelFilename(
        property?.name ?? 'Property',
        model.name,
        new Date(),
      )}"`,
    );
    reply.header('x-formula-coverage', coverage.formulaCoverage.toFixed(4));
    reply.header('x-formula-cells', String(coverage.formulaCells));
    reply.header('x-calculated-cells', String(coverage.calculatedCells));
    return reply.send(buffer);
  });

  /**
   * Portable JSON export. A documented, non-proprietary format for backups and
   * integrations; it is not an interchange format for any other vendor's files.
   */
  app.get('/models/:id/export/json', async (request, reply) => {
    const context = requireCapability(request, 'export:run');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ includeResult: queryBoolean(true) }).parse(request.query);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();

    const input = await buildModelInput(request.db, context.organizationId, id);
    const latest = query.includeResult ? await getLatestCalculation(request.db, id) : null;
    const document = toPortableDocument(input, ENGINE_VERSION, latest?.result);

    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${slug(model.name)}.cremodel.json"`);
    return document;
  });
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'model'
  );
}
