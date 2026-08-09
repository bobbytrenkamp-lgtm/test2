import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type CashFlowResponse, type Lease, type TraceResponse } from '../api.js';
import { Loading } from '../components.js';
import { formatCurrency, titleCase } from '../format.js';

/**
 * Where a number came from.
 *
 * Three things a reader wants when they click a figure, in the order they want
 * them:
 *
 * 1. **What made it up.** For a total across tenants, the tenants. This is the
 *    part the previous inspector had no answer for — it went straight to the
 *    engine's trace, which is a log of formula applications and reads like one.
 * 2. **How it was worked out.** The trace: formula, inputs, result, rounding.
 * 3. **What to change to move it.** Links to the lease, expense or facility the
 *    trace names as its source.
 *
 * Nothing here recalculates. Every figure is read from the calculation the
 * server already stored, so what the panel says is what the engine did — an
 * inspector that re-derived a number could agree with the model on Tuesday and
 * disagree on Wednesday, and the reader would have no way to tell which was
 * wrong.
 */

export interface InspectorTarget {
  /** Cash-flow line key, e.g. `expenseRecoveries`. */
  line: string;
  /**
   * The period, **1-based**, matching `PeriodMeta.index` and the trace API.
   * Null for a figure that is not per-period, such as an exit cap rate.
   *
   * One-based rather than an array index because that is the convention the
   * engine's own output and the trace endpoint already use, and translating in
   * two places is how one of them ends up off by one. Anything indexing a
   * series here subtracts one, once, and says so.
   */
  period: number | null;
  /**
   * The last period the figure covers, when it spans several.
   *
   * A fiscal-year column is twelve months, and a recovery settlement is
   * recorded in the month it settles rather than in each month it affects — so
   * asking for the year's first month alone returns no trace and the panel
   * reports, truthfully and uselessly, that there is none.
   */
  periodEnd?: number;
  label: string;
  /** The figure as shown, so the panel can lead with it. */
  value?: string;
}

/** A source the trace named, resolved to something a reader can act on. */
interface ResolvedSource {
  kind: string;
  id: string;
  label: string;
  href?: string;
}

export function CalculationInspector({
  modelId,
  target,
  cashFlow,
  leases,
  currency,
  onClose,
}: {
  modelId: string;
  target: InspectorTarget;
  cashFlow: CashFlowResponse | null;
  leases: Lease[];
  currency: string;
  onClose: () => void;
}): JSX.Element {
  const [state, setState] = useState<{
    loading: boolean;
    entries: TraceResponse['entries'];
    error: string | null;
  }>({ loading: true, entries: [], error: null });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams({ limit: '40' });
    if (target.period !== null) {
      if (target.periodEnd !== undefined && target.periodEnd > target.period) {
        query.set('periodFrom', String(target.period));
        query.set('periodTo', String(target.periodEnd));
      } else {
        query.set('periodIndex', String(target.period));
      }
    }
    const prefix = TRACE_TARGETS[target.line];
    if (prefix) query.set('target', prefix);
    const formulaPrefix = TRACE_FORMULAS[target.line];
    if (formulaPrefix) query.set('formulaPrefix', formulaPrefix);

    let cancelled = false;
    setState({ loading: true, entries: [], error: null });
    api
      .get<TraceResponse>(`/models/${modelId}/trace?${query}`)
      .then((response) => {
        if (cancelled) return;
        setState({ loading: false, entries: response.entries, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          entries: [],
          error:
            error instanceof Error
              ? error.message
              : 'The trace for this calculation could not be loaded.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [modelId, target.line, target.period, target.periodEnd]);

  /*
   * Names for the identifiers the trace refers to.
   *
   * Keyed by **both** the database id and the lease code, because the two
   * appear in different places: `leaseCashFlows` reports a `leaseId`, while a
   * trace source reads `lease:L-CASCADE` — the engine's model input uses codes
   * as its identifiers. Keying on one alone silently resolves half the
   * references and leaves the other half reading like raw data.
   */
  const leaseNames = useMemo(() => {
    const map = new Map<string, { code: string; tenant: string }>();
    for (const lease of leases) {
      const entry = { code: lease.code, tenant: lease.tenant_name ?? '' };
      map.set(lease.id, entry);
      map.set(lease.code, entry);
    }
    return map;
  }, [leases]);

  const components = useMemo(
    () => buildComponents(modelId, target, cashFlow, leaseNames),
    [modelId, target, cashFlow, leaseNames],
  );

  const resolveSource = (source: string): ResolvedSource => {
    const [kind = source, id = ''] = source.split(':');
    if (kind === 'lease') {
      const known = leaseNames.get(id);
      return known
        ? {
            kind,
            id,
            label: `${known.code}${known.tenant ? ` · ${known.tenant}` : ''}`,
            href: `/models/${modelId}/rent-roll?lease=${encodeURIComponent(known.code)}`,
          }
        : {
            kind,
            id,
            /*
             * A speculative lease-up has no lease record to point at — the
             * engine invented it to fill space nothing is contracted for. Say
             * that, rather than showing eight characters of an identifier and
             * leaving the reader to wonder which tenant it is.
             */
            label: id.startsWith('speculative')
              ? 'Speculative lease-up (no contract lease)'
              : `Lease ${id}`,
          };
    }
    const assumptionSegment: Record<string, string> = {
      expense: 'expenses',
      capital: 'capital',
      debt: 'debt',
      profile: 'market-leasing',
      otherRevenue: 'other-revenue',
    };
    const segment = assumptionSegment[kind];
    if (segment) {
      return {
        kind,
        id,
        label: `${titleCase(kind)} ${id.slice(0, 8)}`,
        href: `/models/${modelId}/assumptions?focus=${segment}`,
      };
    }
    return { kind, id, label: source };
  };

  const allSources = useMemo(() => {
    const seen = new Map<string, ResolvedSource>();
    for (const entry of state.entries) {
      for (const source of entry.sources) {
        if (!seen.has(source)) seen.set(source, resolveSource(source));
      }
    }
    return [...seen.values()];
    // Deps are listed deliberately; `resolveSource` closes over stable inputs.
  }, [state.entries, leaseNames, modelId]);

  const copy = async (): Promise<void> => {
    const lines = [
      `${target.label}${target.value ? `: ${target.value}` : ''}`,
      ...(components.length > 0
        ? ['', 'Components', ...components.map((c) => `  ${c.label}\t${c.value}`)]
        : []),
      ...(state.entries.length > 0
        ? [
            '',
            'Calculation',
            ...state.entries.flatMap((entry) => [
              `  ${entry.formula} (v${entry.formulaVersion})`,
              `    ${entry.description}`,
              ...Object.entries(entry.inputs).map(([key, value]) => `    ${key}\t${value}`),
              `    = ${entry.result}`,
            ]),
          ]
        : []),
      '',
      `Engine ${cashFlow?.engineVersion ?? '—'}, calculated ${cashFlow?.calculatedAt ?? '—'}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <aside className="inspector" role="dialog" aria-label={`How ${target.label} was calculated`}>
      <div className="row">
        <h2 style={{ flex: 1 }}>How this was calculated</h2>
        <button type="button" onClick={onClose} aria-label="Close the calculation inspector">
          Close
        </button>
      </div>

      <p className="inspector-headline">
        <span>{target.label}</span>
        {target.value && <strong>{target.value}</strong>}
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <button type="button" className="subtle" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy calculation'}
        </button>
      </div>

      {components.length > 0 && (
        <section aria-label="Components">
          <h3>Components</h3>
          <table>
            <caption className="visually-hidden">What makes up {target.label}</caption>
            <thead>
              <tr>
                <th scope="col">Contributor</th>
                <th scope="col" className="numeric">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {components.map((component) => (
                <tr key={component.key}>
                  <th scope="row">
                    {component.href ? (
                      <Link to={component.href}>{component.label}</Link>
                    ) : (
                      component.label
                    )}
                  </th>
                  <td className="numeric">{formatCurrency(component.value, currency)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">
                  <strong>Total</strong>
                </th>
                <td className="numeric">
                  <strong>
                    {formatCurrency(
                      components.reduce((sum, c) => sum + Number(c.value), 0).toString(),
                      currency,
                    )}
                  </strong>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="field-hint">
            Read from the calculation the engine stored, not re-derived here. A total that differs
            from the figure above means the line carries something outside the leases — a
            property-level item, or an allowance applied after they were summed.
          </p>
        </section>
      )}

      {allSources.length > 0 && (
        <section aria-label="Where to change it">
          <h3>Where to change it</h3>
          <ul className="inspector-sources">
            {allSources.map((source) => (
              <li key={`${source.kind}:${source.id}`}>
                {source.href ? (
                  <Link to={source.href}>{source.label}</Link>
                ) : (
                  <span>{source.label}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <h3>Calculation</h3>
      {state.loading && <Loading label="Loading the calculation trace" />}
      {state.error && (
        <div className="message warning">
          {state.error} Re-run the calculation to record a trace, then try again.
        </div>
      )}
      {!state.loading && !state.error && state.entries.length === 0 && (
        <div className="message info">
          No trace entries were recorded for this figure. Subtotals are sums of the lines above
          them; open a component line to see its derivation.
        </div>
      )}

      {state.entries.map((entry, index) => (
        <div className="trace-entry" key={`${entry.target}-${index}`}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="badge accent">{entry.formula}</span>
            <span className="spacer" />
            <code>v{entry.formulaVersion}</code>
          </div>
          <p style={{ marginTop: 0 }}>{entry.description}</p>
          <dl>
            {Object.entries(entry.inputs).map(([key, value]) => (
              <div key={key} style={{ display: 'contents' }}>
                <dt>{key}</dt>
                <dd>{value === '' ? '—' : value}</dd>
              </div>
            ))}
            <dt>Result</dt>
            <dd>
              <strong>{entry.result}</strong>
            </dd>
            <dt>Sources</dt>
            <dd>
              {entry.sources.map((source, position) => {
                const resolved = resolveSource(source);
                return (
                  <span key={source}>
                    {position > 0 && ', '}
                    {resolved.href ? (
                      <Link to={resolved.href}>{resolved.label}</Link>
                    ) : (
                      <code>{resolved.label}</code>
                    )}
                  </span>
                );
              })}
            </dd>
            {entry.rounding && (
              <>
                <dt>Rounding</dt>
                <dd>{entry.rounding}</dd>
              </>
            )}
          </dl>
        </div>
      ))}

      {cashFlow && (
        <p className="field-hint">
          Engine {cashFlow.engineVersion}. This is the calculation stored on{' '}
          {new Date(cashFlow.calculatedAt).toLocaleString()}, not a fresh one.
        </p>
      )}
    </aside>
  );
}

/**
 * Trace targets for the lines whose derivation is recorded under a prefix.
 *
 * A line absent from this map falls back to every entry for the period, which
 * is the right behaviour for a subtotal: it has no formula of its own, it is a
 * sum of the lines above it, and the panel says so.
 */
const TRACE_TARGETS: Record<string, string> = {
  expenseRecoveries: 'occurrence:',
  scheduledBaseRent: 'occurrence:',
  contractualBaseRent: 'occurrence:',
  potentialBaseRent: 'occurrence:',
  percentageRent: 'occurrence:',
  operatingExpenses: 'expense:',
  capitalExpenditures: 'capital:',
  interestExpense: 'debt:',
  principalAmortization: 'debt:',
  grossSaleProceeds: 'valuation:',
  sellingCosts: 'valuation:',
  netDispositionProceeds: 'valuation:',
};

/**
 * Narrows a shared target prefix to the line being inspected.
 *
 * Several lines sit under `occurrence:` — everything a lease produces does — so
 * the target alone cannot tell a recovery derivation from a base-rent one. The
 * formula name can, and it is applied on the server: the row limit is enforced
 * after filtering, so narrowing here instead would leave the recoveries pushed
 * past a limit already filled with base rent.
 *
 * Absent means "everything the prefix matched", which is right for a line whose
 * target prefix is already specific — an expense, a capital item, a facility.
 */
const TRACE_FORMULAS: Record<string, string> = {
  expenseRecoveries: 'recovery.',
  percentageRent: 'lease.percentageRent',
  scheduledBaseRent: 'lease.baseRent',
  contractualBaseRent: 'lease.baseRent',
  potentialBaseRent: 'lease.baseRent',
};

/**
 * The per-contributor breakdown, where the engine reports one.
 *
 * `leaseCashFlows` already carries every lease's own base rent, recoveries and
 * so on, month by month, so a total across tenants can be shown as the tenants
 * that made it without asking the server anything further. Lines with no
 * per-lease decomposition — a property-level expense, a debt payment — return
 * nothing rather than an invented split.
 */
const LEASE_LINES: Record<string, keyof CashFlowResponse['leaseCashFlows'][number]> = {
  scheduledBaseRent: 'baseRent',
  contractualBaseRent: 'baseRent',
  potentialBaseRent: 'baseRent',
  expenseRecoveries: 'recoveries',
  percentageRent: 'percentageRent',
  freeRent: 'freeRent',
  tenantImprovements: 'tenantImprovements',
  leasingCommissions: 'leasingCommissions',
};

function buildComponents(
  modelId: string,
  target: InspectorTarget,
  cashFlow: CashFlowResponse | null,
  leaseNames: Map<string, { code: string; tenant: string }>,
): Array<{ key: string; label: string; value: string; href?: string }> {
  if (!cashFlow || target.period === null) return [];
  const field = LEASE_LINES[target.line];
  if (!field) return [];

  /*
   * The one place a 1-based period becomes an array index, and the only place
   * it should be. A figure spanning several periods sums them, because that is
   * what the column shown to the reader is.
   */
  const from = target.period - 1;
  const to = (target.periodEnd ?? target.period) - 1;

  const rows = cashFlow.leaseCashFlows
    .map((row, index) => {
      const series = row[field];
      const value = Array.isArray(series)
        ? series
            .slice(from, to + 1)
            .reduce((sum, entry) => sum + Number(entry ?? '0'), 0)
            .toString()
        : '0';
      const known = leaseNames.get(row.leaseId);
      /*
       * A rollover branch is a different row from the contract lease it came
       * from, and both can be non-zero in the same month. Saying which is
       * which matters: "Kestrel Analytics" twice, with different numbers, is
       * the kind of thing a reader reports as a bug.
       */
      const scenario = row.scenario && row.scenario !== 'contract' ? ` (${row.scenario})` : '';
      return {
        key: `${row.leaseId}-${row.scenario ?? 'contract'}-${index}`,
        label: `${row.tenantName}${scenario}`,
        value: String(value),
        ...(known
          ? { href: `/models/${modelId}/rent-roll?lease=${encodeURIComponent(known.code)}` }
          : {}),
      };
    })
    .filter((row) => Number(row.value) !== 0);

  // Largest first: a reader opening a total wants the tenant that dominates it.
  rows.sort((a, b) => Math.abs(Number(b.value)) - Math.abs(Number(a.value)));
  return rows.slice(0, 25);
}
