import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteMarketLeasingProfileTemplate,
  listMarketLeasingProfileTemplates,
  upsertMarketLeasingProfileTemplate,
} from '@cre/database';
import {
  decimalString,
  escalationSchema,
  recoveryConfigSchema,
  rentBasisEnum,
} from '@cre/domain-models';
import { forbidden, notFound, requireCapability } from '../context.js';

/**
 * The organization's market leasing profile library.
 *
 * Second reusable assumption family after growth curves
 * (`growth-curve-templates.ts`) — same reasoning, same shape. A market
 * leasing profile (`packages/database/migrations/0003`) has always been
 * model-scoped, so a firm's standard renewal probability, downtime, TI and
 * LC assumptions get re-typed by hand into every new acquisition.
 *
 * Applying a template is not a live reference, for the same reason
 * `growth-curve-templates.ts` isn't one: the model's own
 * `PUT /models/:id/market-leasing/:code` (already gated on `model:write`
 * and per-row optimistic locking) is what actually writes the profile,
 * seeded from a template's current values on the client, and the model owns
 * its own copy from that point. `source_template_code`/`source_template_name`
 * on `market_leasing_profiles` (migration 0022) record which template a
 * profile started from — a snapshot, not a pointer, so a later change to
 * the library entry never reaches back into a model that already applied
 * it.
 *
 * Gated on `model:write`, the same capability that already manages a
 * model's own market leasing assumptions.
 */
export async function registerMarketLeasingProfileTemplateRoutes(
  app: FastifyInstance,
): Promise<void> {
  const orgParam = z.object({ id: z.string().uuid() });
  const templateParams = z.object({
    id: z.string().uuid(),
    code: z.string().min(1).max(60),
  });

  const bodySchema = z.object({
    name: z.string().min(1).max(200),
    marketRent: decimalString,
    marketRentBasis: rentBasisEnum.optional(),
    marketRentGrowthCurve: z.string().nullish(),
    renewalProbability: decimalString.optional(),
    renewalTermMonths: z.number().int().min(1).optional(),
    newLeaseTermMonths: z.number().int().min(1).optional(),
    downtimeMonths: z.number().min(0).optional(),
    renewalFreeRentMonths: z.number().min(0).optional(),
    newFreeRentMonths: z.number().min(0).optional(),
    renewalTiPerArea: decimalString.optional(),
    newTiPerArea: decimalString.optional(),
    renewalLcPercent: decimalString.optional(),
    newLcPercent: decimalString.optional(),
    renewalEscalation: escalationSchema.optional(),
    newEscalation: escalationSchema.optional(),
    recovery: recoveryConfigSchema.optional(),
    precedence: z.number().int().optional(),
  });

  app.get('/organizations/:id/market-leasing-profile-templates', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id } = orgParam.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only read the market leasing profile library of the organization you are signed in to.',
      );
    }
    return { templates: await listMarketLeasingProfileTemplates(request.db, id) };
  });

  app.put('/organizations/:id/market-leasing-profile-templates/:code', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id, code } = templateParams.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only edit the market leasing profile library of the organization you are signed in to.',
      );
    }
    const body = bodySchema.parse(request.body);

    const template = await upsertMarketLeasingProfileTemplate(request.db, {
      organizationId: id,
      code,
      name: body.name,
      marketRent: body.marketRent,
      marketRentBasis: body.marketRentBasis,
      marketRentGrowthCurve: body.marketRentGrowthCurve,
      renewalProbability: body.renewalProbability,
      renewalTermMonths: body.renewalTermMonths,
      newLeaseTermMonths: body.newLeaseTermMonths,
      downtimeMonths: body.downtimeMonths,
      renewalFreeRentMonths: body.renewalFreeRentMonths,
      newFreeRentMonths: body.newFreeRentMonths,
      renewalTiPerArea: body.renewalTiPerArea,
      newTiPerArea: body.newTiPerArea,
      renewalLcPercent: body.renewalLcPercent,
      newLcPercent: body.newLcPercent,
      renewalEscalation: body.renewalEscalation,
      newEscalation: body.newEscalation,
      recovery: body.recovery,
      precedence: body.precedence,
      createdBy: context.userId,
    });
    return { template };
  });

  app.delete('/organizations/:id/market-leasing-profile-templates/:code', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id, code } = templateParams.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only edit the market leasing profile library of the organization you are signed in to.',
      );
    }
    const deleted = await deleteMarketLeasingProfileTemplate(request.db, id, code);
    if (!deleted) throw notFound(`No market leasing profile template "${code}" exists.`);
    return { ok: true };
  });
}
