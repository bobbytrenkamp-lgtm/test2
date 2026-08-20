import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createProperty, writeAudit, type Sql } from '@cre/database';
import { requireCapability } from '../context.js';
import { propertyBody } from './properties.js';
import { insertModel, modelAssumptions } from './models.js';

/**
 * "New Underwriting": creates a property and its first model together, in
 * one request, so starting a real acquisition underwrite is one guided step
 * rather than two separate screens (create the property, then navigate to
 * it and create a model) with nothing in between routing the analyst
 * forward.
 *
 * Deliberately not a new resource or a new authorization model: this is the
 * exact same `createProperty` repository call and `insertModel` helper
 * `POST /properties` and `POST /models` already use (`propertyBody`,
 * `modelAssumptions` and `insertModel` are imported from those route files
 * rather than redefined), wrapped in one transaction so a failure partway
 * through never leaves an orphaned property with no model. Both capabilities are checked
 * because, unlike the two routes above, one request now does the work of
 * both — every role that has ever been able to reach either already carries
 * both together (`packages/domain-models/src/permissions.ts`), so this adds
 * a real check, not a new gate nobody can pass.
 */
export async function registerUnderwritingRoutes(app: FastifyInstance): Promise<void> {
  const bodySchema = z.object({
    property: propertyBody,
    model: modelAssumptions,
  });

  app.post('/underwriting', async (request, reply) => {
    requireCapability(request, 'property:write');
    const context = requireCapability(request, 'model:write');
    const body = bodySchema.parse(request.body);

    const { property, model } = await request.db.begin(async (tx) => {
      const property = await createProperty(tx as unknown as Sql, {
        ...body.property,
        organizationId: context.organizationId,
        createdBy: context.userId,
      });

      const model = await insertModel(tx as unknown as Sql, {
        organizationId: context.organizationId,
        propertyId: property.id,
        createdBy: context.userId,
        body: body.model,
      });

      return { property, model };
    });

    // Written after the transaction commits, matching every other atomic
    // route in this codebase (portfolios.ts, budgets.ts) — an audit entry
    // for a write that then rolled back would be a record of something
    // that never happened.
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
    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'model.created',
      entityType: 'model',
      entityId: model.id as string,
      propertyId: property.id,
      modelId: model.id as string,
      newValue: { name: body.model.name, classification: body.model.classification },
      ipAddress: request.ip,
    });

    return reply.status(201).send({ property, model });
  });
}
