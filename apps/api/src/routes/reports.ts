import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildModelInput, getLatestCalculation, getModel, getProperty } from '@cre/database';
import { ENGINE_VERSION } from '@cre/calculation-engine';
import {
  REPORTS,
  findReport,
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
