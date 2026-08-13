import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteGrowthCurveTemplate,
  listGrowthCurveTemplates,
  upsertGrowthCurveTemplate,
} from '@cre/database';
import { decimalString } from '@cre/domain-models';
import { badRequest, forbidden, notFound, requireCapability } from '../context.js';

/**
 * The organization's growth curve library.
 *
 * A growth curve (`packages/database/migrations/0003`) has always been
 * model-scoped: every model that wants the same inflation or market-rent
 * path re-enters the same `byYear` overrides by hand, with no way to keep
 * them in step across a portfolio. This is Argus's "Global Value File"
 * concept for a reusable rate assumption — one named entry per organization
 * that any model can start a curve from.
 *
 * Applying a template is deliberately not a live reference: a model's own
 * `PUT /models/:id/growth-curves/:code` (already gated on `model:write` and
 * per-row optimistic locking) is what actually writes the curve, seeded from
 * a template's current values on the client. A model's curve never re-reads
 * the template afterward — editing the library entry later does not
 * retroactively change a model that already applied it, the same way every
 * other assumption here is a value the model owns once written, not a
 * pointer to one.
 *
 * Gated on `model:write`, the same capability that already manages a
 * model's own growth curves: this is assumption content an analyst
 * maintains, not organization administration.
 */
export async function registerGrowthCurveTemplateRoutes(app: FastifyInstance): Promise<void> {
  const orgParam = z.object({ id: z.string().uuid() });
  const templateParams = z.object({
    id: z.string().uuid(),
    code: z.string().min(1).max(60),
  });

  const byYearSchema = z
    .array(z.object({ year: z.number().int().min(1), rate: decimalString }))
    .default([]);

  function checkDuplicateYears(byYear: Array<{ year: number; rate: string }>): void {
    const seen = new Set<number>();
    for (const entry of byYear) {
      if (seen.has(entry.year)) {
        throw badRequest(
          `More than one rate override is given for year ${entry.year}. ` +
            'Remove the duplicate before saving.',
        );
      }
      seen.add(entry.year);
    }
  }

  app.get('/organizations/:id/growth-curve-templates', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id } = orgParam.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only read the growth curve library of the organization you are signed in to.',
      );
    }
    return { templates: await listGrowthCurveTemplates(request.db, id) };
  });

  app.put('/organizations/:id/growth-curve-templates/:code', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id, code } = templateParams.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only edit the growth curve library of the organization you are signed in to.',
      );
    }
    const body = z
      .object({
        name: z.string().min(1).max(200),
        defaultRate: decimalString,
        byYear: byYearSchema,
      })
      .parse(request.body);
    checkDuplicateYears(body.byYear);

    const template = await upsertGrowthCurveTemplate(request.db, {
      organizationId: id,
      code,
      name: body.name,
      defaultRate: body.defaultRate,
      byYear: body.byYear,
      createdBy: context.userId,
    });
    return { template };
  });

  app.delete('/organizations/:id/growth-curve-templates/:code', async (request) => {
    const context = requireCapability(request, 'model:write');
    const { id, code } = templateParams.parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden(
        'You can only edit the growth curve library of the organization you are signed in to.',
      );
    }
    const deleted = await deleteGrowthCurveTemplate(request.db, id, code);
    if (!deleted) throw notFound(`No growth curve template "${code}" exists.`);
    return { ok: true };
  });
}
