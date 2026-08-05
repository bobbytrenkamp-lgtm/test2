import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@cre/database';
import { aggregatePortfolio, type PortfolioMember } from '@cre/calculation-engine';
import { PORTFOLIO_REPORTS } from '@cre/reporting';
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
    return aggregateForPortfolio(request.db, context.organizationId, id, query.modelClassification);
  });

  app.get('/portfolios/reports', async (request) => {
    requireCapability(request, 'report:read');
    return {
      reports: PORTFOLIO_REPORTS.map((report) => ({
        id: report.id,
        title: report.title,
        description: report.description,
      })),
    };
  });

  /**
   * A portfolio report, built from the same roll-up the screen shows.
   *
   * Every rate on it states its own basis in a column, because a portfolio
   * capitalisation rate that looks like an average of property rates — and is
   * not — is a figure a reader will misread unless told.
   */
  app.get('/portfolios/:id/reports/:reportId', async (request) => {
    const context = requireCapability(request, 'report:read');
    const params = z
      .object({ id: z.string().uuid(), reportId: z.string().max(60) })
      .parse(request.params);
    const query = z
      .object({ modelClassification: z.string().max(60).optional() })
      .parse(request.query);

    const definition = PORTFOLIO_REPORTS.find((report) => report.id === params.reportId);
    if (!definition) throw notFound('That report does not exist.');

    const rollUp = await aggregateForPortfolio(
      request.db,
      context.organizationId,
      params.id,
      query.modelClassification,
    );

    return {
      report: definition.build(rollUp.aggregate, {
        portfolioName: String(rollUp.portfolio.name),
        currency: 'USD',
        areaUnit: 'sqft',
      }),
      excluded: rollUp.excluded,
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

/**
 * Rolls a portfolio up from its members' latest stored calculations.
 *
 * Extracted from the route so the fund roll-up reports residual value from
 * the same aggregation the portfolio screen shows. A second implementation
 * would drift, and the first anyone would know of it is a fund and a
 * portfolio disagreeing about the value of the same assets.
 */
export async function aggregateForPortfolio(
  db: FastifyRequest['db'],
  organizationId: string,
  id: string,
  modelClassification?: string,
): Promise<{
  portfolio: { id: unknown; name: unknown };
  aggregate: ReturnType<typeof aggregatePortfolio>;
  included: Array<{ propertyId: string; propertyName: string; ownershipPercent: string }>;
  excluded: Array<{ propertyId: string; propertyName: string; reason: string }>;
}> {
  const portfolioRows = (await db`
    SELECT * FROM portfolios
    WHERE id = ${id} AND organization_id = ${organizationId} AND deleted_at IS NULL
  `) as unknown as Array<Record<string, unknown>>;
  const portfolio = portfolioRows[0];
  if (!portfolio) throw notFound('That portfolio does not exist in this organization.');

  const filter = (portfolio.filter_definition ?? {}) as {
    propertyTypes?: string[];
    markets?: string[];
    tags?: string[];
  };

  const properties = portfolio.is_dynamic
    ? ((await db`
        SELECT p.id, p.name, p.property_type, p.market, p.rentable_area, p.unit_count,
               p.ownership_percent
        FROM properties p
        WHERE p.organization_id = ${organizationId} AND p.deleted_at IS NULL
          AND (${filter.propertyTypes ?? null}::text[] IS NULL
               OR p.property_type = ANY(${filter.propertyTypes ?? null}::text[]))
          AND (${filter.markets ?? null}::text[] IS NULL
               OR p.market = ANY(${filter.markets ?? null}::text[]))
          AND (${filter.tags ?? null}::text[] IS NULL OR p.tags && ${filter.tags ?? null}::text[])
        ORDER BY p.name
      `) as unknown as Array<Record<string, unknown>>)
    : ((await db`
        SELECT p.id, p.name, p.property_type, p.market, p.rentable_area, p.unit_count,
               pp.ownership_percent
        FROM portfolio_properties pp
        JOIN properties p ON p.id = pp.property_id
        WHERE pp.portfolio_id = ${id} AND p.deleted_at IS NULL
        ORDER BY p.name
      `) as unknown as Array<Record<string, unknown>>);

  const members: PortfolioMember[] = [];
  const excluded: Array<{ propertyId: string; propertyName: string; reason: string }> = [];
  const propertyIds = properties.map((property) => property.id as string);

  /*
   * The leading model for every property, and its latest result, in one
   * query.
   *
   * This was a loop issuing two round trips per property. The load test put
   * that at roughly half a millisecond each against a local database — fine
   * on a laptop, and about two seconds of pure latency for a thousand-property
   * fund once the database is a network hop away. Round trips are the cost
   * here, not the work, so the fix is to stop making them rather than to make
   * them faster.
   *
   * `DISTINCT ON` picks one row per property under the same precedence the
   * loop applied: published, then approved, then most recently updated.
   */
  const leading = (propertyIds.length === 0
    ? []
    : await db`
          WITH leading_model AS (
            SELECT DISTINCT ON (m.property_id) m.property_id, m.id AS model_id
            FROM models m
            WHERE m.organization_id = ${organizationId}
              AND m.property_id = ANY(${propertyIds}::uuid[])
              AND m.deleted_at IS NULL
              AND (${modelClassification ?? null}::text IS NULL
                   OR m.classification = ${modelClassification ?? null}::text)
            ORDER BY m.property_id,
                     CASE m.status WHEN 'published' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                     m.updated_at DESC
          )
          SELECT DISTINCT ON (lm.property_id)
                 lm.property_id, lm.model_id, r.result
          FROM leading_model lm
          LEFT JOIN calculation_runs r
            ON r.model_id = lm.model_id AND r.status = 'succeeded' AND r.result IS NOT NULL
          ORDER BY lm.property_id, r.created_at DESC
        `) as unknown as Array<{ property_id: string; model_id: string; result: unknown | null }>;

  const byProperty = new Map(leading.map((row) => [row.property_id, row]));

  for (const property of properties) {
    const row = byProperty.get(property.id as string);
    if (!row) {
      excluded.push({
        propertyId: property.id as string,
        propertyName: property.name as string,
        reason: 'No model matches the requested classification.',
      });
      continue;
    }
    if (!row.result) {
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
      result: row.result as PortfolioMember['result'],
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
}
