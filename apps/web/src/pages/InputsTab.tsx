import { Link } from 'react-router-dom';
import type { WorkflowResponse, WorkflowStep } from '../api.js';
import { EmptyState, ErrorMessage, Loading } from '../components.js';
import { useResource } from '../hooks.js';
import { useModelContext } from './ModelWorkspace.js';

/**
 * Inputs: the one place to see what data this model has and where to add
 * more, instead of guessing which of four separate tabs (Rent roll,
 * Assumptions, Assumption import, Imports) handles a given kind of input.
 *
 * Reuses `GET /models/:id/workflow` — the exact same data the progress
 * strip above every tab already shows — rather than adding a second source
 * of truth for what counts as "has this model got a rent roll yet." This
 * tab's own job is only to turn that into entry points: a status per input
 * area and a way to go add more of it.
 *
 * Every card's own call-to-action deliberately avoids repeating an existing
 * tab's exact accessible name ("Rent roll", "Assumptions", "Assumption
 * import", "Imports" are all real tabs in `ModelWorkspace.tsx`'s `TABS`) —
 * see that file's own `WorkflowProgress` for why a second element sharing
 * an existing tab's exact name breaks every test in this suite that finds
 * a tab by role and name.
 */
interface InputCard {
  key: string;
  title: string;
  description: string;
  tab: string;
  ctaLabel: string;
  step?: WorkflowStep;
}

export function InputsTab(): JSX.Element {
  const { model } = useModelContext();
  const workflow = useResource<WorkflowResponse>(`/models/${model.id}/workflow`);

  if (workflow.loading) return <Loading label="Loading inputs" />;
  if (workflow.error) return <ErrorMessage error={workflow.error} />;
  if (!workflow.data) return <EmptyState title="Not found">No workflow data.</EmptyState>;

  const step = (key: string): WorkflowStep | undefined =>
    workflow.data?.steps.find((entry) => entry.key === key);

  const cards: InputCard[] = [
    {
      key: 'rent_roll',
      title: 'Rent Roll',
      description: 'Tenants, leases, rent steps and rollover assumptions.',
      tab: 'rent-roll',
      ctaLabel: 'Open the leasing screen',
      step: step('rent_roll'),
    },
    {
      key: 'operating',
      title: 'Operating',
      description: 'Recurring operating expenses: taxes, insurance, utilities, management fees.',
      tab: 'assumptions',
      ctaLabel: 'Open the operating expense editor',
      step: step('operating'),
    },
    {
      key: 'capital',
      title: 'Capital',
      description: 'Capital expenditure: reserves, major projects, deferred maintenance.',
      tab: 'assumptions',
      ctaLabel: 'Open the capital items editor',
      step: step('capital'),
    },
    {
      key: 'debt',
      title: 'Debt',
      description: 'Debt facilities: commitment, rate, amortization, covenants.',
      tab: 'assumptions',
      ctaLabel: 'Open the debt facilities editor',
      step: step('debt'),
    },
    {
      key: 'assumption_import',
      title: 'Assumption Extract',
      description:
        'Paste a structured extract from a PDF, offering memorandum or other document — the assumptions it recognizes are shown beside the model’s current values so each one can be reviewed before anything changes.',
      tab: 'assumption-import',
      ctaLabel: 'Open the document-extract importer',
      step: step('imports'),
    },
    {
      key: 'workbook_import',
      title: 'Rent Roll Spreadsheet',
      description: 'Upload a CSV or Excel rent roll and map its columns to leases.',
      tab: 'imports',
      ctaLabel: 'Open the spreadsheet importer',
    },
  ];

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Inputs</h1>
          <p>What this model has, and where to add more.</p>
        </div>
      </div>

      <div className="metric-grid">
        {cards.map((card) => (
          <article key={card.key} className="card">
            <h2 style={{ marginTop: 0 }}>{card.title}</h2>
            <p className="field-hint">{card.description}</p>
            {card.step && (
              <p>
                <span className={`badge ${card.step.done ? 'positive' : ''}`}>
                  {card.step.done ? 'Done' : card.step.optional ? 'Optional' : 'Not started'}
                </span>{' '}
                {card.step.detail}
              </p>
            )}
            <Link
              to={`/models/${model.id}/${card.tab}`}
              className="button"
              aria-label={card.ctaLabel}
            >
              Open
            </Link>
          </article>
        ))}
      </div>
    </>
  );
}
