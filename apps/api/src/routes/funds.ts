import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@cre/database';
import { computeFund, type FundInvestor, type FundTransaction } from '@cre/calculation-engine';
import { FUND_REPORTS } from '@cre/reporting';
import { HttpError, badRequest, notFound, requireCapability } from '../context.js';
import { aggregateForPortfolio } from './portfolios.js';

/**
 * Funds: commitments, capital calls, distributions and investor returns.
 *
 * A fund holds a portfolio, and its residual value comes from that portfolio's
 * roll-up rather than a second one of its own — see `aggregateForPortfolio`.
 * A fund with no portfolio still reports everything the transaction record can
 * support; it simply has no unrealised value to add, and says so instead of
 * assuming zero is the same thing.
 */

const decimalAmount = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Expected a positive amount with at most two decimals');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export async function registerFundRoutes(app: FastifyInstance): Promise<void> {
  app.get('/funds', async (request) => {
    const context = requireCapability(request, 'portfolio:read');
    const rows = await request.db`
      SELECT f.id, f.name, f.vintage_year, f.committed_capital, f.currency, f.portfolio_id,
             f.version, f.created_at,
             (SELECT count(*)::int FROM fund_investors i WHERE i.fund_id = f.id) AS investor_count,
             (SELECT coalesce(sum(i.commitment), 0) FROM fund_investors i WHERE i.fund_id = f.id)
               AS total_commitment
      FROM funds f
      WHERE f.organization_id = ${context.organizationId}
      ORDER BY f.name
    `;
    return { funds: rows };
  });

  app.post('/funds', async (request, reply) => {
    const context = requireCapability(request, 'portfolio:write');
    const body = z
      .object({
        name: z.string().min(1).max(200),
        vintageYear: z.number().int().min(1900).max(2200).nullish(),
        committedCapital: decimalAmount.nullish(),
        currency: z.string().length(3).default('USD'),
        portfolioId: z.string().uuid().nullish(),
      })
      .parse(request.body);

    const rows = (await request.db`
      INSERT INTO funds (organization_id, name, vintage_year, committed_capital, currency, portfolio_id)
      VALUES (${context.organizationId}, ${body.name}, ${body.vintageYear ?? null},
              ${body.committedCapital ?? null}, ${body.currency},
              ${body.portfolioId ?? null})
      RETURNING *
    `) as unknown as Array<Record<string, unknown>>;
    const fund = rows[0] as Record<string, unknown>;

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'fund.created',
      entityType: 'fund',
      entityId: fund.id as string,
      newValue: { name: body.name, vintageYear: body.vintageYear ?? null },
      ipAddress: request.ip,
    });
    return reply.status(201).send({ fund });
  });

  /* ---------------------------------------------------------------------- */
  /* Investors                                                               */
  /* ---------------------------------------------------------------------- */

  app.get('/funds/:id/investors', async (request) => {
    const context = requireCapability(request, 'portfolio:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireFund(request, context.organizationId, id);
    const investors = await request.db`
      SELECT * FROM fund_investors WHERE fund_id = ${id} ORDER BY code
    `;
    return { investors };
  });

  app.put('/funds/:id/investors/:code', async (request) => {
    const context = requireCapability(request, 'portfolio:write');
    const params = z
      .object({ id: z.string().uuid(), code: z.string().min(1).max(60) })
      .parse(request.params);
    await requireFund(request, context.organizationId, params.id);

    const body = z
      .object({
        name: z.string().min(1).max(200),
        investorClass: z.enum(['lp', 'gp']).default('lp'),
        commitment: decimalAmount.default('0'),
        contactEmail: z.string().email().max(320).nullish(),
        notes: z.string().max(2000).nullish(),
        expectedVersion: z.number().int().min(1).nullish(),
      })
      .parse(request.body);

    // The same guard the rest of the platform uses: a commitment is a legal
    // figure, and two people editing one at once must not silently overwrite.
    const investor = await request.db.begin(async (tx) => {
      if (body.expectedVersion !== undefined && body.expectedVersion !== null) {
        const existing = (await tx`
          SELECT version FROM fund_investors
          WHERE fund_id = ${params.id} AND code = ${params.code}
          FOR UPDATE
        `) as unknown as Array<{ version: number }>;
        const current = existing[0]?.version;
        if (current !== undefined && current !== body.expectedVersion) {
          throw new HttpError(
            409,
            'INVESTOR_VERSION_CONFLICT',
            `${params.code} has been changed by someone else since you opened it ` +
              `(you have version ${body.expectedVersion}, it is now ${current}).`,
            { code: params.code, expectedVersion: body.expectedVersion, currentVersion: current },
          );
        }
      }
      const rows = (await tx`
        INSERT INTO fund_investors (
          fund_id, organization_id, code, name, investor_class, commitment, contact_email, notes
        ) VALUES (
          ${params.id}, ${context.organizationId}, ${params.code}, ${body.name},
          ${body.investorClass}, ${body.commitment}, ${body.contactEmail ?? null},
          ${body.notes ?? null}
        )
        ON CONFLICT (fund_id, code) DO UPDATE SET
          name = EXCLUDED.name,
          investor_class = EXCLUDED.investor_class,
          commitment = EXCLUDED.commitment,
          contact_email = EXCLUDED.contact_email,
          notes = EXCLUDED.notes,
          version = fund_investors.version + 1,
          updated_at = now()
        RETURNING *
      `) as unknown as Array<Record<string, unknown>>;
      return rows[0] as Record<string, unknown>;
    });

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'fund.investor_saved',
      entityType: 'fund_investor',
      entityId: params.code,
      newValue: { name: body.name, commitment: body.commitment },
      ipAddress: request.ip,
    });
    return { investor };
  });

  /* ---------------------------------------------------------------------- */
  /* Capital calls and distributions                                         */
  /* ---------------------------------------------------------------------- */

  app.get('/funds/:id/transactions', async (request) => {
    const context = requireCapability(request, 'portfolio:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireFund(request, context.organizationId, id);
    const transactions = await request.db`
      SELECT t.*, i.code AS investor_code, i.name AS investor_name
      FROM fund_transactions t
      JOIN fund_investors i ON i.id = t.investor_id
      WHERE t.fund_id = ${id}
      ORDER BY t.transaction_date, i.code
    `;
    return { transactions };
  });

  app.post('/funds/:id/transactions', async (request, reply) => {
    const context = requireCapability(request, 'portfolio:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireFund(request, context.organizationId, id);

    const body = z
      .object({
        investorCode: z.string().min(1).max(60),
        date: isoDate,
        type: z.enum(['contribution', 'distribution']),
        // Positive only. A signed amount would let a contribution be recorded
        // as a negative that then reads as a distribution, and nothing
        // downstream could tell the difference.
        amount: decimalAmount,
        reference: z.string().max(120).nullish(),
        notes: z.string().max(2000).nullish(),
      })
      .parse(request.body);

    if (Number(body.amount) <= 0) {
      throw badRequest('An amount must be greater than zero; the type decides the direction.');
    }

    const investors = (await request.db`
      SELECT id FROM fund_investors WHERE fund_id = ${id} AND code = ${body.investorCode}
    `) as unknown as Array<{ id: string }>;
    const investorId = investors[0]?.id;
    if (!investorId) {
      throw badRequest(
        `No investor with code ${body.investorCode} belongs to this fund. Add the investor before recording capital against them.`,
      );
    }

    const rows = (await request.db`
      INSERT INTO fund_transactions (
        fund_id, investor_id, transaction_date, type, amount, reference, notes, created_by
      ) VALUES (
        ${id}, ${investorId}, ${body.date}, ${body.type}, ${body.amount},
        ${body.reference ?? null}, ${body.notes ?? null}, ${context.userId}
      )
      RETURNING *
    `) as unknown as Array<Record<string, unknown>>;

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: `fund.${body.type}`,
      entityType: 'fund_transaction',
      entityId: (rows[0] as Record<string, unknown>).id as string,
      newValue: { investorCode: body.investorCode, date: body.date, amount: body.amount },
      ipAddress: request.ip,
    });
    return reply.status(201).send({ transaction: rows[0] });
  });

  /* ---------------------------------------------------------------------- */
  /* Reports                                                                 */
  /* ---------------------------------------------------------------------- */

  app.get('/funds/reports', async (request) => {
    requireCapability(request, 'report:read');
    return {
      reports: FUND_REPORTS.map((report) => ({
        id: report.id,
        title: report.title,
        description: report.description,
      })),
    };
  });

  /**
   * A fund report, rendered from the same summary the screen shows.
   *
   * The investor statement is the one that leaves the building, so it carries
   * its own footnotes: where the unrealised value came from, how each multiple
   * is built, and what a partnership agreement may provide for that this does
   * not model. A statement that omits its own limits invites the reader to
   * assume it has none.
   */
  app.get('/funds/:id/reports/:reportId', async (request) => {
    const context = requireCapability(request, 'report:read');
    const params = z
      .object({ id: z.string().uuid(), reportId: z.string().max(60) })
      .parse(request.params);
    const query = z.object({ valuationDate: isoDate.optional() }).parse(request.query);

    const definition = FUND_REPORTS.find((report) => report.id === params.reportId);
    if (!definition) throw notFound('That report does not exist.');

    const position = await fundPosition(request, context.organizationId, params.id, {
      valuationDate: query.valuationDate,
    });

    return {
      report: definition.build(position.summary, {
        fundName: position.fund.name as string,
        currency: (position.fund.currency as string) ?? 'USD',
        valuationDate: position.valuationDate,
        residualBasis: position.residualBasis,
      }),
    };
  });

  /* ---------------------------------------------------------------------- */
  /* The roll-up                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Fund position: commitments, unfunded capital, multiples and net return.
   *
   * `valuationDate` decides when the residual value is treated as received. It
   * defaults to today because that is what an unrealised fund's return is
   * measured to, and it is a query parameter so a report can be reproduced at
   * the date it was written rather than drifting each time it is opened.
   */
  app.get('/funds/:id/summary', async (request) => {
    const context = requireCapability(request, 'portfolio:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z
      .object({
        valuationDate: isoDate.optional(),
        modelClassification: z.string().max(60).optional(),
      })
      .parse(request.query);
    return fundPosition(request, context.organizationId, id, query);
  });
}

/**
 * A fund's position at a date.
 *
 * Extracted from the route so the reports are built from the same figures the
 * screen shows. A second path would drift, and a statement that disagrees with
 * the screen it was printed from is the worst kind of report: both look
 * authoritative and only one can be right.
 */
async function fundPosition(
  request: Parameters<typeof requireCapability>[0],
  organizationId: string,
  id: string,
  query: { valuationDate?: string; modelClassification?: string },
): Promise<{
  fund: Record<string, unknown>;
  valuationDate: string;
  residualBasis: string;
  summary: ReturnType<typeof computeFund> & {
    positions: Array<Record<string, unknown>>;
  };
}> {
  const fund = await requireFund(request, organizationId, id);

  const investorRows = (await request.db`
    SELECT id, code, name, investor_class, commitment
    FROM fund_investors WHERE fund_id = ${id} ORDER BY code
  `) as unknown as Array<{
    id: string;
    code: string;
    name: string;
    investor_class: string;
    commitment: string;
  }>;

  const transactionRows = (await request.db`
    SELECT investor_id, to_char(transaction_date, 'YYYY-MM-DD') AS date, type, amount
    FROM fund_transactions WHERE fund_id = ${id}
    ORDER BY transaction_date
  `) as unknown as Array<{ investor_id: string; date: string; type: string; amount: string }>;

  /*
   * Residual value from the fund's portfolio, using the same roll-up the
   * portfolio screen shows.
   *
   * A fund with no portfolio, or one whose properties have never been
   * calculated, reports zero residual value and says why. Substituting the
   * committed capital, or the contributed capital, would produce a TVPI of
   * about 1.0 for every such fund — a number that looks like an answer and
   * is not one.
   */
  let netAssetValue = '0';
  let residualBasis = 'No portfolio is attached to this fund, so no residual value is included.';
  const portfolioId = fund.portfolio_id as string | null;
  if (portfolioId) {
    try {
      const rollUp = await aggregateForPortfolio(
        request.db,
        organizationId,
        portfolioId,
        query.modelClassification,
      );
      netAssetValue = rollUp.aggregate.netAssetValue;
      residualBasis = `Net asset value of ${rollUp.included.length} property roll-up.`;
    } catch {
      residualBasis =
        'The attached portfolio has no calculated model, so no residual value is included.';
    }
  }

  const investors: FundInvestor[] = investorRows.map((row) => ({
    id: row.id,
    name: row.name,
    investorClass: row.investor_class,
    commitment: row.commitment,
  }));
  const transactions: FundTransaction[] = transactionRows.map((row) => ({
    investorId: row.investor_id,
    date: row.date,
    type: row.type as FundTransaction['type'],
    amount: row.amount,
  }));

  const valuationDate = query.valuationDate ?? new Date().toISOString().slice(0, 10);
  const summary = computeFund({ investors, transactions, netAssetValue, valuationDate });

  // Codes rather than identifiers, because a report names the investor the
  // way the fund's own records do.
  const codeById = new Map(investorRows.map((row) => [row.id, row.code]));
  return {
    fund: {
      id: fund.id,
      name: fund.name,
      currency: fund.currency,
      vintageYear: fund.vintage_year,
    },
    valuationDate,
    residualBasis,
    summary: {
      ...summary,
      positions: summary.positions.map((position) => ({
        ...position,
        investorCode: codeById.get(position.investorId) ?? position.investorId,
      })),
    },
  };
}

async function requireFund(
  request: Parameters<typeof requireCapability>[0],
  organizationId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const rows = (await request.db`
    SELECT * FROM funds WHERE id = ${id} AND organization_id = ${organizationId}
  `) as unknown as Array<Record<string, unknown>>;
  const fund = rows[0];
  if (!fund) throw notFound('That fund does not exist in this organization.');
  return fund;
}
