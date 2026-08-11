import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import type { Diagnostic } from '@cre/domain-models';
import { formatNumber, titleCase } from './format.js';
import type { ApiError } from './api.js';
import { useFavourites } from './favourites.js';

/** Shared presentational building blocks. */

// A page can hold more than one live region at a time — a result banner and a
// panel still loading beneath it, say. Anonymous ones are indistinguishable:
// assistive technology cannot say which region spoke, and a test cannot address
// one without matching the other. Every status region here carries a name.
export function Loading({ label = 'Loading' }: { label?: string }): JSX.Element {
  return (
    <div className="loading" role="status" aria-live="polite" aria-label={label}>
      {label}…
    </div>
  );
}

export function ErrorMessage({ error }: { error: ApiError | null }): JSX.Element | null {
  if (!error) return null;
  const details = Array.isArray(error.details) ? error.details : null;
  return (
    <div className="message error" role="alert">
      <strong>{error.message}</strong>
      {details && details.length > 0 && (
        <ul>
          {details.slice(0, 8).map((detail, index) => (
            <li key={index}>
              {typeof detail === 'string'
                ? detail
                : `${(detail as { path?: string }).path ?? ''} ${(detail as { message?: string }).message ?? JSON.stringify(detail)}`}
            </li>
          ))}
        </ul>
      )}
      {error.reference && (
        <p className="field-hint" style={{ marginTop: 4, marginBottom: 0 }}>
          Reference: <code>{error.reference}</code> — quote this if you contact support.
        </p>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  level = 2,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  /**
   * Heading level, so the empty state sits correctly in the page's ladder.
   *
   * This used to be a hard-coded `h3` in a component used at a dozen different
   * depths, which put an `h1 → h3` skip on any screen whose empty state sat
   * directly under the page title. That is valid HTML and passes `axe-core`;
   * to somebody navigating by heading it reads as a missing section, and they
   * go looking for content that was never there. Found by
   * `e2e/screen-reader.spec.ts`, which walks the heading ladder of every screen.
   *
   * Defaults to 2 — directly under a page `h1`, which is the common case — and
   * callers nested inside a card with its own `h2` pass 3.
   */
  level?: 2 | 3;
}): JSX.Element {
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <div className="empty-state">
      <Heading>{title}</Heading>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}): JSX.Element {
  return (
    // The note lives inside the <dd> it qualifies. A definition list may only
    // pair terms with descriptions, so a third sibling here would break the
    // structure a screen reader relies on to read the pair as one fact.
    <div className="metric">
      <dt>{label}</dt>
      <dd>
        {value}
        {note && <div className="metric-note">{note}</div>}
      </dd>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  draft: '',
  analyst_review: 'accent',
  manager_review: 'accent',
  approved: 'positive',
  published: 'positive',
  superseded: 'warning',
  archived: '',
  occupied: 'positive',
  vacant: 'warning',
  future: 'accent',
  expired: '',
  terminated: 'negative',
  trial: 'accent',
  active: 'positive',
  past_due: 'warning',
  suspended: 'negative',
  cancelled: 'negative',
  internal: '',
};

export function StatusBadge({ status }: { status: string }): JSX.Element {
  return <span className={`badge ${STATUS_TONE[status] ?? ''}`}>{titleCase(status)}</span>;
}

/**
 * The star that pins a property or model to the dashboard and the palette.
 *
 * Pinning is not gated on a capability: a read-only reviewer has as much
 * reason to keep a shortlist as anybody, and it changes nothing anyone else
 * can see. The label states the current state and the action together
 * ("Pinned — remove from favourites") so a screen-reader user does not have to
 * infer the toggle's direction from a bare icon.
 */
export function FavouriteButton({
  entityType,
  entityId,
  name,
}: {
  entityType: 'property' | 'model';
  entityId: string;
  name: string;
}): JSX.Element {
  const { isFavourite, toggle } = useFavourites();
  const pinned = isFavourite(entityType, entityId);

  return (
    <button
      type="button"
      className={`favourite-star${pinned ? ' is-favourite' : ''}`}
      aria-pressed={pinned}
      title={pinned ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
      onClick={() => void toggle(entityType, entityId)}
    >
      <span aria-hidden="true">{pinned ? '★' : '☆'}</span>
      <span className="visually-hidden">
        {pinned ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
      </span>
    </button>
  );
}

/**
 * Model health panel.
 *
 * Errors are listed first and cannot be dismissed from here: a critical
 * mathematical error must be corrected in the model, not acknowledged away.
 */
export function DiagnosticList({ diagnostics }: { diagnostics: Diagnostic[] }): JSX.Element {
  const order = { error: 0, warning: 1, informational: 2, accepted_exception: 3 } as const;
  const sorted = [...diagnostics].sort((a, b) => order[a.severity] - order[b.severity]);
  const errors = sorted.filter((entry) => entry.severity === 'error');

  if (sorted.length === 0) {
    return (
      <div className="message info">
        No validation findings. The engine calculated this model without raising anything.
      </div>
    );
  }

  return (
    <div>
      {errors.length > 0 && (
        <div className="message error" role="alert">
          {errors.length === 1
            ? 'One critical error must be corrected before this model can be approved.'
            : `${errors.length} critical errors must be corrected before this model can be approved.`}
        </div>
      )}
      <div className="table-scroll" tabIndex={0}>
        <table>
          <caption className="visually-hidden">Model validation findings</caption>
          <thead>
            <tr>
              <th scope="col">Severity</th>
              <th scope="col">Subject</th>
              <th scope="col">Finding</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry, index) => (
              <tr key={`${entry.code}-${entry.subject ?? ''}-${index}`}>
                <td>
                  <span
                    className={`badge ${
                      entry.severity === 'error'
                        ? 'negative'
                        : entry.severity === 'warning'
                          ? 'warning'
                          : ''
                    }`}
                  >
                    {titleCase(entry.severity)}
                  </span>
                </td>
                <td>{entry.subject ?? '—'}</td>
                <td style={{ whiteSpace: 'normal', minWidth: '28rem' }}>{entry.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A small column chart with an always-available data table.
 *
 * The axis is anchored at zero so a bar's height is proportional to its value;
 * truncating it would exaggerate differences, which is exactly the kind of
 * distortion a financial chart must not introduce.
 */
export function BarChart({
  title,
  labels,
  values,
  formatValue,
  height = 180,
}: {
  title: string;
  labels: string[];
  values: number[];
  formatValue: (value: number) => string;
  height?: number;
}): JSX.Element {
  const width = Math.max(320, labels.length * 56);
  const padding = { top: 12, right: 8, bottom: 26, left: 62 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const zeroY = padding.top + (max / span) * plotHeight;
  const barWidth = plotWidth / Math.max(labels.length, 1);

  const ticks = [max, max - span / 2, min];

  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="chart-caption" style={{ marginBottom: 8, marginTop: 0 }}>
        {title}
      </figcaption>
      <div style={{ overflowX: 'auto' }}>
        <svg
          className="chart"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label={`${title}. ${labels
            .map((label, index) => `${label}: ${formatValue(values[index] ?? 0)}`)
            .join('. ')}`}
        >
          <g className="grid">
            {ticks.map((tick, index) => {
              const y = padding.top + ((max - tick) / span) * plotHeight;
              return (
                <g key={index}>
                  <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} />
                  <text x={padding.left - 6} y={y + 3} textAnchor="end">
                    {formatValue(tick)}
                  </text>
                </g>
              );
            })}
          </g>
          <g>
            {values.map((value, index) => {
              const barHeight = (Math.abs(value) / span) * plotHeight;
              const x = padding.left + index * barWidth + barWidth * 0.15;
              const y = value >= 0 ? zeroY - barHeight : zeroY;
              return (
                <rect
                  key={index}
                  className={value >= 0 ? 'bar-positive' : 'bar-negative'}
                  x={x}
                  y={y}
                  width={barWidth * 0.7}
                  height={Math.max(barHeight, 1)}
                  rx={2}
                />
              );
            })}
          </g>
          <g className="axis">
            <line x1={padding.left} x2={width - padding.right} y1={zeroY} y2={zeroY} />
            {labels.map((label, index) => (
              <text
                key={index}
                x={padding.left + index * barWidth + barWidth / 2}
                y={height - 8}
                textAnchor="middle"
              >
                {label}
              </text>
            ))}
          </g>
        </svg>
      </div>
      <details className="chart-data">
        <summary>Show the underlying figures as a table</summary>
        <table>
          <caption className="visually-hidden">{title} data</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col" className="numeric">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {labels.map((label, index) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="numeric">{formatValue(values[index] ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

interface LabellableProps {
  id?: string;
  'aria-describedby'?: string;
}

/**
 * A labelled form control.
 *
 * The label is bound to the control it names, and the hint or error beneath it
 * is bound as the control's description. Without that binding a screen reader
 * announces an unnamed text box, and the hint — often the part that says what
 * format a rate or a date has to be in — is never read at all. Since the
 * caller passes the control as a child, `Field` generates the identifier and
 * applies it, so no call site can forget.
 *
 * A control that already carries its own `id` keeps it.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}): JSX.Element {
  const generatedId = useId();
  const hintId = `${generatedId}-hint`;
  const errorId = `${generatedId}-error`;

  const element = isValidElement(children) ? (children as ReactElement<LabellableProps>) : null;
  const controlId = element?.props.id ?? generatedId;
  const description = error ? errorId : hint ? hintId : undefined;

  const control = element
    ? cloneElement(element, {
        id: controlId,
        'aria-describedby': element.props['aria-describedby'] ?? description,
      })
    : children;

  return (
    <div className="field">
      <label htmlFor={element ? controlId : undefined}>{label}</label>
      {control}
      {hint && !error && (
        <div className="field-hint" id={hintId}>
          {hint}
        </div>
      )}
      {error && (
        <div className="field-error" id={errorId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function AreaCell({ value }: { value: string | null }): JSX.Element {
  return <span className="numeric">{formatNumber(value, 0)}</span>;
}
