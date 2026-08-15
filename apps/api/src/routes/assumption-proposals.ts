import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '@cre/database';
import {
  buildModelInput,
  decideAssumptionProposal,
  getAssumptionProposal,
  getModel,
  listAssumptionProposals,
  listPendingAssumptionProposalsForOrganization,
  recordAssumptionProposals,
  writeAudit,
} from '@cre/database';
import {
  assumptionDecisionEnum,
  assumptionProposalBatchSchema,
  describeTarget,
  resolveAssumptionValue,
  validateTypedValue,
} from '@cre/domain-models';
import { badRequest, forbidden, notFound, requireCapability, unprocessable } from '../context.js';
import { assertEditable } from './models.js';
import { applyAssumption, AssumptionApplyError } from '../assumption-write.js';

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
 *
 * `target`, `value` and `valueType` resolution now lives in
 * `@cre/domain-models`'s target registry, shared with the PDF-assumption
 * import pipeline (`docs/claude-assumption-import.md`) so the two cannot
 * disagree about what this contract can write.
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
      .object({
        status: z.enum(['pending', 'accepted', 'rejected', 'superseded']).optional(),
        importSessionId: z.string().uuid().optional(),
      })
      .parse(request.query);

    const model = await getModel(request.db, context.organizationId, id);
    if (!model) throw notFound();

    const proposals = await listAssumptionProposals(request.db, context.organizationId, id, {
      status: query.status ?? null,
      importSessionId: query.importSessionId ?? null,
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
   * Every pending proposal across the whole organization, oldest first — the
   * queue behind the per-model list above. A reviewer who wants to know what
   * needs deciding today should not have to already know which model to
   * check; this is that answer, meant for the dashboard.
   *
   * Read-only: deciding still only ever happens through the per-model
   * decision route, gated on `model:write` there. This route is gated on the
   * weaker `model:read`, the same as the per-model list, since it shows
   * nothing a `model:read` holder could not already see by opening each
   * model's own Provenance tab in turn.
   */
  app.get('/organizations/:id/assumption-proposals/pending', async (request) => {
    const context = requireCapability(request, 'model:read');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (id !== context.organizationId) {
      throw forbidden('You can only see decisions for the organization you are signed in to.');
    }

    const rows = await listPendingAssumptionProposalsForOrganization(request.db, id);

    // One buildModelInput call per distinct model behind the queue, not one
    // per proposal: several pending proposals commonly land on the same
    // model (a source reporting several assumptions at once), and the input
    // it is compared against does not change between them.
    const modelIds = [...new Set(rows.map((row) => row.model_id))];
    const inputs = new Map(
      await Promise.all(
        modelIds.map(
          async (modelId) => [modelId, await buildModelInput(request.db, id, modelId)] as const,
        ),
      ),
    );

    return {
      proposals: rows.map((row) => {
        const input = inputs.get(row.model_id);
        const current = input
          ? resolveAssumptionValue(input as unknown as Record<string, unknown>, row.target)
          : null;
        const applicable = describeTarget(row.target);
        return {
          ...row,
          current,
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
      // Re-checked against the target's own real shape, not the value type
      // the proposal merely declared when it arrived: `assumptionProposalInputSchema`
      // deliberately cannot check this at creation time (`target` is free
      // text there — see its own module doc), so an `'enum'` value in
      // particular was, until this check existed, only confirmed to be
      // non-empty text, never confirmed to be one of the target's actual
      // allowed values. Accepting a proposal is the one point this contract
      // ever writes anything, so it is the one point that has to catch a
      // mistyped or stale value before the write, rather than leaving the
      // model uncalculable until someone finds and repairs the row by hand.
      const shapeProblem = validateTypedValue(
        proposal.value,
        target.descriptor.valueType,
        target.descriptor.enumValues,
      );
      if (shapeProblem) {
        throw unprocessable(`${proposal.target}: ${shapeProblem}`);
      }
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
        try {
          await applyAssumption(
            tx as unknown as Sql,
            params.id,
            row.target,
            row.value,
            row.value_type,
          );
        } catch (error) {
          if (error instanceof AssumptionApplyError) throw unprocessable(error.message);
          throw error;
        }
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
