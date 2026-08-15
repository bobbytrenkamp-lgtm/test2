import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteDebtFacilityTemplate,
  listDebtFacilityTemplates,
  upsertDebtFacilityTemplate,
} from '@cre/database';
import { debtTypeEnum, decimalString, isoDate } from '@cre/domain-models';
import { forbidden, notFound, requireCapability } from '../context.js';

/**
 * The organization's debt facility library.
 *
 * Fourth reusable assumption family after growth curves
 * (`growth-curve-templates.ts`), market leasing profiles
 * (`market-leasing-profile-templates.ts`) and operating expenses
 * (`expense-templates.ts`) — same reasoning, same shape, with one
 * difference worth stating plainly: a debt facility mixes genuinely
 * reusable structure (rate type, fees, covenants, amortisation shape) with
 * fields that are inherently deal-specific — commitment, funding date, term
 * — because the model-level schema requires all three and a template
 * cannot seed a row without them. The template still earns its keep on the
 * other fifteen-odd fields; see migration 0024's own comment.
 *
 * Applying a template is not a live reference, for the same reason none of
 * the other three are: the model's own `PUT /models/:id/debt/:code`
 * (already gated on `model:write` and per-row optimistic locking) is what
 * actually writes the facility, seeded from a template's current values on
 * the client, and the model owns its own copy from that point.
 * `source_template_code`/`source_template_name` on `debt_facilities`
 * (migration 0024) record which template a facility started from — a
 * snapshot, not a pointer.
 *
 * Gated on `model:write`, the same capability that already manages a
 * model's own debt facilities.
 */
export async function registerDebtFacilityTemplateRoutes(app: FastifyInstance): Promise<void> {
  const orgParam = z.object({ id: z.string().uuid() });
  const templateParams = z.object({
    id: z.string().uuid(),
    code: z.string().min(1).max(60),
  });

  const bodySchema = z.object({
    name: z.string().min(1).max(200),
    type: debtTypeEnum.optional(),
    commitment: decimalString.optional(),
    initialFunding: decimalString.optional(),
    fundingDate: isoDate.optional(),
    draws: z.array(z.unknown()).optional(),
    rateType: z.enum(['fixed', 'floating']).optional(),
    fixedRate: decimalString.optional(),
    indexCurve: z.string().nullish(),
    spread: decimalString.optional(),
    rateFloor: decimalString.nullish(),
    rateCap: decimalString.nullish(),
    interestOnlyMonths: z.number().int().min(0).optional(),
    amortizationMonths: z.number().int().min(0).optional(),
    termMonths: z.number().int().min(1).optional(),
    originationFeePercent: decimalString.optional(),
    exitFeePercent: decimalString.optional(),
    unusedFeePercent: decimalString.optional(),
    capitalizeInterest: z.boolean().optional(),
    minimumDscr: decimalString.nullish(),
    maximumLtv: decimalString.nullish(),
    maximumLtc: decimalString.nullish(),
    minimumDebtYield: decimalString.nullish(),
    repayOnSale: z.boolean().optional(),
  });

  app.get('/organizations/:id/debt-facility-templates', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id } = orgParam.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only read the debt facility library of the organization you are signed in to.',
      );
    }
    return { templates: await listDebtFacilityTemplates(request.db, id) };
  });

  app.put('/organizations/:id/debt-facility-templates/:code', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id, code } = templateParams.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only edit the debt facility library of the organization you are signed in to.',
      );
    }
    const body = bodySchema.parse(request.body);

    const template = await upsertDebtFacilityTemplate(request.db, {
      organizationId: id,
      code,
      name: body.name,
      type: body.type,
      commitment: body.commitment,
      initialFunding: body.initialFunding,
      fundingDate: body.fundingDate,
      draws: body.draws,
      rateType: body.rateType,
      fixedRate: body.fixedRate,
      indexCurve: body.indexCurve,
      spread: body.spread,
      rateFloor: body.rateFloor,
      rateCap: body.rateCap,
      interestOnlyMonths: body.interestOnlyMonths,
      amortizationMonths: body.amortizationMonths,
      termMonths: body.termMonths,
      originationFeePercent: body.originationFeePercent,
      exitFeePercent: body.exitFeePercent,
      unusedFeePercent: body.unusedFeePercent,
      capitalizeInterest: body.capitalizeInterest,
      minimumDscr: body.minimumDscr,
      maximumLtv: body.maximumLtv,
      maximumLtc: body.maximumLtc,
      minimumDebtYield: body.minimumDebtYield,
      repayOnSale: body.repayOnSale,
      createdBy: context.userId,
    });
    return { template };
  });

  app.delete('/organizations/:id/debt-facility-templates/:code', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id, code } = templateParams.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only edit the debt facility library of the organization you are signed in to.',
      );
    }
    const deleted = await deleteDebtFacilityTemplate(request.db, id, code);
    if (!deleted) throw notFound(`No debt facility template "${code}" exists.`);
    return { ok: true };
  });
}
