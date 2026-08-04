import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getLatestCalculation, writeAudit } from '@cre/database';
import { aggregatePortfolio, type PortfolioMember } from '@cre/calculation-engine';
import { badRequest, notFound, requireCapability } from '../context.js';

export async function registerPortfolioRoutes(app: FastifyInstance): Promise<void> {
  app.get('/portfolios', async (request) => {
    const context = requireCapability(request, 'portfolio:read');
    const rows = await request.db`
      SELECT p.id, p.name, p.description, p.strategy, p.is_dynamic, p.filter_definition,
             p.created_at,
             (SELECT count(*)::int FROM portfolio_properties pp WHERE pp.portfolio_id = p.id) AS property_count
      FROM portfolios p
      WHERE p.organization_id = ${context.organizationId} AND p.deleted_at IS NULL
      ORDER BY p.name
    `;
    return { portfolios: rows };
  });

  app.post('/portfolios', async (request, reply) => {
    const context = requireCapability(request, 'portfolio:write');
    const body = z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).nullish(),
        strategy: z.string().max(120).nullish(),
        isDynamic: z.boolean().default(false),
        filterDefinition: z.record(z.unknown()).default({}),
        propertyIds: z.array(z.string().uuid()).default([]),
      })
      .parse(request.body);

    const portfolio = (await request.db.begin(async (tx) => {
      const rows = (await tx`
        INSERT INTO portfolios (organization_id, name, description, strategy, is_dynamic, filter_definition)
        VALUES (${context.organizationId}, ${body.name}, ${body.description ?? null},
                ${body.strategy ?? null}, ${body.isDynamic}, ${tx.json(body.filterDefinition as never)})
        RETURNING *
      `) as unknown as Array<Record<string, unknown>>;
      const created = rows[0] as Record<string, unknown>;
      for (const propertyId of body.propertyIds) {
        await tx`
          INSERT INTO portfolio_properties (portfolio_id, property_id, ownership_percent)
          SELECT ${created.id as string}, p.id, p.ownership_percent
          FROM properties p
          WHERE p.id = ${propertyId} AND p.organization_id = ${context.organizationId}
          ON CONFLICT DO NOTHING
        `;
      }
      return created;
    })) as Record<string, unknown>;

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'portfolio.created',
      entityType: 'portfolio',
      entityId: portfolio.id as string,
      newValue: { name: body.name },
      ipAddress: request.ip,
    });
    return reply.status(201).send({ portfolio });
  });

  /**
   * Portfolio roll-up.
   *
   * Members are resolved either from the explicit property list or, for a
   * dynamic portfolio, from its saved filter. Each member contributes its
   * latest stored calculation; a property that has never been calculated is
   * reported as excluded rather than silently counted as zero, because a
   * missing asset would quietly understate every portfolio total.
   */
  app.get('/portfolios/:id/aggregate', async (request) => {
    const context = requireCapability(request, 'portfolio:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z
      .object({ modelClassification: z.string().max(60).optional() })
      .parse(request.query);

    const portfolioRows = (await request.db`
      SELECT * FROM portfolios
      WHERE id = ${id} AND organization_id = ${context.organizationId} AND deleted_at IS NULL
    `) as unknown as Array<Record<string, unknown>>;
    const portfolio = portfolioRows[0];
    if (!portfolio) throw notFound('That portfolio does not exist in this organization.');

    const filter = (portfolio.filter_definition ?? {}) as {
      propertyTypes?: string[];
      markets?: string[];
      tags?: string[];
    };

    const properties = portfolio.is_dynamic
      ? ((await request.db`
          SELECT p.id, p.name, p.property_type, p.market, p.rentable_area, p.unit_count,
                 p.ownership_percent
          FROM properties p
          WHERE p.organization_id = ${context.organizationId} AND p.deleted_at IS NULL
            AND (${filter.propertyTypes ?? null}::text[] IS NULL
                 OR p.property_type = ANY(${filter.propertyTypes ?? null}::text[]))
            AND (${filter.markets ?? null}::text[] IS NULL
                 OR p.market = ANY(${filter.markets ?? null}::text[]))
            AND (${filter.tags ?? null}::text[] IS NULL OR p.tags && ${filter.tags ?? null}::text[])
          ORDER BY p.name
        `) as unknown as Array<Record<string, unknown>>)
      : ((await request.db`
          SELECT p.id, p.name, p.property_type, p.market, p.rentable_area, p.unit_count,
                 pp.ownership_percent
          FROM portfolio_properties pp
          JOIN properties p ON p.id = pp.property_id
          WHERE pp.portfolio_id = ${id} AND p.deleted_at IS NULL
          ORDER BY p.name
        `) as unknown as Array<Record<string, unknown>>);

    const members: PortfolioMember[] = [];
    const excluded: Array<{ propertyId: string; propertyName: string; reason: string }> = [];

    for (const property of properties) {
      const modelRows = (await request.db`
        SELECT id FROM models
        WHERE property_id = ${property.id as string}
          AND organization_id = ${context.organizationId}
          AND deleted_at IS NULL
          AND (${query.modelClassification ?? null}::text IS NULL
               OR classification = ${query.modelClassification ?? null}::text)
        ORDER BY
          CASE status WHEN 'published' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
          updated_at DESC
        LIMIT 1
      `) as unknown as Array<{ id: string }>;
      const modelId = modelRows[0]?.id;
      if (!modelId) {
        excluded.push({
          propertyId: property.id as string,
          propertyName: property.name as string,
          reason: 'No model matches the requested classification.',
        });
        continue;
      }
      const latest = await getLatestCalculation(request.db, modelId);
      if (!latest) {
        excluded.push({
          propertyId: property.id as string,
          propertyName: property.name as string,
          reason: 'Its model has not been calculated yet.',
        });
        continue;
      }
      members.push({
        propertyId: property.id as string,
        propertyName: property.name as string,
        propertyType: property.property_type as string,
        market: (property.market as string | null) ?? null,
        ownershipPercent: (property.ownership_percent as string) ?? '1',
        rentableArea: (property.rentable_area as string | null) ?? null,
        unitCount: (property.unit_count as number) ?? 0,
        result: latest.result,
      });
    }

    if (members.length === 0) {
      throw badRequest(
        'No property in this portfolio has a calculated model, so there is nothing to aggregate.',
        { excluded },
      );
    }

    return {
      portfolio: { id: portfolio.id, name: portfolio.name },
      aggregate: aggregatePortfolio(members),
      included: members.map((member) => ({
        propertyId: member.propertyId,
        propertyName: member.propertyName,
        ownershipPercent: member.ownershipPercent,
      })),
      excluded,
    };
  });

  app.put('/portfolios/:id/properties', async (request) => {
    const context = requireCapability(request, 'portfolio:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ propertyIds: z.array(z.string().uuid()) }).parse(request.body);

    await request.db.begin(async (tx) => {
      const owns = (await tx`
        SELECT 1 FROM portfolios
        WHERE id = ${id} AND organization_id = ${context.organizationId} AND deleted_at IS NULL
      `) as unknown as unknown[];
      if (owns.length === 0) throw notFound();

      await tx`DELETE FROM portfolio_properties WHERE portfolio_id = ${id}`;
      for (const propertyId of body.propertyIds) {
        await tx`
          INSERT INTO portfolio_properties (portfolio_id, property_id, ownership_percent)
          SELECT ${id}, p.id, p.ownership_percent
          FROM properties p
          WHERE p.id = ${propertyId} AND p.organization_id = ${context.organizationId}
        `;
      }
    });
    return { ok: true };
  });
}
