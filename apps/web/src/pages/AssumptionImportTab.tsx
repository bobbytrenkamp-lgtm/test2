import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  AnalyzedAssumption,
  AnalyzedValue,
  AssumptionUnit,
  AssumptionValueType,
  ImportAnalysis,
  ImportItemStatus,
  MissingCollectionRecord,
} from '@cre/domain-models';
import { parseCreosHandoffPayload, translateSiteIntelHandoff } from '@cre/domain-models';
import { api } from '../api.js';
import { EmptyState, ErrorMessage, Field } from '../components.js';
import {
  formatCurrency,
  formatDate,
  formatMultiple,
  formatNumber,
  formatPercent,
} from '../format.js';
import { useMutation } from '../hooks.js';
import { useSession } from '../session.js';
import { useModelContext } from './ModelWorkspace.js';

/**
 * Import assumptions from a Claude Skill's structured extraction.
 *
 * This screen never reads a PDF and never calls an AI provider — that already
 * happened, outside this platform, before the paste landed here. What this
 * screen does is entirely deterministic: parse the paste, compare every
 * assumption against what this model actually holds, and let an analyst pick
 * which differences to accept. Accepting still goes through the same
 * assumption-proposal write path a person's edit or a posted proposal uses —
 * see `docs/claude-assumption-import.md`.
 */

const STATUS_LABEL: Record<ImportItemStatus, string> = {
  new: 'New',
  changed: 'Changed',
  same: 'Already matches',
  needsReview: 'Needs review',
  conflict: 'Conflict',
  missingTarget: 'No matching record',
  unsupported: 'Not modeled here',
  invalid: 'Invalid',
};

const STATUS_TONE: Record<ImportItemStatus, string> = {
  new: 'accent',
  changed: 'accent',
  same: '',
  needsReview: 'warning',
  conflict: 'warning',
  missingTarget: 'warning',
  unsupported: '',
  invalid: 'negative',
};

const SELECTABLE_STATUSES = new Set<ImportItemStatus>(['new', 'changed', 'needsReview']);

type Filter = 'all' | ImportItemStatus;

const FILTERS: Array<{
  id: Filter;
  label: string;
  count: (summary: ImportAnalysis['summary']) => number;
}> = [
  { id: 'all', label: 'All', count: (s) => s.received },
  { id: 'changed', label: 'Changed', count: (s) => s.changed },
  { id: 'new', label: 'New', count: (s) => s.new },
  { id: 'same', label: 'Same', count: (s) => s.same },
  { id: 'needsReview', label: 'Needs review', count: (s) => s.needsReview },
  { id: 'conflict', label: 'Conflicts', count: (s) => s.conflicts },
  {
    id: 'unsupported',
    label: 'Unsupported',
    count: (s) => s.unsupported + s.invalid + s.missingTarget,
  },
];

interface ApplyResult {
  importSession: { id: string; document_name: string | null; applied_count: number };
  applied: Array<{ target: string; proposalId: string }>;
  summary: ImportAnalysis['summary'];
}

export function AssumptionImportTab(): JSX.Element {
  const { model, property, cashFlow, calculate, calculating, reloadCashFlow } = useModelContext();
  const { can } = useSession();
  const editable =
    can('model:write') &&
    !['approved', 'published', 'superseded', 'archived'].includes(model.status);

  const [paste, setPaste] = useState('');
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0.8);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [beforeReturns, setBeforeReturns] = useState<typeof cashFlow>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffFilename, setHandoffFilename] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  const analyze = useMutation(async () => {
    const result = await api.post<ImportAnalysis>(`/models/${model.id}/assumption-import/analyze`, {
      paste,
    });
    setAnalysis(result);
    setSelected(new Set());
    setApplyResult(null);
    setFilter('all');
    return result;
  });

  const apply = useMutation(async (targets: string[]) => {
    const before = cashFlow;
    const result = await api.post<ApplyResult>(`/models/${model.id}/assumption-import/apply`, {
      paste,
      targets,
    });
    setApplyResult(result);
    setBeforeReturns(before);
    setSelected(new Set());
    // Refresh what accepting an assumption proposal already refreshes:
    // recalculate, then reload the cash flow it depends on.
    await calculate(true);
    reloadCashFlow();
    return result;
  });

  const items = analysis?.items ?? [];
  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'unsupported') {
      return items.filter(
        (item) =>
          item.status === 'unsupported' ||
          item.status === 'invalid' ||
          item.status === 'missingTarget',
      );
    }
    return items.filter((item) => item.status === filter);
  }, [items, filter]);

  function toggle(target: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  }

  function selectByStatus(status: ImportItemStatus): void {
    setSelected(new Set(items.filter((item) => item.status === status).map((item) => item.target)));
  }

  function selectReady(): void {
    setSelected(
      new Set(
        items
          .filter((item) => item.status === 'new' || item.status === 'changed')
          .map((item) => item.target),
      ),
    );
  }

  function selectAboveThreshold(): void {
    setSelected(
      new Set(
        items
          .filter(
            (item) =>
              (item.status === 'new' || item.status === 'changed') &&
              item.confidence !== null &&
              item.confidence >= threshold,
          )
          .map((item) => item.target),
      ),
    );
  }

  function focusRow(target: string, delta: number): void {
    const order = filtered.map((item) => item.target);
    const index = order.indexOf(target);
    if (index === -1) return;
    const nextTarget = order[Math.min(Math.max(index + delta, 0), order.length - 1)];
    if (nextTarget) rowRefs.current.get(nextTarget)?.focus();
  }

  const returnsBefore = beforeReturns?.returns ?? null;
  const returnsAfter = applyResult ? (cashFlow?.returns ?? null) : null;
  const valueBefore = beforeReturns?.valuations?.[0]?.value ?? null;
  const valueAfter = applyResult ? (cashFlow?.valuations?.[0]?.value ?? null) : null;
  const noiBefore = beforeReturns?.annual?.[0]?.lines.netOperatingIncome ?? null;
  const noiAfter = applyResult ? (cashFlow?.annual?.[0]?.lines.netOperatingIncome ?? null) : null;

  return (
    <>
      {!editable && (
        <div className="message info">
          This model’s assumptions are frozen, so imported assumptions can be reviewed here but not
          applied. Clone the model to keep working.
        </div>
      )}

      <div className="card">
        <h2>Import assumptions</h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Paste the structured output a Claude Skill produced from a document — an offering
          memorandum, an appraisal, a loan term sheet. Nothing is read here except that paste: no
          file is opened, no document is interpreted, and nothing is sent to an AI provider.
          Everything below is a deterministic comparison against{' '}
          {property?.name ? <strong>{property.name}</strong> : 'this model'}, and nothing is written
          to it until you choose to apply it.
        </p>

        <Field
          label="Pasted output"
          hint="A single cre-assumption-import JSON document, optionally wrapped in a ```json code fence."
        >
          <textarea
            rows={10}
            value={paste}
            spellCheck={false}
            placeholder={'{\n  "format": "cre-assumption-import",\n  "version": 1,\n  ...\n}'}
            onChange={(event) => setPaste(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                if (paste.trim()) void analyze.run();
              }
            }}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
        </Field>

        <ErrorMessage error={analyze.error} />

        <div className="row end">
          <button
            type="button"
            onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                setPaste(text);
              } catch {
                // A denied clipboard permission is not worth interrupting the
                // analyst for; they can still paste with the keyboard.
              }
            }}
          >
            Paste from clipboard
          </button>
          <button
            type="button"
            onClick={() => {
              setPaste('');
              setAnalysis(null);
              setSelected(new Set());
              setApplyResult(null);
              analyze.clearError();
            }}
            disabled={!paste && !analysis}
          >
            Clear
          </button>
          <button
            type="button"
            className="primary"
            disabled={!paste.trim() || analyze.pending}
            title="Analyze (Ctrl/Cmd + Enter)"
            onClick={() => void analyze.run()}
          >
            {analyze.pending ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>

        <Field
          label="Or import a CREOS SiteIntel handoff"
          hint="A creos-handoff-v1 .json file downloaded from SiteIntel's 'Send to Underwrite' action. Read in the browser, translated to the format above, and analyzed the same deterministic way — nothing here is written until you choose to apply it below."
        >
          <input
            type="file"
            accept=".json,application/json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setHandoffError(null);
              const raw = await file.text();
              const parsed = parseCreosHandoffPayload(raw);
              if (!parsed.ok) {
                setHandoffError(parsed.error);
                return;
              }
              const translated = translateSiteIntelHandoff(parsed.data);
              setHandoffFilename(file.name);
              setPaste(JSON.stringify(translated, null, 2));
              setAnalysis(null);
              setApplyResult(null);
              analyze.clearError();
            }}
          />
        </Field>
        {handoffFilename && !handoffError && (
          <p className="field-hint" style={{ marginTop: -8 }}>
            Loaded {handoffFilename} — every fact from a SiteIntel handoff is informational only
            (target <code>siteIntel.*</code>): SiteIntel does not supply underwriting inputs like
            acquisition price, so these will analyze as "Unsupported" rather than
            new/changed/ready-to-apply. Review them for context; nothing here writes to the model.
          </p>
        )}
        {handoffError && (
          <div className="message error" role="alert">
            <strong>{handoffError}</strong>
          </div>
        )}
      </div>

      {analysis && (
        <>
          {analysis.propertyMismatch && (
            <div className="message warning">
              This document appears to describe{' '}
              <strong>{analysis.property.name ?? 'a different property'}</strong>, not{' '}
              {property?.name ?? 'the property this model is open on'}. Everything below is still
              compared against the model you have open — check that this is the right document
              before applying anything.
            </div>
          )}

          <div className="card">
            <div className="row" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>
                {analysis.summary.received} assumption{analysis.summary.received === 1 ? '' : 's'}{' '}
                found
              </h2>
              {analysis.source.documentName && (
                <span className="badge">{analysis.source.documentName}</span>
              )}
            </div>
            <p className="field-hint" style={{ marginTop: 0 }}>
              {analysis.summary.new + analysis.summary.changed} ready · {analysis.summary.same}{' '}
              already match · {analysis.summary.needsReview} need review ·{' '}
              {analysis.summary.conflicts} conflict{analysis.summary.conflicts === 1 ? '' : 's'} ·{' '}
              {analysis.summary.unsupported +
                analysis.summary.invalid +
                analysis.summary.missingTarget}{' '}
              unsupported
            </p>

            <div
              className="row"
              role="tablist"
              aria-label="Filter assumptions"
              style={{ marginBottom: 12 }}
            >
              {FILTERS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === entry.id}
                  className={filter === entry.id ? 'primary' : ''}
                  onClick={() => setFilter(entry.id)}
                >
                  {entry.label} ({entry.count(analysis.summary)})
                </button>
              ))}
            </div>

            {editable && (
              <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                <button type="button" onClick={selectReady}>
                  Select all ready
                </button>
                <button type="button" onClick={() => selectByStatus('changed')}>
                  Select all changed
                </button>
                <button type="button" onClick={() => selectByStatus('new')}>
                  Select all new
                </button>
                <label className="row" style={{ gap: 4 }}>
                  <span className="field-hint" style={{ margin: 0 }}>
                    Confidence ≥
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={threshold}
                    onChange={(event) => setThreshold(Number(event.target.value))}
                    style={{ width: '4.5rem' }}
                    aria-label="Confidence threshold"
                  />
                </label>
                <button type="button" onClick={selectAboveThreshold}>
                  Select above threshold
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  disabled={selected.size === 0}
                >
                  Deselect all
                </button>
                <div className="spacer" />
                <span className="field-hint" style={{ margin: 0 }}>
                  {selected.size} selected
                </span>
              </div>
            )}

            {filtered.length === 0 ? (
              <EmptyState title="Nothing matches this filter" level={3}>
                Choose a different filter to see the rest of what was found.
              </EmptyState>
            ) : (
              <div className="table-scroll" tabIndex={0}>
                <table>
                  <caption className="visually-hidden">Imported assumptions</caption>
                  <thead>
                    <tr>
                      {editable && <th scope="col">Apply</th>}
                      <th scope="col">Assumption</th>
                      <th scope="col" className="numeric">
                        Current
                      </th>
                      <th scope="col" className="numeric">
                        Extracted
                      </th>
                      <th scope="col" className="numeric">
                        Difference
                      </th>
                      <th scope="col">Source</th>
                      <th scope="col">Page</th>
                      <th scope="col">Confidence</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((item) => (
                      <ImportRow
                        key={item.target}
                        item={item}
                        editable={editable}
                        selected={selected.has(item.target)}
                        expanded={expanded === item.target}
                        documentName={analysis.source.documentName ?? null}
                        rowRef={(element) => {
                          if (element) rowRefs.current.set(item.target, element);
                          else rowRefs.current.delete(item.target);
                        }}
                        onToggleSelect={() => toggle(item.target)}
                        onToggleExpand={() =>
                          setExpanded((current) => (current === item.target ? null : item.target))
                        }
                        onCollapse={() => setExpanded(null)}
                        onMove={(delta) => focusRow(item.target, delta)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <ErrorMessage error={apply.error} />

            {editable && (
              <div className="row end" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="primary"
                  disabled={selected.size === 0 || apply.pending || calculating}
                  onClick={() => void apply.run([...selected])}
                >
                  {apply.pending || calculating
                    ? 'Applying…'
                    : `Apply ${selected.size} assumption${selected.size === 1 ? '' : 's'}`}
                </button>
              </div>
            )}
          </div>

          {analysis.missingCollectionRecords.length > 0 && (
            <MissingRecords model={model.id} records={analysis.missingCollectionRecords} />
          )}
        </>
      )}

      {applyResult && (
        <div className="card">
          <h2>Applied</h2>
          <p>
            {applyResult.applied.length} assumption{applyResult.applied.length === 1 ? '' : 's'}{' '}
            written to the model
            {applyResult.importSession.document_name
              ? ` from ${applyResult.importSession.document_name}`
              : ''}
            . The engine has recalculated.
          </p>

          <dl className="proposal-values">
            <div>
              <dt>Value</dt>
              <dd>
                {formatDelta(valueBefore, valueAfter, (v) =>
                  formatCurrency(v, model.currency, { compact: true }),
                )}
              </dd>
            </div>
            <div>
              <dt>Levered IRR</dt>
              <dd>
                {formatDelta(
                  returnsBefore?.leveredXirr ?? returnsBefore?.leveredIrr ?? null,
                  returnsAfter?.leveredXirr ?? returnsAfter?.leveredIrr ?? null,
                  (v) => formatPercent(v),
                )}
              </dd>
            </div>
            <div>
              <dt>Equity multiple</dt>
              <dd>
                {formatDelta(
                  returnsBefore?.equityMultiple ?? null,
                  returnsAfter?.equityMultiple ?? null,
                  formatMultiple,
                )}
              </dd>
            </div>
            <div>
              <dt>Year 1 NOI</dt>
              <dd>
                {formatDelta(noiBefore, noiAfter, (v) =>
                  formatCurrency(v, model.currency, { compact: true }),
                )}
              </dd>
            </div>
          </dl>

          <div className="row" style={{ marginTop: 8 }}>
            <Link to={`/models/${model.id}/provenance`} className="button">
              Open Provenance
            </Link>
            <Link to={`/models/${model.id}/returns`} className="button">
              Open Returns
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

function ImportRow({
  item,
  editable,
  selected,
  expanded,
  documentName,
  rowRef,
  onToggleSelect,
  onToggleExpand,
  onCollapse,
  onMove,
}: {
  item: AnalyzedAssumption;
  editable: boolean;
  selected: boolean;
  expanded: boolean;
  documentName: string | null;
  rowRef: (element: HTMLTableRowElement | null) => void;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onCollapse: () => void;
  onMove: (delta: number) => void;
}): JSX.Element {
  const selectable = SELECTABLE_STATUSES.has(item.status);
  const difference = presentDifference(
    item.currentValue,
    item.extractedValue,
    item.valueType,
    item.unit,
  );

  return (
    <>
      <tr
        ref={rowRef}
        tabIndex={0}
        className={selected ? 'emphasis' : undefined}
        onClick={onToggleExpand}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onToggleExpand();
          } else if (event.key === 'Escape' && expanded) {
            event.preventDefault();
            onCollapse();
          } else if (event.key === ' ' && selectable && editable) {
            event.preventDefault();
            onToggleSelect();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            onMove(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            onMove(-1);
          }
        }}
      >
        {editable && (
          <td>
            {selectable ? (
              <input
                type="checkbox"
                checked={selected}
                aria-label={`Apply ${item.label ?? item.target}`}
                onClick={(event) => event.stopPropagation()}
                onChange={onToggleSelect}
              />
            ) : (
              <span aria-hidden="true">—</span>
            )}
          </td>
        )}
        <td>
          <div>{item.label ?? item.target}</div>
          <div className="field-hint">{item.target}</div>
        </td>
        <td className="numeric">{presentValue(item.currentValue, item.valueType, item.unit)}</td>
        <td className="numeric">
          {item.status === 'conflict'
            ? '—'
            : presentValue(item.extractedValue, item.valueType, item.unit)}
        </td>
        <td className="numeric">{difference}</td>
        <td>{documentName ?? '—'}</td>
        <td>
          {[
            ...new Set(
              item.evidence
                .map((e) => e.page)
                .filter((p): p is number => p !== null && p !== undefined),
            ),
          ].join(', ') || '—'}
        </td>
        <td>{item.confidence === null ? 'Not stated' : formatPercent(item.confidence, 0)}</td>
        <td>
          <span className={`badge ${STATUS_TONE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={editable ? 9 : 8} style={{ whiteSpace: 'normal' }}>
            <EvidenceDetail item={item} />
          </td>
        </tr>
      )}
    </>
  );
}

function EvidenceDetail({ item }: { item: AnalyzedAssumption }): JSX.Element {
  return (
    <div style={{ padding: '4px 0' }}>
      {item.reason && (
        <p className="message info" style={{ marginBottom: 8 }}>
          {item.reason}
        </p>
      )}

      {item.status === 'conflict' && item.conflictingValues && (
        <>
          <p>Different values were extracted for this target. Choose which is correct by hand:</p>
          <ul>
            {item.conflictingValues.map((value: AnalyzedValue, index: number) => (
              <li key={index}>
                <strong>{presentValue(value.value, item.valueType, item.unit)}</strong>
                {value.evidence.length > 0 && (
                  <>
                    {' — '}
                    {value.evidence.map((e, i) => (
                      <span key={i}>
                        {i > 0 ? ', ' : ''}
                        {e.page ? `page ${e.page}` : (e.section ?? 'source')}
                        {e.sourceValue ? ` (“${e.sourceValue}”)` : ''}
                      </span>
                    ))}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {item.evidence.length > 0 && (
        <table>
          <caption className="visually-hidden">Evidence for {item.label ?? item.target}</caption>
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Section</th>
              <th scope="col">Label</th>
              <th scope="col">As shown in the source</th>
            </tr>
          </thead>
          <tbody>
            {item.evidence.map((e, index) => (
              <tr key={index}>
                <td>{e.page ?? '—'}</td>
                <td>{e.section ?? '—'}</td>
                <td>{e.label ?? '—'}</td>
                <td>{e.sourceValue ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <dl className="proposal-values" style={{ marginTop: 8 }}>
        <div>
          <dt>Extraction</dt>
          <dd>
            {item.extraction?.method ? titleCaseMethod(item.extraction.method) : 'Not stated'}
            {item.extraction?.derivation ? ` — ${item.extraction.derivation}` : ''}
          </dd>
        </div>
        <div>
          <dt>Normalized target</dt>
          <dd>
            <code>{item.target}</code>
          </dd>
        </div>
      </dl>

      {item.notes && <p>{item.notes}</p>}
    </div>
  );
}

function MissingRecords({
  model,
  records,
}: {
  model: string;
  records: MissingCollectionRecord[];
}): JSX.Element {
  return (
    <div className="card">
      <h2>Records with no match in this model</h2>
      <p className="field-hint" style={{ marginTop: 0 }}>
        These describe a whole record — a leasing profile, a loan — whose business code does not
        exist here yet. Create it in the structured editor, or map the fields onto an existing one
        by hand; nothing here creates a record automatically.
      </p>
      <ul className="proposal-list">
        {records.map((record) => (
          <li key={`${record.collection}.${record.code}`} className="proposal">
            <strong>
              {record.code}
              {record.name ? ` — ${record.name}` : ''}
            </strong>
            <p className="field-hint">
              No matching {record.noun} for{' '}
              <code>
                {record.collection}.{record.code}
              </code>
              .
            </p>
            <ul>
              {Object.entries(record.fields).map(([field, data]) => (
                <li key={field}>
                  {field}: {data.value ?? '—'}
                </li>
              ))}
            </ul>
            <Link to={`/models/${model}/assumptions`} className="button">
              Open Assumptions to create it
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function titleCaseMethod(method: string): string {
  return method.charAt(0).toUpperCase() + method.slice(1);
}

function presentValue(
  value: string | null,
  valueType: AssumptionValueType | null,
  unit: AssumptionUnit | null,
): string {
  if (value === null) return '—';
  if (valueType === 'boolean') return value === 'true' ? 'Yes' : 'No';
  if (valueType === 'date') return formatDate(value);
  if (valueType === 'decimal' && unit === 'rate') return formatPercent(value);
  if (valueType === 'decimal' && unit === 'currency')
    return formatCurrency(value, undefined, { decimals: 2 });
  if (valueType === 'decimal') return formatNumber(value, 2);
  if (valueType === 'integer') return `${formatNumber(value, 0)}${unit === 'months' ? ' mo' : ''}`;
  return value;
}

function presentDifference(
  current: string | null,
  extracted: string | null,
  valueType: AssumptionValueType | null,
  unit: AssumptionUnit | null,
): string {
  if (current === null || extracted === null) return '—';
  const a = Number(current);
  const b = Number(extracted);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '—';
  const delta = b - a;
  if (delta === 0) return '—';
  const sign = delta > 0 ? '+' : '';
  if (valueType === 'decimal' && unit === 'rate') return `${sign}${Math.round(delta * 10000)} bps`;
  if (valueType === 'decimal' && unit === 'currency') {
    return `${sign}${formatCurrency(String(delta), undefined, { decimals: 0 })}`;
  }
  return `${sign}${formatNumber(String(delta), valueType === 'integer' ? 0 : 2)}`;
}

/** Before → after, or a dash when there is nothing yet to compare. */
function formatDelta(
  before: string | null | undefined,
  after: string | null | undefined,
  format: (value: string) => string,
): string {
  if (after === null || after === undefined) return '—';
  const formattedAfter = format(after);
  if (before === null || before === undefined) return formattedAfter;
  const formattedBefore = format(before);
  if (formattedBefore === formattedAfter) return `${formattedAfter} (unchanged)`;
  return `${formattedBefore} → ${formattedAfter}`;
}
