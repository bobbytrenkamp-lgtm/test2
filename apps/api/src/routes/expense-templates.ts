import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteOperatingExpenseTemplate,
  listOperatingExpenseTemplates,
  upsertOperatingExpenseTemplate,
} from '@cre/database';
import { decimalString, expenseMethodEnum } from '@cre/domain-models';
import { forbidden, notFound, requireCapability } from '../context.js';

/**
 * The organization's operating expense library.
 *
 * Third reusable assumption family after growth curves
 * (`growth-curve-templates.ts`) and market leasing profiles
 * (`market-leasing-profile-templates.ts`) — same reasoning, same shape. An
 * operating expense (`packages/database/migrations/0003`) has always been
 * model-scoped, so a firm's normal tax, insurance, utilities, management
 * fee, repairs, payroll and CAM structures get re-typed by hand into every
 * new acquisition.
 *
 * Applying a template is not a live reference, for the same reason
 * `market-leasing-profile-templates.ts` isn't one: the model's own
 * `PUT /models/:id/expenses/:code` (already gated on `model:write` and
 * per-row optimistic locking) is what actually writes the expense, seeded
 * from a template's current values on the client, and the model owns its
 * own copy from that point. `source_template_code`/`source_template_name`
 * on `operating_expenses` (migration 0023) record which template an expense
 * started from — a snapshot, not a pointer, so a later change to the
 * library entry never reaches back into a model that already applied it.
 *
 * Gated on `model:write`, the same capability that already manages a
 * model's own operating expenses.
 */
export async function registerOperatingExpenseTemplateRoutes(app: FastifyInstance): Promise<void> {
  const orgParam = z.object({ id: z.string().uuid() });
  const templateParams = z.object({
    id: z.string().uuid(),
    code: z.string().min(1).max(60),
  });

  const bodySchema = z.object({
    name: z.string().min(1).max(200),
    category: z.string().min(1).max(60).optional(),
    accountCode: z.string().max(60).nullish(),
    method: expenseMethodEnum.optional(),
    amount: decimalString.optional(),
    growthCurve: z.string().nullish(),
    recoverableShare: decimalString.optional(),
    variableShare: decimalString.optional(),
    monthlySchedule: z.array(decimalString).optional(),
    isCapitalized: z.boolean().optional(),
  });

  app.get('/organizations/:id/operating-expense-templates', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id } = orgParam.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only read the operating expense library of the organization you are signed in to.',
      );
    }
    return { templates: await listOperatingExpenseTemplates(request.db, id) };
  });

  app.put('/organizations/:id/operating-expense-templates/:code', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id, code } = templateParams.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only edit the operating expense library of the organization you are signed in to.',
      );
    }
    const body = bodySchema.parse(request.body);

    const template = await upsertOperatingExpenseTemplate(request.db, {
      organizationId: id,
      code,
      name: body.name,
      category: body.category,
      accountCode: body.accountCode,
      method: body.method,
      amount: body.amount,
      growthCurve: body.growthCurve,
      recoverableShare: body.recoverableShare,
      variableShare: body.variableShare,
      monthlySchedule: body.monthlySchedule,
      isCapitalized: body.isCapitalized,
      createdBy: context.userId,
    });
    return { template };
  });

  app.delete('/organizations/:id/operating-expense-templates/:code', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id, code } = templateParams.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only edit the operating expense library of the organization you are signed in to.',
      );
    }
    const deleted = await deleteOperatingExpenseTemplate(request.db, id, code);
    if (!deleted) throw notFound(`No operating expense template "${code}" exists.`);
    return { ok: true };
  });
}
