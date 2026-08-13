import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import {
  api,
  type CalculateResponse,
  type CashFlowResponse,
  type Model,
  type Property,
} from '../api.js';
import { EmptyState, ErrorMessage, FavouriteButton, Loading, StatusBadge } from '../components.js';
import { formatDate, titleCase } from '../format.js';
import { useMutation, useResource, useShortcut } from '../hooks.js';
import { recordRecent } from '../recents.js';
import { useSession } from '../session.js';

export interface ModelContext {
  model: Model;
  property: Property | null;
  cashFlow: CashFlowResponse | null;
  cashFlowError: string | null;
  reloadCashFlow: () => void;
  /**
   * Folds a fresher `Model` — typically a save's own response — back into
   * the workspace in place, no refetch. In particular this is how
   * `model.version` (the optimistic-concurrency token `ValuationAssumptions`
   * sends back as `expectedVersion`) stays current after a save: `PATCH
   * /models/:id` increments `version` on every write, and without this, a
   * second assumptions save in the same visit sends the version the tab
   * opened with — one behind the version its own first save just produced —
   * and the server refuses it as a conflict with a phantom other editor.
   * Deliberately not `modelResource.reload()`: that re-enters `loading`,
   * which this component treats as "unmount the Outlet," discarding
   * whatever tab — assumptions form included — was open when the save that
   * triggered it landed.
   */
  updateModel: (model: Model) => void;
  calculate: (withTrace: boolean) => Promise<void>;
  calculating: boolean;
}

export function useModelContext(): ModelContext {
  return useOutletContext<ModelContext>();
}

const TABS = [
  { to: '.', label: 'Cash flow', end: true },
  { to: 'rent-roll', label: 'Rent roll' },
  { to: 'assumptions', label: 'Assumptions' },
  { to: 'assumption-import', label: 'Assumption import' },
  { to: 'returns', label: 'Returns and debt' },
  { to: 'health', label: 'Health' },
  { to: 'ic-summary', label: 'IC summary' },
  { to: 'provenance', label: 'Provenance' },
  { to: 'scenarios', label: 'Scenarios' },
  { to: 'budgets', label: 'Budgets' },
  { to: 'validation', label: 'Validation' },
  { to: 'imports', label: 'Imports' },
  { to: 'reports', label: 'Reports' },
  { to: 'versions', label: 'Versions' },
  { to: 'review', label: 'Review' },
];

export function ModelWorkspace(): JSX.Element {
  const { modelId } = useParams<{ modelId: string }>();
  const { can, session } = useSession();
  const [banner, setBanner] = useState<string | null>(null);

  const modelResource = useResource<{ model: Model; property: Property | null }>(
    modelId ? `/models/${modelId}` : null,
  );
  const cashFlowResource = useResource<CashFlowResponse>(
    modelId ? `/models/${modelId}/cashflow` : null,
  );

  const visitedModel = modelResource.data?.model;
  useEffect(() => {
    if (!visitedModel || !session?.user.id || !session.organizationId) return;
    recordRecent(session.user.id, session.organizationId, {
      entityType: 'model',
      entityId: visitedModel.id,
      name: visitedModel.name,
      context: modelResource.data?.property?.name ?? null,
    });
    // Deliberately keyed on the id alone: recorded once per visit, not on
    // every render the model's other fields happen to reflow through.
  }, [visitedModel?.id, session?.user.id, session?.organizationId]);

  const calculation = useMutation(async (withTrace: boolean) =>
    api.post<CalculateResponse>(`/models/${modelId}/calculate`, { withTrace }),
  );

  const calculate = useCallback(
    async (withTrace: boolean) => {
      const result = await calculation.run(withTrace);
      if (result) {
        const errors = result.diagnostics.filter((entry) => entry.severity === 'error').length;
        setBanner(
          errors > 0
            ? `Calculated with ${errors} critical error${errors === 1 ? '' : 's'}. Open the Validation tab.`
            : `Calculated with engine ${result.engineVersion}.`,
        );
        cashFlowResource.reload();
      }
    },
    // Deps are listed deliberately; see the comment above.
    [calculation.run, cashFlowResource.reload],
  );

  // Recalculate without leaving the keyboard, the way an analyst works.
  useShortcut('enter', () => void calculate(true));

  const updateModel = useCallback(
    (next: Model) =>
      modelResource.setData((current) => (current ? { ...current, model: next } : current)),
    [modelResource.setData],
  );

  if (modelResource.loading) return <Loading label="Loading model" />;
  if (modelResource.error) return <ErrorMessage error={modelResource.error} />;
  if (!modelResource.data)
    return <EmptyState title="Not found">That model does not exist.</EmptyState>;

  const { model, property } = modelResource.data;

  const context: ModelContext = {
    model,
    property,
    cashFlow: cashFlowResource.data,
    cashFlowError:
      cashFlowResource.error && cashFlowResource.error.status === 422
        ? cashFlowResource.error.message
        : null,
    reloadCashFlow: cashFlowResource.reload,
    updateModel,
    calculate,
    calculating: calculation.pending,
  };

  return (
    <>
      <div className="page-title">
        <div>
          <h1>
            <FavouriteButton entityType="model" entityId={model.id} name={model.name} />
            {model.name}
          </h1>
          <p>
            {property?.name ?? 'Property'} · {titleCase(model.classification)} · valued{' '}
            {formatDate(model.valuation_date)} · {model.forecast_months} month forecast from{' '}
            {formatDate(model.forecast_start_date)}
          </p>
        </div>
        <div className="row">
          <StatusBadge status={model.status} />
          {can('model:calculate') && (
            <button
              type="button"
              className="primary"
              onClick={() => void calculate(true)}
              disabled={calculation.pending}
              title="Recalculate with a trace (Ctrl/Cmd + Enter)"
            >
              {calculation.pending ? 'Calculating…' : 'Calculate'}
            </button>
          )}
        </div>
      </div>

      {banner && (
        <div
          className={`message ${banner.includes('error') ? 'error' : 'info'}`}
          role="status"
          aria-label="Model status"
        >
          {banner}
        </div>
      )}
      <ErrorMessage error={calculation.error} />

      <nav className="tabs" aria-label="Model sections">
        {TABS.map((tab) => (
          <NavLink key={tab.label} to={tab.to} end={tab.end}>
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet context={context} />
    </>
  );
}
