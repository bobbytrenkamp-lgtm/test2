import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '@cre/database';
import {
  buildModelInput,
  decideAssumptionProposal,
  getAssumptionProposal,
  getModel,
  listAssumptionProposals,
  recordAssumptionProposals,
  upsertCapitalItem,
  upsertDebtFacility,
  upsertExpense,
  upsertGrowthCurve,
  upsertMarketLeasingProfile,
  upsertOtherRevenue,
  writeAudit,
} from '@cre/database';
import {
  assumptionDecisionEnum,
  assumptionProposalBatchSchema,
  resolveAssumptionValue,
} from '@cre/domain-models';
import { badRequest, notFound, requireCapability, unprocessable } from '../context.js';
import { assertEditable } from './models.js';

/**
 * The assumption input contract, and the analyst's decision on it.
 *
 * An outside system — the directions call them test1 and test3 — can say what
 * it believes about an assumption in a model. It cannot change one. A proposal
 * arrives, is stored with its provenance, and sits beside the number the
 * analyst actually underwrote until a person decides between them.
 *
 * That is not distrust of the data. It is that the analyst is the one who has
 * to defend the model in a committee, and a number they cannot account for is
 * worse than a number they can argue with, however good its source. So the
 * accept is an act with a name on it, and the reject is recorded too — "we saw
 * the market number and stayed at 3.0%" is a defensible position that only
 * exists if the tool keeps it.
 */
export async function registerAssumptionProposalRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A source reports what it believes.
   *
   * Gated on `model:write` rather than a capability of its own. A proposal is
   * not an edit, but it does put a decision in front of whoever owns the model,
   * and a read-only viewer should not be able to do that.
   */
  app.post('/models/:id/assumption-proposals', async (request, reply) => {
    const context = requireCapability(request, 'model:write');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = assumptionProposalBatchSchema.parse(request.body);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound('That model does not exist in this organization.');

    /*
     * Deliberately *not* gated on the model being editable.
     *
     * A source has something to say about an approved model's exit yield and
     * that is worth hearing — it is the reason somebody would clone it. Only
     * the acceptance, which writes, is refused on a frozen model.
     */
    const { recorded, superseded } = await recordAssumptionProposals(request.db, {
      organizationId: context.organizationId,
      modelId: id,
      createdBy: context.userId,
      proposals: body.proposals,
    });

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: 'assumption_proposal.received',
      entityType: 'assumption_proposal',
      entityId: `${recorded.length} proposals`,
      modelId: id,
      propertyId: model.property_id,
      metadata: {
        sources: [...new Set(body.proposals.map((proposal) => proposal.sourceName))],
        targets: body.proposals.map((proposal) => proposal.target),
        superseded,
      },
      ipAddress: request.ip,
    });

    reply.code(201);
    return { proposals: recorded, superseded };
  });

  /**
   * The list, each proposal beside the model's own value for the same thing.
   *
   * The current value is read from the assembled `ModelInput` rather than from
   * a table, because the input is what the engine reads. Comparing against
   * anything else would be comparing against a number the model does not use.
   */
  app.get('/models/:id/assumption-proposals', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z
      .object({ status: z.enum(['pending', 'accepted', 'rejected', 'superseded']).optional() })
      .parse(request.query);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();

    const proposals = await listAssumptionProposals(request.db, context.organizationId, id, {
      status: query.status ?? null,
    });
    const input = await buildModelInput(request.db, context.organizationId, id);

    return {
      proposals: proposals.map((proposal) => {
        const current = resolveAssumptionValue(
          input as unknown as Record<string, unknown>,
          proposal.target,
        );
        const applicable = describeTarget(proposal.target);
        return {
          ...proposal,
          /** The underwritten value, or null when this release cannot locate it. */
          current,
          /**
           * Whether accepting could write it. A proposal about something this
           * release does not model is still shown — information about a gap is
           * information — but the accept button has to tell the truth about
           * what it can do.
           */
          applicable: applicable.ok,
          applicableReason: applicable.ok ? null : applicable.reason,
        };
      }),
    };
  });

  /**
   * The decision. Accepting applies the value; rejecting records that it did
   * not.
   *
   * Accepting and applying share one transaction. Splitting them would allow a
   * proposal marked accepted whose value never reached the model — a lie that
   * is invisible on both screens that would show it.
   */
  app.post('/models/:id/assumption-proposals/:proposalId/decision', async (request) => {
    const context = requireCapability(request, 'model:write');
    const params = z
      .object({ id: z.string().uuid(), proposalId: z.string().uuid() })
      .parse(request.params);
    const body = z
      .object({ decision: assumptionDecisionEnum, note: z.string().max(2000).nullish() })
      .parse(request.body);

    const model = await getModel(request.db, context.organizationId, params.id);
    if (!model) throw notFound();

    const proposal = await getAssumptionProposal(
      request.db,
      context.organizationId,
      params.proposalId,
    );
    if (!proposal || proposal.model_id !== params.id) {
      throw notFound('That proposal does not exist on this model.');
    }
    if (proposal.status !== 'pending') {
      throw badRequest(
        `This proposal was already ${proposal.status}. A decision is recorded once; ` +
          'change the assumption directly if you have changed your mind.',
      );
    }

    if (body.decision === 'accepted') {
      assertEditable(model.status);
      if (proposal.value === null) {
        throw unprocessable(
          'This proposal is a remark rather than a figure, so there is nothing to apply. ' +
            'Reject it with a note, or act on it by editing the assumption yourself.',
        );
      }
      const target = describeTarget(proposal.target);
      if (!target.ok) throw unprocessable(target.reason);
    }

    const decided = await request.db.begin(async (tx) => {
      const row = await decideAssumptionProposal(tx as unknown as Sql, {
        organizationId: context.organizationId,
        id: params.proposalId,
        decision: body.decision,
        userId: context.userId,
        note: body.note ?? null,
      });
      // Null means somebody else decided it between the read above and this
      // update. Rolling back is right: the alternative applies the value twice.
      if (!row) {
        throw badRequest(
          'Somebody else decided this proposal a moment ago. Reload to see what they chose.',
        );
      }
      if (body.decision === 'accepted' && row.value !== null) {
        await applyAssumption(tx as unknown as Sql, params.id, row.target, row.value);
      }
      return row;
    });

    await writeAudit(request.db, {
      organizationId: context.organizationId,
      userId: context.userId,
      action: `assumption_proposal.${body.decision}`,
      entityType: 'assumption_proposal',
      entityId: params.proposalId,
      modelId: params.id,
      propertyId: model.property_id,
      previousValue: { target: proposal.target, value: proposal.value },
      newValue: { decision: body.decision, note: body.note ?? null },
      metadata: { sourceName: proposal.source_name, sourceKind: proposal.source_kind },
      ipAddress: request.ip,
    });

    return { proposal: decided, applied: body.decision === 'accepted' };
  });
}

/* -------------------------------------------------------------------------- */
/* Applying an accepted value                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Model-level assumptions an acceptance may write, and their columns.
 *
 * An allowlist, not a derivation. The column name is interpolated into SQL, so
 * it must come from this file and never from a proposal; and confining it to
 * the numeric assumptions keeps the contract's single `value` field honest —
 * a decimal string cannot express a fiscal-year convention or a sale month,
 * and pretending otherwise would turn a parse failure into a wrong model.
 */
const MODEL_COLUMNS: Record<string, string> = {
  'valuation.discountRate': 'discount_rate',
  'valuation.terminalCapRate': 'terminal_cap_rate',
  'valuation.saleCostPercent': 'sale_cost_percent',
  'valuation.grossSalePriceOverride': 'gross_sale_price_override',
  'valuation.directCapRate': 'direct_cap_rate',
  'valuation.directCapAdjustments': 'direct_cap_adjustments',
  'valuation.acquisitionPrice': 'acquisition_price',
  'valuation.acquisitionCosts': 'acquisition_costs',
  'vacancy.generalVacancyRate': 'general_vacancy_rate',
  'vacancy.creditLossRate': 'credit_loss_rate',
};

/**
 * Collections an acceptance may write, and the table and writer for each.
 *
 * The write goes through the same `upsert` a person's edit uses, with the
 * proposed field merged onto the stored row. That is deliberate: it means an
 * accepted proposal cannot clear a recovery structure, a draw schedule or a
 * custom monthly profile that the contract knows nothing about, and it means
 * an invalid value is refused by the collection's own schema rather than
 * landing in a column.
 */
const COLLECTIONS: Record<
  string,
  {
    table: string;
    upsert: (
      db: Sql,
      modelId: string,
      body: Record<string, unknown>,
    ) => Promise<{ id: string; version: number }>;
  }
> = {
  expenses: {
    table: 'operating_expenses',
    upsert: (db, modelId, body) =>
      upsertExpense(db, { ...body, modelId } as Parameters<typeof upsertExpense>[1]),
  },
  otherRevenue: {
    table: 'other_revenue_items',
    upsert: (db, modelId, body) =>
      upsertOtherRevenue(db, { ...body, modelId } as Parameters<typeof upsertOtherRevenue>[1]),
  },
  capital: {
    table: 'capital_items',
    upsert: (db, modelId, body) =>
      upsertCapitalItem(db, { ...body, modelId } as Parameters<typeof upsertCapitalItem>[1]),
  },
  debt: {
    table: 'debt_facilities',
    upsert: (db, modelId, body) =>
      upsertDebtFacility(db, { ...body, modelId } as Parameters<typeof upsertDebtFacility>[1]),
  },
  growthCurves: {
    table: 'growth_curves',
    upsert: (db, modelId, body) =>
      upsertGrowthCurve(db, { ...body, modelId } as Parameters<typeof upsertGrowthCurve>[1]),
  },
  marketLeasing: {
    table: 'market_leasing_profiles',
    upsert: (db, modelId, body) =>
      upsertMarketLeasingProfile(db, { ...body, modelId } as Parameters<
        typeof upsertMarketLeasingProfile
      >[1]),
  },
};

type TargetVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether accepting this target could write anything, and if not, why.
 *
 * Answered without touching the database so the list can say it about every
 * row at once, and so the decision route can refuse before it opens a
 * transaction.
 */
function describeTarget(target: string): TargetVerdict {
  if (MODEL_COLUMNS[target]) return { ok: true };

  const parts = target.split('.');
  const head = parts[0] ?? '';

  if (head === 'leases') {
    return {
      ok: false,
      reason:
        'Lease terms are not applied through this contract. A lease is a document, and a ' +
        'change to one is a change to what was signed — open the rent roll and make it there. ' +
        'The proposal stays on the list either way.',
    };
  }

  // A section the model does have, addressing a field that either is not
  // numeric or is not one it holds. Worth saying differently from a section it
  // has never heard of: the first is a limit of this contract, the second is a
  // limit of the product, and only the second is a gap worth reporting.
  if (parts.length === 2 && MODEL_SECTIONS.has(head)) {
    return {
      ok: false,
      reason:
        `${target} is not one of the numeric assumptions this contract can write. A single ` +
        'decimal value cannot express a convention, a date or a basis, so it is left to you ' +
        'rather than guessed at; the proposal is kept, and rejecting it records that you ' +
        'considered it.',
    };
  }

  if (parts.length >= 3 && COLLECTIONS[head]) return { ok: true };

  return {
    ok: false,
    reason:
      `This release does not model ${target}, so there is nothing to apply it to. That is ` +
      'worth knowing on its own — the proposal is kept rather than discarded.',
  };
}

/** The model-level sections a target may address. See `MODEL_COLUMNS`. */
const MODEL_SECTIONS = new Set(Object.keys(MODEL_COLUMNS).map((key) => key.split('.')[0]));

/**
 * Writes an accepted value into the model.
 *
 * Runs inside the caller's transaction, alongside the decision it belongs to.
 */
async function applyAssumption(
  tx: Sql,
  modelId: string,
  target: string,
  value: string,
): Promise<void> {
  const column = MODEL_COLUMNS[target];
  if (column) {
    // `column` is a literal from MODEL_COLUMNS above; `value` and `modelId` are
    // bound parameters. The cast is what refuses a non-numeric value.
    await tx.unsafe(
      `UPDATE models SET ${column} = $1::numeric, version = version + 1, updated_at = now()
       WHERE id = $2`,
      [value, modelId],
    );
    return;
  }

  const parts = target.split('.');
  const [head, code] = [parts[0] ?? '', parts[1] ?? ''];
  const field = parts.slice(2).join('.');
  const collection = COLLECTIONS[head];
  if (!collection || !code || !field) {
    // Unreachable: the route checks `describeTarget` first. Kept because an
    // unchecked path here would write to the wrong row rather than fail.
    throw unprocessable(`${target} cannot be applied automatically.`);
  }

  const rows = (await tx.unsafe(
    `SELECT * FROM ${collection.table} WHERE model_id = $1 AND code = $2 FOR UPDATE`,
    [modelId, code],
  )) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) {
    throw unprocessable(
      `${code} is not in this model, so ${target} has nowhere to go. It may have been renamed ` +
        'or deleted since the proposal was made.',
    );
  }

  await collection.upsert(tx, modelId, { ...toCamelCase(row), [field]: value, code });
}

/**
 * Rows come back snake_cased; every `upsert` takes camelCase.
 *
 * The same normalisation the batch collection write does, and for the same
 * reason: a `DATE` column arrives as a `Date`, and handing that back to an
 * upsert that expects `YYYY-MM-DD` writes a timestamp.
 */
function toCamelCase(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    out[camel] =
      value instanceof Date ? (value.toISOString().split('T')[0] as string) : (value as unknown);
  }
  return out;
}
