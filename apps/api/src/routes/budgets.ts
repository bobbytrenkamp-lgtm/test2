import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accountCategoryEnum, budgetPeriodKindEnum } from '@cre/domain-models';
import {
  approveBudgetPeriod,
  approveVarianceCommentary,
  budgetLinesFor,
  createBudgetPeriod,
  deleteBudgetPeriod,
  getBudgetPeriod,
  getLatestCalculation,
  listBudgetEntries,
  listBudgetPeriods,
  listVarianceCommentary,
  replaceBudgetEntries,
  upsertVarianceCommentary,
  writeAudit,
} from '@cre/database';
import { computeVariance, forecastToBudgetLines } from '@cre/calculation-engine';
import { analyzeActuals, mapActuals } from '@cre/reporting';
import { badRequest, forbidden, notFound, requireCapability } from '../context.js';

/**
 * Budgets, actuals and variance.
 *
 * A comparison always names both sides. Nothing here assumes one set of numbers
 * is "the" budget, because measuring a reforecast against the original budget
 * and against the approved budget are different questions with different
 * answers, and a report that quietly picks one is worse than useless in a board
 * pack.
 */
export async function registerBudgetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/budgets', async (request) => {
    const context = requireCapability(request, 'property:read');
    const query = z
      .object({
        propertyId: z.string().uuid().optional(),
        fiscalYear: z.coerce.number().int().min(1900).max(2200).optional(),
      })
      .parse(request.query);

    const periods = await listBudgetPeriods(request.db, context.organizationId, {
      propertyId: query.propertyId ?? null,
      fiscalYear: query.fiscalYear ?? null,
    });
    return { periods };
  });

  app.post('/budgets', async (request, reply) => {
    const context = requireCapability(request, 'budget:write');
    const body = z
      .object({
        propertyId: z.string().uuid(),
        modelId: z.string().uuid().nullish(),
        kind: budgetPeriodKindEnum,
        fiscalYear: z.number().int().min(1900).max(2200),
        label: z.string().min(1).max(200),
      })
      .parse(request.body);

    // Scoped by organization: a property in another tenant is not found rather
    // than forbidden, so the response cannot confirm the row exists.
    const owned = (await request.db`
      SELECT id FROM properties
      WHERE id = ${body.propertyId} AND organization_id = ${context.organizationId}
    `) as unknown as Array<{ id: string }>;
    if (owned.length === 0) throw notFound('That property does not exist.');

    const period = await createBudgetPeriod(request.db, context.organizationId, body);

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'budget.created',
      entityType: 'budget_period',
      entityId: period.id,
      propertyId: body.propertyId,
      newValue: { kind: body.kind, fiscalYear: body.fiscalYear, label: body.label },
    });

    return reply.status(201).send({ period });
  });

  app.get('/budgets/:id', async (request) => {
    const context = requireCapability(request, 'property:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const period = await getBudgetPeriod(request.db, context.organizationId, id);
    if (!period) throw notFound('That budget does not exist.');
    return { period, entries: await listBudgetEntries(request.db, id) };
  });

  app.delete('/budgets/:id', async (request, reply) => {
    const context = requireCapability(request, 'budget:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const period = await getBudgetPeriod(request.db, context.organizationId, id);
    if (!period) throw notFound('That budget does not exist.');
    if (period.approved_at) {
      throw badRequest(
        'An approved budget cannot be deleted. Create a revised budget instead, so the approved figures stay on the record.',
      );
    }

    await deleteBudgetPeriod(request.db, context.organizationId, id);
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'budget.deleted',
      entityType: 'budget_period',
      entityId: id,
      propertyId: period.property_id,
      previousValue: { kind: period.kind, label: period.label },
    });
    return reply.status(204).send();
  });

  /** Replaces a period's entries. A budget upload states the whole period. */
  app.put('/budgets/:id/entries', async (request) => {
    const context = requireCapability(request, 'budget:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        entries: z.array(
          z.object({
            accountCode: z.string().min(1).max(60),
            accountName: z.string().min(1).max(200),
            accountCategory: accountCategoryEnum.default('other'),
            periodMonth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            amount: z.string().regex(/^-?\d+(\.\d+)?$/),
            department: z.string().max(120).nullish(),
            commentary: z.string().max(4000).nullish(),
          }),
        ),
      })
      .parse(request.body);

    const period = await getBudgetPeriod(request.db, context.organizationId, id);
    if (!period) throw notFound('That budget does not exist.');
    if (period.approved_at) {
      throw badRequest(
        'This budget has been approved and its figures are frozen. Create a revised budget to change them.',
      );
    }

    const written = await replaceBudgetEntries(request.db, id, body.entries);
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'budget.entries_replaced',
      entityType: 'budget_period',
      entityId: id,
      propertyId: period.property_id,
      newValue: { entryCount: written },
    });
    return { written };
  });

  app.post('/budgets/:id/approve', async (request) => {
    const context = requireCapability(request, 'model:approve');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const approved = await approveBudgetPeriod(
      request.db,
      context.organizationId,
      id,
      context.userId,
    );
    if (!approved) {
      const existing = await getBudgetPeriod(request.db, context.organizationId, id);
      if (!existing) throw notFound('That budget does not exist.');
      throw badRequest('That budget has already been approved.');
    }

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'budget.approved',
      entityType: 'budget_period',
      entityId: id,
      propertyId: approved.property_id,
      newValue: { approvedAt: approved.approved_at },
    });
    return { period: approved };
  });

  /* ---------------------------------------------------------------------- */
  /* Actuals import                                                          */
  /* ---------------------------------------------------------------------- */

  app.post('/budgets/:id/import/analyze', async (request) => {
    requireCapability(request, 'import:run');
    const context = requireCapability(request, 'budget:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ content: z.string().min(1).max(8_000_000) }).parse(request.body);

    const period = await getBudgetPeriod(request.db, context.organizationId, id);
    if (!period) throw notFound('That budget does not exist.');

    // Parsing is local and deterministic. The file is never sent anywhere.
    return { analysis: analyzeActuals(body.content) };
  });

  app.post('/budgets/:id/import/commit', async (request) => {
    requireCapability(request, 'import:run');
    const context = requireCapability(request, 'budget:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        content: z.string().min(1).max(8_000_000),
        expenseSign: z.enum(['positive', 'negative']).default('positive'),
        defaultCategory: accountCategoryEnum.default('other'),
        categoryByPrefix: z.record(accountCategoryEnum).default({}),
        dryRun: z.boolean().default(false),
      })
      .parse(request.body);

    const period = await getBudgetPeriod(request.db, context.organizationId, id);
    if (!period) throw notFound('That budget does not exist.');
    if (period.approved_at) {
      throw badRequest(
        'This budget has been approved and its figures are frozen. Create a revised budget to load new figures.',
      );
    }

    const analysis = analyzeActuals(body.content);
    const mapped = mapActuals(body.content, analysis, {
      expenseSign: body.expenseSign,
      defaultCategory: body.defaultCategory,
      categoryByPrefix: body.categoryByPrefix,
    });

    // The caller sees exactly what would be written before anything is.
    if (body.dryRun) {
      return {
        analysis,
        issues: mapped.issues,
        months: mapped.months,
        wouldWrite: mapped.entries.length,
        preview: mapped.entries.slice(0, 50),
      };
    }

    const written = await replaceBudgetEntries(request.db, id, mapped.entries);
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'budget.actuals_imported',
      entityType: 'budget_period',
      entityId: id,
      propertyId: period.property_id,
      newValue: {
        entryCount: written,
        months: mapped.months,
        errorCount: mapped.issues.filter((issue) => issue.severity === 'error').length,
      },
    });

    return { written, issues: mapped.issues, months: mapped.months };
  });

  /* ---------------------------------------------------------------------- */
  /* Variance                                                                */
  /* ---------------------------------------------------------------------- */

  app.get('/variance', async (request) => {
    const context = requireCapability(request, 'report:read');
    const query = z
      .object({
        baseId: z.string().uuid(),
        /** Omit to compare against a model's forecast instead. */
        comparisonId: z.string().uuid().optional(),
        comparisonModelId: z.string().uuid().optional(),
        fromMonth: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        toMonth: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        materialityAmount: z.string().optional(),
        materialityPercent: z.string().optional(),
      })
      .parse(request.query);

    if (!query.comparisonId && !query.comparisonModelId) {
      throw badRequest(
        'A comparison must be named: either another budget period (comparisonId) or a model whose forecast to compare against (comparisonModelId).',
      );
    }

    const base = await getBudgetPeriod(request.db, context.organizationId, query.baseId);
    if (!base) throw notFound('That budget does not exist.');
    const baseLines = await budgetLinesFor(request.db, query.baseId);

    let comparisonLines;
    let comparisonLabel: string;

    if (query.comparisonId) {
      const comparison = await getBudgetPeriod(
        request.db,
        context.organizationId,
        query.comparisonId,
      );
      if (!comparison) throw notFound('That comparison budget does not exist.');
      if (comparison.property_id !== base.property_id) {
        throw badRequest(
          'Both sides of a variance must belong to the same property. Comparing two different assets produces a number with no meaning.',
        );
      }
      comparisonLines = await budgetLinesFor(request.db, query.comparisonId);
      comparisonLabel = `${comparison.kind} ${comparison.fiscal_year} — ${comparison.label}`;
    } else {
      const modelId = query.comparisonModelId as string;
      const latest = await getLatestCalculation(request.db, modelId);
      if (!latest) {
        throw badRequest(
          'That model has not been calculated, so there is no forecast to compare against. Calculate it first.',
        );
      }
      const result = latest.result;
      comparisonLines = forecastToBudgetLines({
        monthly: result.monthly as unknown as Record<string, string[]>,
        monthStarts: result.periods.map((period) => period.startDate),
      });
      comparisonLabel = `Forecast, engine ${result.engineVersion}`;
    }

    const report = computeVariance(baseLines, comparisonLines, {
      fromMonth: query.fromMonth ?? null,
      toMonth: query.toMonth ?? null,
      materialityAmount: query.materialityAmount ?? null,
      materialityPercent: query.materialityPercent ?? null,
    });

    return {
      base: { id: base.id, label: `${base.kind} ${base.fiscal_year} — ${base.label}` },
      comparison: { label: comparisonLabel },
      report,
    };
  });

  /* ---------------------------------------------------------------------- */
  /* Commentary                                                              */
  /* ---------------------------------------------------------------------- */

  app.get('/variance/commentary', async (request) => {
    const context = requireCapability(request, 'report:read');
    const query = z
      .object({
        propertyId: z.string().uuid(),
        fiscalYear: z.coerce.number().int().min(1900).max(2200),
      })
      .parse(request.query);

    const commentary = await listVarianceCommentary(
      request.db,
      context.organizationId,
      query.propertyId,
      query.fiscalYear,
    );
    return { commentary };
  });

  app.put('/variance/commentary', async (request) => {
    const context = requireCapability(request, 'comment:write');
    const body = z
      .object({
        propertyId: z.string().uuid(),
        fiscalYear: z.number().int().min(1900).max(2200),
        periodMonth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        accountCode: z.string().min(1).max(60),
        commentary: z.string().min(1).max(4000),
      })
      .parse(request.body);

    const owned = (await request.db`
      SELECT id FROM properties
      WHERE id = ${body.propertyId} AND organization_id = ${context.organizationId}
    `) as unknown as Array<{ id: string }>;
    if (owned.length === 0) throw notFound('That property does not exist.');

    const row = await upsertVarianceCommentary(request.db, {
      ...body,
      authorId: context.userId,
    });

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'variance.commentary_written',
      entityType: 'variance_commentary',
      entityId: row.id,
      propertyId: body.propertyId,
      newValue: { accountCode: body.accountCode, periodMonth: body.periodMonth },
    });
    return { commentary: row };
  });

  app.post('/variance/commentary/:id/approve', async (request) => {
    const context = requireCapability(request, 'model:approve');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const { row, refusedSelfApproval } = await approveVarianceCommentary(
      request.db,
      context.organizationId,
      id,
      context.userId,
    );
    if (refusedSelfApproval) {
      throw forbidden(
        'Commentary cannot be approved by the person who wrote it. The point of the step is that someone else agreed to the explanation.',
      );
    }
    if (!row) throw notFound('That commentary does not exist.');

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'variance.commentary_approved',
      entityType: 'variance_commentary',
      entityId: id,
      propertyId: row.property_id,
      newValue: { approvedText: row.approved_text },
    });
    return { commentary: row };
  });
}
