import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createProperty,
  createTenant,
  deleteSpace,
  getLatestCalculation,
  getProperty,
  listModels,
  listProperties,
  listSpaces,
  listTenants,
  softDeleteProperty,
  updateProperty,
  upsertSpace,
  writeAudit,
} from '@cre/database';
import { decimalString, propertyTypeEnum } from '@cre/domain-models';
import { notFound, requireCapability } from '../context.js';
import { extractMetric } from './calculations.js';

/**
 * Exported for `underwriting.ts`'s atomic "create a property and a model
 * together" route, which validates its `property` field with this exact
 * schema rather than redefining a subset of it.
 */
export const propertyBody = z.object({
  name: z.string().min(1).max(200),
  propertyType: propertyTypeEnum,
  propertySubtype: z.string().max(100).nullish(),
  addressLine1: z.string().max(300).nullish(),
  city: z.string().max(120).nullish(),
  stateRegion: z.string().max(120).nullish(),
  postalCode: z.string().max(20).nullish(),
  country: z.string().length(2).default('US'),
  market: z.string().max(120).nullish(),
  submarket: z.string().max(120).nullish(),
  currency: z.string().length(3).default('USD'),
  areaUnit: z.enum(['sqft', 'sqm']).default('sqft'),
  yearBuilt: z.number().int().min(1500).max(2200).nullish(),
  rentableArea: decimalString.nullish(),
  grossBuildingArea: decimalString.nullish(),
  landArea: decimalString.nullish(),
  unitCount: z.number().int().min(0).default(0),
  parkingCount: z.number().int().min(0).default(0),
  buildingCount: z.number().int().min(1).default(1),
  ownershipPercent: decimalString.default('1'),
  acquisitionDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  acquisitionPrice: decimalString.nullish(),
  tags: z.array(z.string().max(60)).default([]),
});

export async function registerPropertyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/properties', async (request) => {
    const context = requireCapability(request, 'property:read');
    const query = z
      .object({
        search: z.string().max(200).optional(),
        propertyType: z.string().max(60).optional(),
        market: z.string().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const result = await listProperties(request.db, context.organizationId, query);
    return {
      properties: result.rows,
      total: result.total,
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.post('/properties', async (request, reply) => {
    const context = requireCapability(request, 'property:write');
    const body = propertyBody.parse(request.body);
    const property = await createProperty(request.db, {
      ...body,
      organizationId: context.organizationId,
      createdBy: context.userId,
    });
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'property.created',
      entityType: 'property',
      entityId: property.id,
      propertyId: property.id,
      newValue: { name: property.name, propertyType: property.property_type },
      ipAddress: request.ip,
    });
    return reply.status(201).send({ property });
  });

  app.get('/properties/:id', async (request) => {
    const context = requireCapability(request, 'property:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const property = await getProperty(request.db, context.organizationId, id);
    if (!property) throw notFound('That property does not exist in this organization.');
    const spaces = await listSpaces(request.db, id);
    return { property, spaces };
  });

  app.patch('/properties/:id', async (request) => {
    const context = requireCapability(request, 'property:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const before = await getProperty(request.db, context.organizationId, id);
    if (!before) throw notFound('That property does not exist in this organization.');

    const body = propertyBody.partial().parse(request.body);
    const property = await updateProperty(request.db, context.organizationId, id, body);
    if (!property) throw notFound();

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'property.updated',
      entityType: 'property',
      entityId: id,
      propertyId: id,
      previousValue: changedFields(before as unknown as Record<string, unknown>, body),
      newValue: body,
      ipAddress: request.ip,
    });
    return { property };
  });

  app.delete('/properties/:id', async (request) => {
    const context = requireCapability(request, 'property:delete');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const ok = await softDeleteProperty(request.db, context.organizationId, id);
    if (!ok) throw notFound();
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'property.deleted',
      entityType: 'property',
      entityId: id,
      propertyId: id,
      ipAddress: request.ip,
    });
    return { ok: true };
  });

  /* ---------------------------------------------------------------------- */
  /* Spaces                                                                 */
  /* ---------------------------------------------------------------------- */

  app.get('/properties/:id/spaces', async (request) => {
    const context = requireCapability(request, 'property:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const property = await getProperty(request.db, context.organizationId, id);
    if (!property) throw notFound();
    return { spaces: await listSpaces(request.db, id) };
  });

  /* ---------------------------------------------------------------------- */
  /* Scenario comparison                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Every model on this property, side by side by what it calculated to —
   * the decision-oriented table a Base/Upside/Downside set of scenarios
   * never had. `ScenariosTab`'s clone button and sensitivity grid already
   * make it cheap to build the siblings; nothing before this route could
   * actually compare what they came out to without opening each one in
   * turn.
   *
   * Read-only, and nothing here is recomputed: each model's own latest
   * *succeeded* `calculation_runs` row is read exactly as stored
   * (`getLatestCalculation`), through the same `extractMetric` switch the
   * sensitivity grid already uses, so this table can never disagree with
   * what that model's own Cash flow and Returns tabs show. A model with no
   * succeeded run yet is still listed — silently omitting it would read as
   * "this scenario doesn't exist" rather than "this scenario hasn't been
   * run" — with every metric null and `calculated: false` so the client can
   * say so rather than guess from a blank cell.
   */
  app.get('/properties/:id/scenario-comparison', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const property = await getProperty(request.db, context.organizationId, id);
    if (!property) throw notFound();

    const models = await listModels(request.db, context.organizationId, id);

    const scenarios = await Promise.all(
      models.map(async (model) => {
        const latest = await getLatestCalculation(request.db, model.id);
        return {
          modelId: model.id,
          modelName: model.name,
          classification: model.classification,
          status: model.status,
          currency: model.currency,
          calculated: latest !== null,
          engineVersion: latest?.run.engine_version ?? null,
          calculatedAt: latest?.run.completed_at ?? null,
          dcfValue: latest ? extractMetric(latest.result, 'dcfValue') : null,
          unleveredIrr: latest ? extractMetric(latest.result, 'unleveredIrr') : null,
          leveredIrr: latest ? extractMetric(latest.result, 'leveredIrr') : null,
          equityMultiple: latest ? extractMetric(latest.result, 'equityMultiple') : null,
          year1Noi: latest ? extractMetric(latest.result, 'year1Noi') : null,
        };
      }),
    );

    return { property, scenarios };
  });

  app.put('/properties/:id/spaces', async (request) => {
    const context = requireCapability(request, 'property:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const property = await getProperty(request.db, context.organizationId, id);
    if (!property) throw notFound();

    const body = z
      .object({
        spaces: z.array(
          z.object({
            code: z.string().min(1).max(60),
            floor: z.string().max(30).nullish(),
            spaceType: z.string().max(60).default('office'),
            area: decimalString,
            unitCount: z.number().int().min(0).default(0),
            isNonRevenue: z.boolean().default(false),
            sortOrder: z.number().int().default(0),
          }),
        ),
      })
      .parse(request.body);

    const saved = [];
    for (const space of body.spaces) {
      saved.push(await upsertSpace(request.db, { ...space, propertyId: id }));
    }
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'property.spaces_updated',
      entityType: 'property',
      entityId: id,
      propertyId: id,
      newValue: { count: saved.length },
      ipAddress: request.ip,
    });
    return { spaces: saved };
  });

  app.delete('/properties/:id/spaces/:spaceId', async (request) => {
    const context = requireCapability(request, 'property:write');
    const params = z
      .object({ id: z.string().uuid(), spaceId: z.string().uuid() })
      .parse(request.params);
    const property = await getProperty(request.db, context.organizationId, params.id);
    if (!property) throw notFound();
    const ok = await deleteSpace(request.db, params.id, params.spaceId);
    if (!ok) throw notFound('That space does not exist on this property.');
    return { ok: true };
  });

  /* ---------------------------------------------------------------------- */
  /* Tenants                                                                */
  /* ---------------------------------------------------------------------- */

  app.get('/tenants', async (request) => {
    const context = requireCapability(request, 'property:read');
    const query = z.object({ propertyId: z.string().uuid().optional() }).parse(request.query);
    return { tenants: await listTenants(request.db, context.organizationId, query.propertyId) };
  });

  app.post('/tenants', async (request, reply) => {
    const context = requireCapability(request, 'property:write');
    const body = z
      .object({
        propertyId: z.string().uuid().nullish(),
        name: z.string().min(1).max(200),
        parentCompany: z.string().max(200).nullish(),
        industry: z.string().max(120).nullish(),
        creditRating: z.string().max(30).nullish(),
        isAnchor: z.boolean().default(false),
      })
      .parse(request.body);

    if (body.propertyId) {
      const property = await getProperty(request.db, context.organizationId, body.propertyId);
      if (!property) throw notFound('That property does not exist in this organization.');
    }

    const tenant = await createTenant(request.db, {
      ...body,
      organizationId: context.organizationId,
    });
    return reply.status(201).send({ tenant });
  });
}

/** Captures only the fields a patch touched, so the audit entry stays small. */
function changedFields(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    const column = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (column in before) out[key] = before[column];
  }
  return out;
}
