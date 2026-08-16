import { findTransition } from '@cre/domain-models';
import { api } from '../api.js';
import { EmptyState, ErrorMessage, Loading } from '../components.js';
import { CommentThread } from '../components/CommentThread.js';
import { titleCase } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useSession } from '../session.js';
import { FindingRow, type HealthResponse } from './HealthTab.js';
import { useModelContext } from './ModelWorkspace.js';
import { VersionComparison } from './SupportTabs.js';

/**
 * The review screen: status, what changed, health warnings and the
 * conversation about all three, in one place instead of three separate tabs
 * (Versions for status and the version list, Health for warnings, Review for
 * comments only). Nothing here is a second source of truth — every card
 * reads the same endpoints those tabs already use (`GET /models/:id/health`,
 * `GET /models/:id/versions`, `POST /models/:id/transition`,
 * `CommentThread`), so this screen can never disagree with what a reader
 * would find by visiting them directly. `VersionsTab` keeps the full version
 * list, manual snapshotting, and pick-any-two comparison — the approval
 * workflow itself moved here, since deciding a model's status is a review
 * action, not a version-history one.
 */
export function ReviewTab(): JSX.Element {
  const { model } = useModelContext();
  return (
    <>
      <ApprovalWorkflowCard />
      <HealthSummaryCard />
      <RecentChanges />
      <CommentThread entityType="model" entityId={model.id} title="Comments on this model" />
    </>
  );
}

const NEXT: Record<string, Array<{ to: string; label: string }>> = {
  draft: [{ to: 'analyst_review', label: 'Submit for analyst review' }],
  analyst_review: [
    { to: 'manager_review', label: 'Send to manager review' },
    { to: 'draft', label: 'Return to draft' },
  ],
  manager_review: [
    { to: 'approved', label: 'Approve' },
    { to: 'draft', label: 'Reject and return to draft' },
  ],
  approved: [
    { to: 'published', label: 'Publish' },
    { to: 'draft', label: 'Withdraw approval' },
  ],
  published: [
    { to: 'superseded', label: 'Mark superseded' },
    { to: 'archived', label: 'Archive' },
  ],
  superseded: [{ to: 'archived', label: 'Archive' }],
};

function ApprovalWorkflowCard(): JSX.Element {
  const { model } = useModelContext();
  const { can } = useSession();
  const transition = useMutation(async (to: string) =>
    api.post(`/models/${model.id}/transition`, { to }),
  );

  return (
    <div className="card">
      <h2>Approval workflow</h2>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Approving a model snapshots its exact engine input, so the approved numbers can be
        reproduced later even after the live model moves on. Approved and published models are
        read-only.
      </p>
      <ErrorMessage error={transition.error} />
      <div className="row">
        {(NEXT[model.status] ?? []).map((option) => {
          // Each edge names the capability it actually requires server-side
          // (submit, approve, or publish); a reader who can only view the
          // model should not see an enabled "Approve" or "Publish" button
          // that the server is only going to refuse.
          const edge = findTransition(model.status, option.to);
          const allowed = edge ? can(edge.capability) : false;
          return (
            <button
              key={option.to}
              type="button"
              className={option.to === 'approved' || option.to === 'published' ? 'primary' : ''}
              disabled={transition.pending || !allowed}
              title={allowed ? undefined : 'You do not have permission to make this change.'}
              onClick={async () => {
                if (await transition.run(option.to)) window.location.reload();
              }}
            >
              {option.label}
            </button>
          );
        })}
        {(NEXT[model.status] ?? []).length === 0 && (
          <span style={{ color: 'var(--text-muted)' }}>
            This model is {titleCase(model.status).toLowerCase()}; there is no further transition.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A compact reading of `GET /models/:id/health`: counts and the findings
 * that actually need attention. The full driver-ranking panel stays on the
 * Health tab, which this links to rather than duplicating — that panel runs
 * its own engine passes on request and belongs where an analyst goes to dig
 * in, not in a screen meant to be read at a glance.
 */
function HealthSummaryCard(): JSX.Element {
  const { model } = useModelContext();
  const health = useResource<HealthResponse>(`/models/${model.id}/health`);

  if (health.loading) return <Loading label="Assessing the model" />;

  if (health.error) {
    return (
      <div className="card">
        <h2>Model health</h2>
        {health.error.status === 422 ? (
          <div className="message info">
            Not calculated yet. Health findings read the model&rsquo;s own stored calculation, so
            there is nothing to assess until it has run once.
          </div>
        ) : (
          <ErrorMessage error={health.error} />
        )}
      </div>
    );
  }

  const findings = health.data?.findings ?? [];
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  const notes = findings.filter((finding) => finding.severity === 'note');
  const passes = findings.filter((finding) => finding.severity === 'pass');

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Model health</h2>
        {warnings.length > 0 && (
          <span className="badge negative">
            {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </span>
        )}
        {notes.length > 0 && <span className="badge warning">{notes.length} to note</span>}
        <span className="badge positive">{passes.length} checks passed</span>
      </div>

      {warnings.length === 0 && notes.length === 0 ? (
        <div className="message info">
          Nothing crossed a threshold. Open the Health tab for the full list of checks that passed
          and the key value drivers.
        </div>
      ) : (
        <ul className="finding-list">
          {[...warnings, ...notes].map((finding) => (
            <FindingRow key={finding.id} finding={finding} modelId={model.id} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface VersionSummary {
  id: string;
  version_number: number;
}

/**
 * The two most recent versions, compared automatically -- the "changes" a
 * consolidated review screen is supposed to show without asking a reviewer
 * to go find and tick two checkboxes first. `VersionsTab` still holds the
 * full history and lets any two versions be picked by hand; this is only
 * the default a reviewer almost always wants: what moved since last time.
 */
function RecentChanges(): JSX.Element {
  const { model } = useModelContext();
  const versions = useResource<{ versions: VersionSummary[] }>(`/models/${model.id}/versions`);

  if (versions.loading) return <Loading label="Loading versions" />;
  if (versions.error) return <ErrorMessage error={versions.error} />;

  const ordered = [...(versions.data?.versions ?? [])].sort(
    (a, b) => b.version_number - a.version_number,
  );
  const [after, before] = ordered;

  if (!before || !after) {
    return (
      <div className="card">
        <h2>What changed</h2>
        <EmptyState title="Not enough versions yet">
          A version freezes the model&rsquo;s exact engine input. Snapshot one from the Versions
          tab, edit an assumption, and snapshot again to see a comparison here.
        </EmptyState>
      </div>
    );
  }

  return <VersionComparison modelId={model.id} beforeId={before.id} afterId={after.id} />;
}
