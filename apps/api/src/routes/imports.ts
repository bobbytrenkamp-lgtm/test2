import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getModel, createTenant, listTenants, upsertLease, writeAudit } from '@cre/database';
import {
  analyzeSheet,
  isWorkbookFilename,
  pickRentRollSheet,
  readWorkbook,
  mapRows,
  parseCsv,
  suggestMapping,
  type ColumnMapping,
} from '@cre/reporting';
import { badRequest, notFound, requireCapability } from '../context.js';

/**
 * Rent-roll import.
 *
 * The flow is analyse, map, validate, import, and each step is a separate call
 * so the user can correct a mapping before anything is written. The import
 * itself runs in one transaction: either every valid lease lands or none does,
 * which is what makes the rollback offered afterwards meaningful.
 *
 * Uploaded content never leaves this process. Parsing is entirely
 * deterministic; no AI provider is contacted at any point.
 */
export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The rows of an upload, whichever format it arrived in.
   *
   * One function rather than a dispatch in each of the three routes below: they
   * must agree about what a file contains, and analysing a CSV then committing it
   * as a workbook — or picking a different sheet at each step — would import
   * something nobody previewed.
   *
   * A workbook arrives base64-encoded because it is binary; a CSV arrives as
   * text. The sheet is chosen by the caller when it knows, and suggested when it
   * does not, so the same sheet is used at every step of the wizard.
   */
  async function rowsFromUpload(
    filename: string,
    content: string,
    sheetIndex?: number,
  ): Promise<{ rows: string[][]; sheetNames: string[]; sheetIndex: number }> {
    if (!isWorkbookFilename(filename)) {
      return { rows: parseCsv(content), sheetNames: [], sheetIndex: 0 };
    }

    let sheets;
    try {
      sheets = await readWorkbook(Buffer.from(content, 'base64'));
    } catch {
      // A corrupt or password-protected workbook is the caller's problem to fix,
      // and saying so beats a 500 that reads like the server broke.
      throw badRequest(
        'That spreadsheet could not be read. If it is password protected, or saved in the older .xls format, save it as .xlsx and try again.',
      );
    }
    if (sheets.length === 0) throw badRequest('That workbook has no sheets.');

    const chosen = sheetIndex ?? pickRentRollSheet(sheets);
    if (chosen < 0 || chosen >= sheets.length) {
      throw badRequest(`That workbook has ${sheets.length} sheet(s); sheet ${chosen} is not one.`);
    }
    return {
      rows: sheets[chosen]?.rows ?? [],
      sheetNames: sheets.map((sheet) => sheet.name),
      sheetIndex: chosen,
    };
  }

  /** Step 1: inspect an uploaded file and propose a mapping. */
  app.post('/models/:id/imports/analyze', async (request) => {
    const context = requireCapability(request, 'import:run');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        filename: z.string().max(300),
        content: z.string().max(20 * 1024 * 1024),
        /** Which worksheet, for a workbook. Suggested when absent. */
        sheetIndex: z.number().int().min(0).max(200).optional(),
        previewRows: z.number().int().min(1).max(200).default(25),
      })
      .parse(request.body);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound('That model does not exist in this organization.');

    const upload = await rowsFromUpload(body.filename, body.content, body.sheetIndex);
    const rows = upload.rows;
    if (rows.length === 0) throw badRequest('That file contains no rows.');

    const analysis = analyzeSheet(rows);
    const mapping = suggestMapping(analysis.headers);

    const batch = (await request.db`
      INSERT INTO import_batches (
        organization_id, model_id, kind, status, source_filename, header_row,
        detected_columns, mapping, row_count, created_by
      ) VALUES (
        ${context.organizationId}, ${id}, 'rent_roll', 'analyzed', ${body.filename},
        ${analysis.headerRowIndex}, ${request.db.json(analysis.headers as never)},
        ${request.db.json(mapping as never)}, ${analysis.dataRows.length}, ${context.userId}
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;

    return {
      batchId: (batch[0] as { id: string }).id,
      headerRowIndex: analysis.headerRowIndex,
      headers: analysis.headers,
      confidence: analysis.confidence,
      suggestedMapping: mapping,
      rowCount: analysis.dataRows.length,
      preview: analysis.dataRows.slice(0, body.previewRows),
      /*
       * Which sheet was read, and what else the workbook holds. Empty for a
       * CSV. Returned so the wizard can show the choice rather than making it
       * invisibly — a workbook with a cover sheet first is the common case, and
       * importing the cover is the mistake worth making visible.
       */
      sheetNames: upload.sheetNames,
      sheetIndex: upload.sheetIndex,
    };
  });

  /** Step 2: validate the file against a mapping without writing anything. */
  app.post('/models/:id/imports/validate', async (request) => {
    const context = requireCapability(request, 'import:run');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        batchId: z.string().uuid().optional(),
        /*
         * Optional, and absent means CSV — which is what every existing caller
         * sends. The dispatcher needs the name to know whether the content is
         * text or a base64 workbook, and defaulting to text keeps a client
         * written before this change working unchanged.
         */
        filename: z.string().max(300).default(''),
        sheetIndex: z.number().int().min(0).max(200).optional(),
        content: z.string().max(20 * 1024 * 1024),
        mapping: z.record(z.number().int().min(0)),
        datePreference: z.enum(['mdy', 'dmy']).default('mdy'),
        defaultRentBasis: z.string().max(40).optional(),
      })
      .parse(request.body);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();

    const analysis = analyzeSheet(
      (await rowsFromUpload(body.filename, body.content, body.sheetIndex)).rows,
    );
    const result = mapRows(analysis.dataRows, body.mapping as ColumnMapping, {
      datePreference: body.datePreference,
      defaultRentBasis: body.defaultRentBasis,
    });

    if (body.batchId) {
      await request.db`
        UPDATE import_batches
        SET status = 'validated', mapping = ${request.db.json(body.mapping as never)},
            errors = ${request.db.json(result.issues.filter((i) => i.severity === 'error') as never)},
            warnings = ${request.db.json(result.issues.filter((i) => i.severity === 'warning') as never)}
        WHERE id = ${body.batchId} AND organization_id = ${context.organizationId}
      `;
    }

    return {
      readyToImport: result.issues.every((issue) => issue.severity !== 'error'),
      leaseCount: result.leases.length,
      issues: result.issues,
      duplicates: result.duplicates,
      preview: result.leases.slice(0, 25),
    };
  });

  /**
   * Step 3: import. Rows carrying an error are never written; the caller must
   * fix them or explicitly choose to skip them.
   */
  app.post('/models/:id/imports/commit', async (request) => {
    const context = requireCapability(request, 'import:run');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        batchId: z.string().uuid().optional(),
        /*
         * Optional, and absent means CSV — which is what every existing caller
         * sends. The dispatcher needs the name to know whether the content is
         * text or a base64 workbook, and defaulting to text keeps a client
         * written before this change working unchanged.
         */
        filename: z.string().max(300).default(''),
        sheetIndex: z.number().int().min(0).max(200).optional(),
        content: z.string().max(20 * 1024 * 1024),
        mapping: z.record(z.number().int().min(0)),
        datePreference: z.enum(['mdy', 'dmy']).default('mdy'),
        defaultRentBasis: z.string().max(40).optional(),
        skipRowsWithErrors: z.boolean().default(false),
        saveMappingAs: z.string().max(120).optional(),
      })
      .parse(request.body);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();
    if (['approved', 'published', 'superseded', 'archived'].includes(model.status)) {
      throw badRequest(`This model is ${model.status} and cannot be imported into.`);
    }

    const analysis = analyzeSheet(
      (await rowsFromUpload(body.filename, body.content, body.sheetIndex)).rows,
    );
    const result = mapRows(analysis.dataRows, body.mapping as ColumnMapping, {
      datePreference: body.datePreference,
      defaultRentBasis: body.defaultRentBasis,
    });

    const errors = result.issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0 && !body.skipRowsWithErrors) {
      throw badRequest(
        `The file has ${errors.length} error(s). Correct them, or re-send with skipRowsWithErrors to import only the valid rows.`,
        { issues: errors.slice(0, 50) },
      );
    }

    const errorRows = new Set(errors.map((issue) => issue.rowIndex));
    const importable = result.leases.filter((lease) => !errorRows.has(lease.rowIndex));

    // Tenants are matched by name inside the property before a new one is
    // created, so re-importing an updated rent roll does not duplicate them.
    const existingTenants = await listTenants(
      request.db,
      context.organizationId,
      model.property_id,
    );
    const tenantsByName = new Map(
      existingTenants.map((tenant) => [tenant.name.trim().toLowerCase(), tenant.id]),
    );

    let imported = 0;
    for (const lease of importable) {
      const key = lease.tenantName.trim().toLowerCase();
      let tenantId = tenantsByName.get(key);
      if (!tenantId) {
        const tenant = await createTenant(request.db, {
          organizationId: context.organizationId,
          propertyId: model.property_id,
          name: lease.tenantName,
        });
        tenantId = tenant.id;
        tenantsByName.set(key, tenantId);
      }

      await upsertLease(request.db, {
        modelId: id,
        code: lease.leaseCode,
        tenantId,
        status: lease.status,
        area: lease.area,
        unitCount: lease.unitCount,
        spaceIds: [lease.spaceCode],
        commencementDate: lease.commencementDate,
        rentStartDate: lease.rentStartDate,
        expirationDate: lease.expirationDate,
        baseRent: lease.baseRent,
        baseRentBasis: lease.baseRentBasis,
        recovery: { method: lease.recoveryMethod },
        leasingCosts: lease.tiPerArea ? { tiPerArea: lease.tiPerArea } : {},
        notes: lease.notes,
      });
      imported += 1;
    }

    if (body.saveMappingAs) {
      await request.db`
        INSERT INTO import_mapping_templates (organization_id, name, kind, mapping, created_by)
        VALUES (${context.organizationId}, ${body.saveMappingAs}, 'rent_roll',
                ${request.db.json(body.mapping as never)}, ${context.userId})
        ON CONFLICT (organization_id, name) DO UPDATE SET mapping = EXCLUDED.mapping
      `;
    }

    if (body.batchId) {
      await request.db`
        UPDATE import_batches
        SET status = 'imported', imported_count = ${imported}, completed_at = now()
        WHERE id = ${body.batchId} AND organization_id = ${context.organizationId}
      `;
    }

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'import.committed',
      entityType: 'import_batch',
      entityId: body.batchId ?? null,
      modelId: id,
      propertyId: model.property_id,
      metadata: { imported, skipped: result.leases.length - importable.length },
      ipAddress: request.ip,
    });

    return {
      imported,
      skipped: result.leases.length - importable.length,
      warnings: result.issues.filter((issue) => issue.severity === 'warning'),
    };
  });

  app.get('/models/:id/imports', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await request.db`
      SELECT id, kind, status, source_filename, header_row, mapping, row_count,
             imported_count, errors, warnings, created_at, completed_at
      FROM import_batches
      WHERE model_id = ${id} AND organization_id = ${context.organizationId}
      ORDER BY created_at DESC
      LIMIT 50
    `;
    return { batches: rows };
  });

  app.get('/import-mappings', async (request) => {
    const context = requireCapability(request, 'import:run');
    const rows = await request.db`
      SELECT id, name, kind, mapping, created_at FROM import_mapping_templates
      WHERE organization_id = ${context.organizationId}
      ORDER BY name
    `;
    return { templates: rows };
  });
}
