import type {
  AssumptionProposal,
  AssumptionProposalInput,
  AssumptionValueType,
} from '@cre/domain-models';
import type { Sql } from '../client.js';

/**
 * Proposals about a model's assumptions, from sources outside the model.
 *
 * Every query is scoped by organization as well as by model, so a caller
 * holding only a proposal identifier cannot read or decide another tenant's.
 *
 * Nothing here writes to a model. Applying an accepted value is the API's job
 * and goes through the same validated write path a person's edit uses — this
 * module records what was proposed and what was decided, and those two are
 * deliberately separate from the value itself.
 */

/** A proposal alongside the model's own value for the same assumption. */
export interface AssumptionProposalRow extends AssumptionProposal {
  source_kind: AssumptionProposal['source_kind'];
}

const COLUMNS = `
  id, model_id, target, value, value_type, source_kind, source_name,
  confidence::text AS confidence,
  to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS observed_at,
  evidence, notes, status,
  to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS decided_at,
  decision_note,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  import_session_id
`;

export async function listAssumptionProposals(
  sql: Sql,
  organizationId: string,
  modelId: string,
  filters: { status?: string | null; importSessionId?: string | null } = {},
): Promise<AssumptionProposalRow[]> {
  return (await sql`
    SELECT ${sql.unsafe(COLUMNS)}
    FROM assumption_proposals
    WHERE model_id = ${modelId}
      AND organization_id = ${organizationId}
      ${filters.status ? sql`AND status = ${filters.status}` : sql``}
      ${filters.importSessionId ? sql`AND import_session_id = ${filters.importSessionId}` : sql``}
    ORDER BY
      -- Undecided first: the list exists to be worked through, and a decided
      -- proposal is history rather than a task.
      (status = 'pending') DESC,
      created_at DESC
  `) as unknown as AssumptionProposalRow[];
}

/** A pending proposal, with enough of its model and property to route to it. */
export interface PendingAssumptionProposalRow extends AssumptionProposalRow {
  model_name: string;
  property_id: string;
  property_name: string;
}

/**
 * Every pending proposal across the whole organization, oldest first.
 *
 * Deciding today lives per model (`listAssumptionProposals` above, on
 * `ProvenanceTab`) — a reviewer who wants to know what is waiting for them has
 * to already know which model to open. This is the other direction: the
 * queue itself, so a reviewer's day can start from "here is what needs
 * deciding" instead of stumbling onto a proposal while looking at a model for
 * an unrelated reason. Oldest first, deliberately: a proposal is worth
 * deciding closer to when it arrived, and FIFO is the ordering that keeps
 * something from aging out of sight at the bottom of a `created_at DESC` list
 * forever.
 */
export async function listPendingAssumptionProposalsForOrganization(
  sql: Sql,
  organizationId: string,
): Promise<PendingAssumptionProposalRow[]> {
  return (await sql`
    SELECT
      ap.id, ap.model_id, ap.target, ap.value, ap.value_type, ap.source_kind, ap.source_name,
      ap.confidence::text AS confidence,
      to_char(ap.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS observed_at,
      ap.evidence, ap.notes, ap.status,
      to_char(ap.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS decided_at,
      ap.decision_note,
      to_char(ap.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
      ap.import_session_id,
      m.name AS model_name,
      p.id AS property_id,
      p.name AS property_name
    FROM assumption_proposals ap
    JOIN models m ON m.id = ap.model_id AND m.deleted_at IS NULL
    JOIN properties p ON p.id = m.property_id AND p.deleted_at IS NULL
    WHERE ap.organization_id = ${organizationId}
      AND ap.status = 'pending'
    ORDER BY ap.created_at ASC
  `) as unknown as PendingAssumptionProposalRow[];
}

export async function getAssumptionProposal(
  sql: Sql,
  organizationId: string,
  id: string,
): Promise<AssumptionProposalRow | null> {
  const rows = (await sql`
    SELECT ${sql.unsafe(COLUMNS)}
    FROM assumption_proposals
    WHERE id = ${id} AND organization_id = ${organizationId}
  `) as unknown as AssumptionProposalRow[];
  return rows[0] ?? null;
}

/**
 * Records a batch of proposals, superseding any the same source still has
 * pending on the same target.
 *
 * A source that reports monthly is stating its current view, not adding to a
 * pile. Left to stack, an analyst returning after a quarter would be asked to
 * decide between four versions of one opinion, three of which the source no
 * longer holds. The superseded rows stay — what a source said in March is
 * still what it said in March — but only the newest is presented as a decision
 * to make. This is also what the table's partial unique index enforces, so
 * getting it wrong here fails loudly rather than quietly duplicating.
 *
 * A proposal from a *different* source on the same target does not supersede
 * anything: two services disagreeing about market rent is information, and
 * collapsing them to whichever wrote last would destroy it.
 *
 * The whole batch is one transaction. A source reporting a model's worth of
 * assumptions has a coherent view of it; half of that view landing would be a
 * position nobody holds.
 */
export async function recordAssumptionProposals(
  sql: Sql,
  input: {
    organizationId: string;
    modelId: string;
    createdBy: string | null;
    proposals: AssumptionProposalInput[];
    /** Set when these proposals were produced by an import rather than posted directly. */
    importSessionId?: string | null;
  },
): Promise<{ recorded: AssumptionProposalRow[]; superseded: number }> {
  return (await sql.begin(async (tx) => {
    let superseded = 0;
    const recorded: AssumptionProposalRow[] = [];

    for (const proposal of input.proposals) {
      const replaced = (await tx`
        UPDATE assumption_proposals
        SET status = 'superseded'
        WHERE model_id = ${input.modelId}
          AND target = ${proposal.target}
          AND source_name = ${proposal.sourceName}
          AND status = 'pending'
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      superseded += replaced.length;

      const rows = (await tx`
        INSERT INTO assumption_proposals (
          organization_id, model_id, target, value, value_type, source_kind, source_name,
          confidence, observed_at, evidence, notes, created_by, import_session_id
        ) VALUES (
          ${input.organizationId}, ${input.modelId}, ${proposal.target},
          ${proposal.value ?? null}, ${proposal.valueType}, ${proposal.sourceKind},
          ${proposal.sourceName}, ${proposal.confidence ?? null},
          ${proposal.observedAt ?? null}::timestamptz,
          ${tx.json(proposal.evidence as never)}, ${proposal.notes ?? null},
          ${input.createdBy}, ${input.importSessionId ?? null}
        )
        RETURNING ${tx.unsafe(COLUMNS)}
      `) as unknown as AssumptionProposalRow[];

      const row = rows[0];
      if (row) recorded.push(row);
    }

    return { recorded, superseded };
  })) as { recorded: AssumptionProposalRow[]; superseded: number };
}

/**
 * Records a decision, and refuses to record a second one.
 *
 * The refusal is the point. Two people opening the list at once must not both
 * "accept" the same proposal, because accepting applies a value to the model:
 * the second acceptance would write the same number twice and, worse, report
 * that it had changed something when the change was already made. Restricting
 * the update to `status = 'pending'` makes that a no-op the caller can detect
 * rather than a silent duplicate.
 */
export async function decideAssumptionProposal(
  sql: Sql,
  input: {
    organizationId: string;
    id: string;
    decision: 'accepted' | 'rejected';
    userId: string | null;
    note?: string | null;
  },
): Promise<AssumptionProposalRow | null> {
  const rows = (await sql`
    UPDATE assumption_proposals
    SET status = ${input.decision},
        decided_by = ${input.userId},
        decided_at = now(),
        decision_note = ${input.note ?? null}
    WHERE id = ${input.id}
      AND organization_id = ${input.organizationId}
      AND status = 'pending'
    RETURNING ${sql.unsafe(COLUMNS)}
  `) as unknown as AssumptionProposalRow[];
  return rows[0] ?? null;
}

/**
 * Records a proposal already accepted, in one step.
 *
 * The PDF-assumption import's bulk apply is the one caller: an analyst who
 * clicked "Apply 36 assumptions" already made the decision for each of them
 * by selecting it on the review screen, so there is no separate pending state
 * to sit in between. This still inserts into the same table a posted
 * proposal does, with `import_session_id` set and `status` already
 * `accepted` — a row here is indistinguishable, once written, from one that
 * went through `recordAssumptionProposals` and then `decideAssumptionProposal`
 * by hand. Applying the value itself is the caller's job, in the same
 * transaction, so the two cannot disagree about whether it happened.
 */
export async function insertDecidedImportProposal(
  sql: Sql,
  input: {
    organizationId: string;
    modelId: string;
    target: string;
    value: string;
    valueType: AssumptionValueType;
    sourceName: string;
    confidence: number | null;
    evidence: Record<string, unknown>;
    notes: string | null;
    createdBy: string | null;
    importSessionId: string;
  },
): Promise<AssumptionProposalRow> {
  const rows = (await sql`
    INSERT INTO assumption_proposals (
      organization_id, model_id, target, value, value_type, source_kind, source_name,
      confidence, evidence, notes, created_by, import_session_id,
      status, decided_by, decided_at, decision_note
    ) VALUES (
      ${input.organizationId}, ${input.modelId}, ${input.target}, ${input.value}, ${input.valueType},
      'imported', ${input.sourceName}, ${input.confidence}, ${sql.json(input.evidence as never)},
      ${input.notes}, ${input.createdBy}, ${input.importSessionId},
      'accepted', ${input.createdBy}, now(), 'Applied through the PDF assumption import.'
    )
    RETURNING ${sql.unsafe(COLUMNS)}
  `) as unknown as AssumptionProposalRow[];
  return rows[0] as AssumptionProposalRow;
}
