import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit, type Sql } from '@cre/database';
import {
  computeFund,
  computeFundWaterfall,
  type FundInvestor,
  type FundTransaction,
  type FundWaterfallTier,
} from '@cre/calculation-engine';
import { waterfallTierSchema } from '@cre/domain-models';
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
        type: z.enum(['contribution', 'distribution', 'recall']),
        // Positive only. A signed amount would let a contribution be recorded
        // as a negative that then reads as a distribution, and nothing
        // downstream could tell the difference.
        amount: decimalAmount,
        // Meaningful only on a distribution: whether the governing document
        // lets the GP draw this money back later. Silently ignored on any
        // other type rather than rejected, since a caller building the row
        // generically may send it unconditionally.
        recallable: z.boolean().default(false),
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
        fund_id, investor_id, transaction_date, type, amount, recallable, reference, notes, created_by
      ) VALUES (
        ${id}, ${investorId}, ${body.date}, ${body.type}, ${body.amount},
        ${body.type === 'distribution' && body.recallable}, ${body.reference ?? null},
        ${body.notes ?? null}, ${context.userId}
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
  /* Fund-level waterfall                                                    */
  /* ---------------------------------------------------------------------- */

  app.get('/funds/:id/waterfall-tiers', async (request) => {
    const context = requireCapability(request, 'portfolio:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const fund = await requireFund(request, context.organizationId, id);
    return { tiers: fund.waterfall_tiers ?? [], version: fund.version };
  });

  app.put('/funds/:id/waterfall-tiers', async (request) => {
    const context = requireCapability(request, 'portfolio:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireFund(request, context.organizationId, id);

    const body = z
      .object({
        tiers: z.array(waterfallTierSchema),
        expectedVersion: z.number().int().min(1).nullish(),
      })
      .parse(request.body);

    // Every split has to name a real investor of this fund. The engine
    // itself would simply pay nobody for an id it does not recognise — no
    // error, since it cannot tell a stale id from a value that was never
    // valid — so an id that names nothing is caught here instead, while the
    // mistake is still in front of whoever is about to save it.
    const investors = (await request.db`
      SELECT id FROM fund_investors WHERE fund_id = ${id}
    `) as unknown as Array<{ id: string }>;
    const investorIds = new Set(investors.map((row) => row.id));
    const unknown = new Set<string>();
    for (const tier of body.tiers) {
      for (const split of tier.splits) {
        if (!investorIds.has(split.partnerId)) unknown.add(split.partnerId);
      }
    }
    if (unknown.size > 0) {
      throw badRequest(
        `These tier splits name an id that does not belong to any investor in this fund: ${[...unknown].join(', ')}.`,
      );
    }

    const fund = await request.db.begin(async (tx) => {
      if (body.expectedVersion !== undefined && body.expectedVersion !== null) {
        const existing = (await tx`
          SELECT version FROM funds WHERE id = ${id} FOR UPDATE
        `) as unknown as Array<{ version: number }>;
        const current = existing[0]?.version;
        if (current !== undefined && current !== body.expectedVersion) {
          throw new HttpError(
            409,
            'FUND_VERSION_CONFLICT',
            `This fund has been changed by someone else since you opened it ` +
              `(you have version ${body.expectedVersion}, it is now ${current}).`,
            { expectedVersion: body.expectedVersion, currentVersion: current },
          );
        }
      }
      const rows = (await tx`
        UPDATE funds
        SET waterfall_tiers = ${tx.json(body.tiers as never)}, version = version + 1, updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `) as unknown as Array<Record<string, unknown>>;
      return rows[0] as Record<string, unknown>;
    });

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'fund.waterfall_tiers_saved',
      entityType: 'fund',
      entityId: id,
      newValue: { tierCount: body.tiers.length },
      ipAddress: request.ip,
    });

    return { tiers: fund.waterfall_tiers, version: fund.version };
  });

  /**
   * Proposes how a distribution should split, without recording anything.
   *
   * `computeFundWaterfall` throws when its own tiers do not fully allocate
   * the amount — no residual tier, or one whose shares sum to zero — rather
   * than guess a fallback; that becomes a 400 naming exactly what is short,
   * so a GP finds a misconfigured waterfall before a single dollar moves,
   * not after.
   */
  app.post('/funds/:id/waterfall/preview', async (request) => {
    const context = requireCapability(request, 'portfolio:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const fund = await requireFund(request, context.organizationId, id);

    const body = z
      .object({ distributionDate: isoDate, distributableAmount: decimalAmount })
      .parse(request.body);

    const tiers = (fund.waterfall_tiers as FundWaterfallTier[] | null) ?? [];
    if (tiers.length === 0) {
      throw badRequest(
        'This fund has no waterfall tiers configured yet. Add at least one before proposing a distribution.',
      );
    }

    const { investors, transactions } = await loadWaterfallInputs(request.db, id);
    const proposal = runWaterfall(investors, transactions, tiers, body);
    return { proposal };
  });

  /**
   * Applies a proposed distribution: recomputes it server-side from the same
   * real transactions and stated tiers a preview reads — never a
   * client-supplied allocation, so an apply can never record a split the
   * tiers themselves did not produce — then records one `distribution`
   * transaction per investor the proposal actually pays, in one transaction
   * so the fund's ledger is never left with some of a distribution recorded
   * and the rest missing.
   */
  app.post('/funds/:id/waterfall/apply', async (request, reply) => {
    const context = requireCapability(request, 'portfolio:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await requireFund(request, context.organizationId, id);

    const body = z
      .object({ distributionDate: isoDate, distributableAmount: decimalAmount })
      .parse(request.body);

    /*
     * `computeFundWaterfall` decides every allocation from this fund's prior
     * transactions alone — it has no notion of another `apply` that is
     * concurrently deciding the same thing. Two requests racing this route
     * would otherwise both read the same not-yet-updated transaction history,
     * compute the identical proposal, and both insert it: the same
     * distribution paid twice. Locking the fund row for the rest of this
     * transaction — and only then reading tiers and transactions — forces a
     * second concurrent request to wait for the first to commit; once it
     * proceeds, it sees the first's just-inserted distribution on this same
     * date and hits the engine's own "not before the proposed distribution
     * date" guard (the same one that already refuses a stale preview), so it
     * fails loudly instead of paying twice.
     */
    const { toRecord, proposal, created } = await request.db.begin(async (tx) => {
      const fundRows = (await tx`
        SELECT waterfall_tiers FROM funds WHERE id = ${id} FOR UPDATE
      `) as unknown as Array<{ waterfall_tiers: FundWaterfallTier[] | null }>;
      const tiers = fundRows[0]?.waterfall_tiers ?? [];
      if (tiers.length === 0) {
        throw badRequest(
          'This fund has no waterfall tiers configured yet. Add at least one before proposing a distribution.',
        );
      }

      const { investors, transactions } = await loadWaterfallInputs(tx as unknown as Sql, id);
      const proposal = runWaterfall(investors, transactions, tiers, body);

      const toRecord = proposal.allocations.filter((allocation) => Number(allocation.total) > 0);
      if (toRecord.length === 0) {
        throw badRequest('This distribution would pay nobody, so nothing was recorded.');
      }

      const rows: Array<Record<string, unknown>> = [];
      for (const allocation of toRecord) {
        const inserted = (await tx`
          INSERT INTO fund_transactions (
            fund_id, investor_id, transaction_date, type, amount, recallable, reference, created_by
          ) VALUES (
            ${id}, ${allocation.investorId}, ${body.distributionDate}, 'distribution',
            ${allocation.total}, false, 'Fund waterfall distribution', ${context.userId}
          )
          RETURNING *
        `) as unknown as Array<Record<string, unknown>>;
        rows.push(inserted[0] as Record<string, unknown>);
      }
      return { toRecord, proposal, created: rows };
    });

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'fund.waterfall_applied',
      entityType: 'fund',
      entityId: id,
      newValue: {
        distributionDate: body.distributionDate,
        distributableAmount: body.distributableAmount,
        investorCount: toRecord.length,
      },
      ipAddress: request.ip,
    });

    return reply.status(201).send({ transactions: created, proposal });
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
 * Loads a fund's investors and transactions in the shape the calculation
 * engine expects.
 *
 * Shared by the roll-up (`fundPosition`) and the waterfall routes so there is
 * exactly one query for "what has actually happened in this fund's ledger" —
 * a second, drifted copy is how a report and a distribution preview end up
 * disagreeing about the same fund.
 */
async function loadWaterfallInputs(
  db: Sql,
  id: string,
): Promise<{
  investorRows: Array<{
    id: string;
    code: string;
    name: string;
    investor_class: string;
    commitment: string;
  }>;
  investors: FundInvestor[];
  transactions: FundTransaction[];
}> {
  const investorRows = (await db`
    SELECT id, code, name, investor_class, commitment
    FROM fund_investors WHERE fund_id = ${id} ORDER BY code
  `) as unknown as Array<{
    id: string;
    code: string;
    name: string;
    investor_class: string;
    commitment: string;
  }>;

  const transactionRows = (await db`
    SELECT investor_id, to_char(transaction_date, 'YYYY-MM-DD') AS date, type, amount, recallable
    FROM fund_transactions WHERE fund_id = ${id}
    ORDER BY transaction_date
  `) as unknown as Array<{
    investor_id: string;
    date: string;
    type: string;
    amount: string;
    recallable: boolean;
  }>;

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
    recallable: row.recallable,
  }));

  return { investorRows, investors, transactions };
}

/**
 * Runs `computeFundWaterfall`, translating the engine's own thrown `Error`
 * (an unallocated remainder, or a transaction on/after the proposed date)
 * into a 400 that names the problem — the caller gets to fix a misconfigured
 * waterfall instead of seeing an unhandled server error.
 */
function runWaterfall(
  investors: FundInvestor[],
  transactions: FundTransaction[],
  tiers: FundWaterfallTier[],
  body: { distributionDate: string; distributableAmount: string },
): ReturnType<typeof computeFundWaterfall> {
  try {
    return computeFundWaterfall({
      investors,
      transactions,
      tiers,
      distributionDate: body.distributionDate,
      distributableAmount: body.distributableAmount,
    });
  } catch (error) {
    throw badRequest(
      error instanceof Error ? error.message : 'This waterfall could not be computed.',
    );
  }
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
  const { investorRows, investors, transactions } = await loadWaterfallInputs(request.db, id);

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
