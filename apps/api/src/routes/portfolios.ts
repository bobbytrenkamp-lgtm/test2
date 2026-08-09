import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@cre/database';
import {
  aggregatePortfolio,
  areaString,
  moneyString,
  sum,
  ZERO,
  type PortfolioMember,
} from '@cre/calculation-engine';
import type { LeaseCashFlowRow, ModelResult } from '@cre/domain-models';
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

  /**
   * Tenant exposure across every property in the portfolio, not one model at a
   * time.
   *
   * The rent-roll and health screens already answer "how concentrated is this
   * tenant in this model". Nobody underwriting an acquisition asks that
   * question one property at a time — a national retailer that is 8% of one
   * asset and 8% of three others is 25%+ of the portfolio's income, and that
   * fact is invisible from any single model.
   */
  app.get('/portfolios/:id/tenant-exposure', async (request) => {
    const context = requireCapability(request, 'portfolio:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z
      .object({ modelClassification: z.string().max(60).optional() })
      .parse(request.query);
    return tenantExposureForPortfolio(
      request.db,
      context.organizationId,
      id,
      query.modelClassification,
    );
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
 * The portfolio's member properties, and each one's leading model and latest
 * stored result, in a shape both the financial roll-up and tenant analytics
 * can consume.
 *
 * Extracted so a second query cannot drift from the first: the fund roll-up,
 * the portfolio screen and tenant-level exposure all have to agree on which
 * model "is" a property's current position, and disagreeing about that would
 * be far worse than any one of them being wrong alone.
 *
 * `DISTINCT ON` picks one model per property under the loop's original
 * precedence — published, then approved, then most recently updated — in one
 * query rather than two round trips per property. The load test put a loop
 * version at roughly half a millisecond of pure latency per property: fine on
 * a laptop, and about two seconds for a thousand-property fund once the
 * database is a network hop away.
 */
async function resolvePortfolioMembership(
  db: FastifyRequest['db'],
  organizationId: string,
  id: string,
  modelClassification?: string,
): Promise<{
  portfolio: Record<string, unknown>;
  properties: Array<Record<string, unknown>>;
  resultByProperty: Map<string, { model_id: string; result: unknown | null }>;
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

  const propertyIds = properties.map((property) => property.id as string);

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

  return {
    portfolio,
    properties,
    resultByProperty: new Map(leading.map((row) => [row.property_id, row])),
  };
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
  const { portfolio, properties, resultByProperty } = await resolvePortfolioMembership(
    db,
    organizationId,
    id,
    modelClassification,
  );

  const members: PortfolioMember[] = [];
  const excluded: Array<{ propertyId: string; propertyName: string; reason: string }> = [];

  for (const property of properties) {
    const row = resultByProperty.get(property.id as string);
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

interface TenantExposureRow {
  tenantId: string;
  tenantName: string;
  parentCompany: string | null;
  industry: string | null;
  creditRating: string | null;
  isAnchor: boolean;
  /** Year-1 base rent, summed across every property the tenant occupies. */
  annualBaseRent: string;
  /** Current occupied area, summed the same way. */
  occupiedArea: string;
  /** Share of the portfolio's total year-1 base rent, "0".."1". */
  shareOfRent: string;
  /** Share of the portfolio's total occupied area, "0".."1". */
  shareOfArea: string;
  properties: Array<{ propertyId: string; propertyName: string }>;
  leaseCount: number;
  /** ISO date of the tenant's earliest expiration across the portfolio. */
  earliestExpiration: string | null;
}

/**
 * Exposure by tenant across every property in a portfolio.
 *
 * Reads the same leading-model results the financial roll-up does, so a
 * tenant's exposure can never disagree with what that property's own
 * cash-flow tab shows. Nothing here is derived twice: year-1 rent and
 * occupied area come straight out of `leaseCashFlows`, which the engine
 * already computed in Decimal arithmetic — this only sums what is there.
 *
 * **Real tenants only, not speculative fill.** A `new_lease` row is the
 * engine's own guess at whoever eventually re-lets an expiring space once
 * nothing is contracted for it; `leases.ts` gives that row a synthetic
 * `tenantId` of `market:<profileId>` rather than any real tenant's, and it is
 * excluded here for the same reason `assessHealth`'s tenant-concentration
 * rule excludes it — counting it would report a fictional name as exposure. A
 * `renewal` row is **kept**: it carries the same real tenant's id and name as
 * the lease it follows, weighted by their probability of staying, so it is
 * that tenant's exposure just as much as the original term was.
 */
async function tenantExposureForPortfolio(
  db: FastifyRequest['db'],
  organizationId: string,
  id: string,
  modelClassification?: string,
): Promise<{
  portfolio: { id: unknown; name: unknown };
  tenants: TenantExposureRow[];
  totalAnnualBaseRent: string;
  totalOccupiedArea: string;
  propertyCount: number;
  excluded: Array<{ propertyId: string; propertyName: string; reason: string }>;
}> {
  const { portfolio, properties, resultByProperty } = await resolvePortfolioMembership(
    db,
    organizationId,
    id,
    modelClassification,
  );

  interface Accumulator {
    tenantId: string;
    rent: ReturnType<typeof sum>;
    area: ReturnType<typeof sum>;
    properties: Map<string, string>;
    /** (modelId, leaseCode) pairs — see the note on `leaseId` below. Codes
     *  carry no character restriction, so these stay a plain array rather
     *  than a delimited string key that a code could collide with. */
    leases: Array<{ modelId: string; code: string }>;
  }
  const byTenant = new Map<string, Accumulator>();
  const excluded: Array<{ propertyId: string; propertyName: string; reason: string }> = [];
  let anyIncluded = false;

  for (const property of properties) {
    const row = resultByProperty.get(property.id as string);
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
    anyIncluded = true;

    const result = row.result as ModelResult;
    // Rolled up by lease first: a tenant with two leases on the same property
    // must not be double-counted into "one property" and its rent kept once,
    // not merged, per lease.
    for (const lease of result.leaseCashFlows) {
      if (!isSignedRow(lease)) continue;

      const existing = byTenant.get(lease.tenantId) ?? {
        tenantId: lease.tenantId,
        rent: ZERO,
        area: ZERO,
        properties: new Map<string, string>(),
        leases: [],
      };
      existing.rent = existing.rent.plus(sum(lease.baseRent.slice(0, 12)));
      existing.area = existing.area.plus(sum([lease.occupiedArea[0] ?? '0']));
      existing.properties.set(property.id as string, property.name as string);
      /*
       * `leaseId` on a `leaseCashFlows` row is the lease's *code* -- see
       * `buildModelInput`, which maps `id: row.code` when it assembles a
       * model's leases -- not the database row's uuid, and codes are unique
       * only within a model. A renewal branch also has its own generated code
       * rather than the original lease's; the real signed lease behind it is
       * `rolloverOf`, the same fallback `assessHealth`'s tenant-concentration
       * rule uses. Both are paired with this property's leading model id so
       * the lookup below can resolve them unambiguously.
       */
      existing.leases.push({ modelId: row.model_id, code: lease.rolloverOf ?? lease.leaseId });
      byTenant.set(lease.tenantId, existing);
    }
  }

  if (!anyIncluded) {
    throw badRequest(
      'No property in this portfolio has a calculated model, so there is no tenant exposure to show.',
      { excluded },
    );
  }

  /*
   * Only ids shaped like a real tenant's — `market:<profileId>` never is —
   * reach the database at all, so a malformed id fails softly here rather
   * than as a Postgres cast error.
   *
   * `isSignedRow` above is a cheap first pass, not the authority: a
   * speculative branch that itself rolls over a second time within the
   * forecast inherits `scenario: 'renewal'` from its own speculative parent
   * (`leases.ts` sets a renewal's tenant to `parent.tenantId`, and that
   * parent can itself be a `market:<profileId>` placeholder), so `scenario`
   * alone cannot tell a real tenant from a nested guess about one. Matching
   * against the real `tenants` table below is what actually decides it: a
   * row that resolves to nobody is dropped, whatever scenario produced it.
   */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const tenantIds = [...byTenant.keys()].filter((tenantId) => UUID.test(tenantId));
  const tenantRows = (tenantIds.length === 0
    ? []
    : await db`
        SELECT id, name, parent_company, industry, credit_rating, is_anchor
        FROM tenants
        WHERE id = ANY(${tenantIds}::uuid[])
      `) as unknown as Array<{
    id: string;
    name: string;
    parent_company: string | null;
    industry: string | null;
    credit_rating: string | null;
    is_anchor: boolean;
  }>;
  const tenantById = new Map(tenantRows.map((row) => [row.id, row]));
  // Drop any accumulated bucket that never resolved to a real tenant, rather
  // than reporting it under a synthetic id or a placeholder name — the whole
  // point of matching against `tenants` is to stop a fictional name from
  // reaching this list, not to relabel it and let it through anyway.
  for (const tenantId of byTenant.keys()) {
    if (!tenantById.has(tenantId)) byTenant.delete(tenantId);
  }

  /*
   * Earliest expiration per tenant, from the raw lease rows rather than the
   * calculation result: `leaseCashFlows` reports occupancy month by month, not
   * a lease's own expiration date, and re-deriving one from a run of nonzero
   * months would be exactly the kind of second implementation this function's
   * own doc comment warns against.
   *
   * Matched on (model_id, code) rather than a lease id, per the note above —
   * a code is unique only within its model, so both are required to resolve
   * one unambiguously. `unnest` zips the two parallel arrays back into rows
   * to join against. Scoped to the specific leases counted above, not every
   * lease this tenant holds across the organization, and to this organization
   * via the join to `models`, since `leases` has no organization column of
   * its own.
   */
  const wanted = [...byTenant.values()].flatMap((entry) => entry.leases);
  const expirations = (wanted.length === 0
    ? []
    : await db`
        SELECT l.tenant_id, MIN(l.expiration_date) AS earliest
        FROM leases l
        JOIN models m ON m.id = l.model_id
        JOIN unnest(
          ${wanted.map((entry) => entry.modelId)}::uuid[],
          ${wanted.map((entry) => entry.code)}::text[]
        ) AS w(model_id, code) ON w.model_id = l.model_id AND w.code = l.code
        WHERE m.organization_id = ${organizationId}
        GROUP BY l.tenant_id
      `) as unknown as Array<{ tenant_id: string; earliest: Date | string | null }>;
  const expirationByTenant = new Map(
    expirations.map((row) => [
      row.tenant_id,
      row.earliest instanceof Date ? row.earliest.toISOString().slice(0, 10) : row.earliest,
    ]),
  );

  const totalRent = sum([...byTenant.values()].map((entry) => entry.rent));
  const totalArea = sum([...byTenant.values()].map((entry) => entry.area));

  const tenants: TenantExposureRow[] = [...byTenant.values()]
    .map((entry) => {
      // Guaranteed present: any entry without a match was deleted above.
      const tenant = tenantById.get(entry.tenantId) as NonNullable<
        ReturnType<typeof tenantById.get>
      >;
      return {
        tenantId: entry.tenantId,
        tenantName: tenant.name,
        parentCompany: tenant.parent_company,
        industry: tenant.industry,
        creditRating: tenant.credit_rating,
        isAnchor: tenant.is_anchor,
        annualBaseRent: moneyString(entry.rent),
        occupiedArea: areaString(entry.area),
        shareOfRent: totalRent.isZero() ? '0' : entry.rent.dividedBy(totalRent).toFixed(8),
        shareOfArea: totalArea.isZero() ? '0' : entry.area.dividedBy(totalArea).toFixed(8),
        properties: [...entry.properties.entries()].map(([propertyId, propertyName]) => ({
          propertyId,
          propertyName,
        })),
        leaseCount: entry.leases.length,
        earliestExpiration: expirationByTenant.get(entry.tenantId) ?? null,
      };
    })
    // Largest exposure first: the concentration a reviewer opens this for is
    // at the top without having to sort a table to find it.
    .sort((a, b) => Number(b.annualBaseRent) - Number(a.annualBaseRent));

  return {
    portfolio: { id: portfolio.id, name: portfolio.name },
    tenants,
    totalAnnualBaseRent: moneyString(totalRent),
    totalOccupiedArea: areaString(totalArea),
    propertyCount: properties.length - excluded.length,
    excluded,
  };
}

/**
 * Whether a `leaseCashFlows` row belongs to a real tenant, as opposed to the
 * engine's own speculative fill of a space nothing is contracted for.
 *
 * `scenario: 'renewal'` is **included**: `leases.ts` carries the real tenant's
 * own id and name onto a renewal branch, so it is the same tenant staying,
 * weighted by their probability of doing so — still that tenant's exposure,
 * the same way `assessHealth`'s tenant-concentration rule treats it.
 *
 * `scenario: 'new_lease'` is the one excluded: `leases.ts` gives it a
 * synthetic `tenantId` of `market:<profileId>` rather than a real tenant, so
 * it is not merely uncertain exposure, it is not a tenant at all — no row in
 * `tenants` has that id, and a query that tried to join one would fail on the
 * uuid cast rather than return nothing.
 */
function isSignedRow(lease: LeaseCashFlowRow): boolean {
  return lease.scenario !== 'new_lease';
}
