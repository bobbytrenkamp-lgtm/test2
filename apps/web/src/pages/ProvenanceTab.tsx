import { useState } from 'react';
import { api } from '../api.js';
import { EmptyState, ErrorMessage, Loading } from '../components.js';
import { formatDateTime, formatNumber, formatPercent } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useModelContext } from './ModelWorkspace.js';

/**
 * What other systems believe about this model, and what was decided about it.
 *
 * Outside sources — a market-data service, a research tool, an import from a
 * commissioned valuation — can say what they think an assumption should be.
 * None of it is in the model. Each proposal sits next to the number that *is*,
 * with the difference stated, until somebody chooses.
 *
 * The screen is built around that choice rather than around the data. A source
 * saying 2.70% where the model says 3.00% is not a correction and must not look
 * like one: the analyst is the one who has to defend the model, and the point
 * of showing the difference is to make the 3.00% a decision rather than an
 * oversight. Keeping it is a legitimate answer and is recorded as one.
 */

interface Proposal {
  id: string;
  target: string;
  value: string | null;
  source_kind: string;
  source_name: string;
  confidence: string | null;
  observed_at: string | null;
  evidence: Record<string, unknown>;
  notes: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  current: string | null;
  applicable: boolean;
  applicableReason: string | null;
}

const SOURCE_LABELS: Record<string, string> = {
  user: 'Entered by a person',
  imported: 'Imported from a file',
  historical: 'The property’s own history',
  market_data: 'Market data',
  calculated: 'Calculated elsewhere',
  recommended: 'Recommendation',
};

export function ProvenanceTab(): JSX.Element {
  const { model } = useModelContext();
  const [showDecided, setShowDecided] = useState(false);
  const proposals = useResource<{ proposals: Proposal[] }>(
    `/models/${model.id}/assumption-proposals`,
  );

  const decide = useMutation(
    async (id: string, decision: 'accepted' | 'rejected', note: string | null) => {
      await api.post(`/models/${model.id}/assumption-proposals/${id}/decision`, {
        decision,
        ...(note ? { note } : {}),
      });
      proposals.reload();
    },
  );

  if (proposals.loading) return <Loading label="Loading proposals" />;

  const all = proposals.data?.proposals ?? [];
  const pending = all.filter((proposal) => proposal.status === 'pending');
  const decided = all.filter((proposal) => proposal.status !== 'pending');

  return (
    <>
      <ErrorMessage error={proposals.error} />
      <ErrorMessage error={decide.error} />

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Assumptions proposed from outside</h2>
          {pending.length > 0 && <span className="badge warning">{pending.length} to decide</span>}
        </div>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Nothing on this page is in the model. Another system can say what it believes an
          assumption should be; it cannot change one. Accepting writes the value and records who did
          it, and keeping your own is recorded too — “we saw the market number and stayed at 3.00%”
          is a position worth being able to show later.
        </p>

        {pending.length === 0 ? (
          <EmptyState title="Nothing waiting on a decision">
            When a connected system reports a view on one of this model’s assumptions, it appears
            here beside the number you underwrote. Sources post to{' '}
            <code>POST /models/{model.id}/assumption-proposals</code>; the shape is in
            docs/assumption-contract.md.
          </EmptyState>
        ) : (
          <ul className="proposal-list">
            {pending.map((proposal) => (
              <ProposalRow
                key={proposal.id}
                proposal={proposal}
                pending={decide.pending}
                onDecide={(decision, note) => void decide.run(proposal.id, decision, note)}
              />
            ))}
          </ul>
        )}
      </div>

      {decided.length > 0 && (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Decisions already made</h2>
            <div className="spacer" />
            <button type="button" onClick={() => setShowDecided((value) => !value)}>
              {showDecided ? 'Hide' : `Show ${decided.length}`}
            </button>
          </div>
          <p className="field-hint" style={{ marginTop: 0 }}>
            Kept rather than cleared. A rejection is the evidence that the alternative was
            considered, which is the question a reviewer actually asks.
          </p>
          {showDecided && (
            <ul className="proposal-list">
              {decided.map((proposal) => (
                <ProposalRow key={proposal.id} proposal={proposal} pending={false} />
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

function ProposalRow({
  proposal,
  pending,
  onDecide,
}: {
  proposal: Proposal;
  pending: boolean;
  onDecide?: (decision: 'accepted' | 'rejected', note: string | null) => void;
}): JSX.Element {
  const [note, setNote] = useState('');
  const difference = differenceOf(proposal.current, proposal.value);

  return (
    <li className="proposal">
      <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
        <strong>{describeTarget(proposal.target)}</strong>
        <span className="badge">{SOURCE_LABELS[proposal.source_kind] ?? proposal.source_kind}</span>
        {proposal.status !== 'pending' && (
          <span className={`badge ${proposal.status === 'accepted' ? 'positive' : 'warning'}`}>
            {proposal.status === 'accepted'
              ? 'Applied'
              : proposal.status === 'rejected'
                ? 'Kept your own'
                : 'Superseded'}
          </span>
        )}
      </div>

      <dl className="proposal-values">
        <div>
          <dt>Underwritten</dt>
          <dd>{present(proposal.target, proposal.current)}</dd>
        </div>
        <div>
          <dt>{proposal.source_name} proposes</dt>
          <dd>{present(proposal.target, proposal.value)}</dd>
        </div>
        <div>
          <dt>Difference</dt>
          <dd>{difference === null ? '—' : present(proposal.target, difference, true)}</dd>
        </div>
        <div>
          <dt>Stated confidence</dt>
          {/* Absent is not zero: most sources cannot state one, and showing 0%
              would report a certainty of none where none was claimed. */}
          <dd>
            {proposal.confidence === null ? 'Not stated' : formatPercent(proposal.confidence, 0)}
          </dd>
        </div>
      </dl>

      <p className="field-hint" style={{ marginTop: 0 }}>
        {proposal.observed_at
          ? `Observed ${formatDateTime(proposal.observed_at)}, received ${formatDateTime(proposal.created_at)}.`
          : `Received ${formatDateTime(proposal.created_at)}. The source did not say when it observed this.`}{' '}
        Target <code>{proposal.target}</code>.
      </p>

      {proposal.notes && <p>{proposal.notes}</p>}

      {Object.keys(proposal.evidence).length > 0 && (
        <details>
          <summary>What the source showed</summary>
          {/* Rendered as given and never parsed for meaning, so a source can
              show its working without this screen having to know the shape. */}
          <pre className="evidence">{JSON.stringify(proposal.evidence, null, 2)}</pre>
        </details>
      )}

      {!proposal.applicable && proposal.status === 'pending' && (
        <div className="message info">{proposal.applicableReason}</div>
      )}

      {proposal.status !== 'pending' && (
        <p className="field-hint">
          {proposal.status === 'accepted'
            ? 'Applied to the model'
            : proposal.status === 'rejected'
              ? 'Considered and not applied'
              : 'Replaced by a later report from the same source'}
          {proposal.decided_at ? ` on ${formatDateTime(proposal.decided_at)}` : ''}
          {proposal.decision_note ? `. “${proposal.decision_note}”` : '.'}
        </p>
      )}

      {onDecide && (
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <label className="visually-hidden" htmlFor={`note-${proposal.id}`}>
            Why, for {describeTarget(proposal.target)}
          </label>
          <input
            id={`note-${proposal.id}`}
            value={note}
            placeholder="Why (optional, and the part a reviewer reads)"
            onChange={(event) => setNote(event.target.value)}
            style={{ flex: '1 1 320px' }}
          />
          <button
            type="button"
            className="primary"
            disabled={pending || !proposal.applicable}
            onClick={() => onDecide('accepted', note || null)}
          >
            Apply {present(proposal.target, proposal.value)}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onDecide('rejected', note || null)}
          >
            Keep {present(proposal.target, proposal.current)}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * A dotted target as a phrase.
 *
 * Presentation only. The target is matched against the model by the server;
 * this is what a person reads, and getting it wrong costs a clumsy label rather
 * than a wrong number.
 */
export function describeTarget(target: string): string {
  const parts = target.split('.');
  const field = parts[parts.length - 1] ?? target;
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const scope = parts.length >= 3 ? ` (${parts[1]})` : '';
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${scope}`;
}

/**
 * Formats a value the way its field is usually read.
 *
 * A heuristic on the *label*, never on the stored value: rates are held and
 * compared as decimal strings whatever this decides to print. Getting it wrong
 * shows 0.03 instead of 3.00%, which is ugly and not misleading — the units are
 * the field's own either way.
 */
function present(target: string, value: string | null, signed = false): string {
  if (value === null) return '—';
  const field = target.split('.').pop() ?? '';
  const isRate = /rate|percent|share|growth|ratio|probability/i.test(field);
  const sign = signed && !value.startsWith('-') ? '+' : '';
  return sign + (isRate ? formatPercent(value) : formatNumber(value, 2));
}

/** Underwritten minus proposed, so a positive number means the model is higher. */
function differenceOf(current: string | null, proposed: string | null): string | null {
  if (current === null || proposed === null) return null;
  const a = Number(current);
  const b = Number(proposed);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // Presentation arithmetic on a difference that is only ever displayed. Every
  // value that reaches the model stays a decimal string and is never routed
  // through here.
  return String(a - b);
}
