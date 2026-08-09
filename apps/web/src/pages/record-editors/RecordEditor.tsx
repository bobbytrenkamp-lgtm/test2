import { useMemo, useState } from 'react';
import { ErrorMessage, Field } from '../../components.js';
import type { ApiError } from '../../api.js';
import {
  fieldText,
  fieldValue,
  validate,
  visibleFields,
  writePath,
  type FieldSpec,
  type RecordSpec,
  type RecordValues,
  type SectionSpec,
} from './spec.js';

/**
 * The form a `RecordSpec` describes.
 *
 * It replaces a JSON textarea, and the two things it must do better are the
 * reasons it exists:
 *
 * - **Show only what applies.** A `fixed_annual` expense has no monthly
 *   schedule and a fixed-rate loan has no index curve, so neither is rendered.
 *   The alternative — showing every field of every method — is how somebody
 *   fills in a spread on a fixed loan and cannot work out why nothing moved.
 * - **Explain each field where it is.** Every `help` in the spec becomes a hint
 *   under its control rather than documentation somebody has to go and find.
 *
 * ## What it deliberately does not do
 *
 * It does not calculate. The summary panel beside the form is arithmetic over
 * the fields on screen — a weighted TI, a first-year interest figure — and it
 * is labelled as such. Anything that needs the engine needs a calculation, and
 * presenting a form-side approximation as though it were one is how a model
 * comes to disagree with itself.
 */

export interface RecordEditorProps {
  spec: RecordSpec;
  /** The record as loaded, camelCased. Null creates a new one. */
  initial: RecordValues | null;
  /** The version this editor opened, for the collision check. */
  expectedVersion: number | null;
  saving: boolean;
  error: ApiError | null;
  onCancel: () => void;
  onSave: (values: RecordValues) => void;
}

export function RecordEditor({
  spec,
  initial,
  expectedVersion,
  saving,
  error,
  onCancel,
  onSave,
}: RecordEditorProps): JSX.Element {
  const isNew = initial === null;
  const [record, setRecord] = useState<RecordValues>(() => ({
    ...(spec.defaults ?? {}),
    ...(initial ?? {}),
  }));
  const [showProblems, setShowProblems] = useState(false);

  const problems = useMemo(() => validate(spec, record), [spec, record]);
  const problemCount = Object.keys(problems).length;

  const set = (field: FieldSpec, text: string): void => {
    setRecord((current) => writePath(current, field.key, fieldValue(text, field)));
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (problemCount > 0) {
      setShowProblems(true);
      return;
    }
    /*
     * Only the fields this record actually uses are sent.
     *
     * A spread left over from when the facility floated would otherwise travel
     * with a fixed-rate loan and sit in the database looking meaningful. The
     * code and the version go along regardless, because neither is a field the
     * form owns.
     */
    const used = new Set(visibleFields(spec, record).map((field) => field.key.split('.')[0]));
    const payload: RecordValues = {};
    for (const [key, value] of Object.entries(record)) {
      if (used.has(key)) payload[key] = value;
    }
    payload.code = record.code;
    payload.expectedVersion = expectedVersion;
    onSave(payload);
  };

  const summary = spec.summary?.(record) ?? [];

  /* Sections are laid out in pairs where the spec asks for it. */
  const rows: SectionSpec[][] = [];
  const sections = spec.sections.filter((section) => section.showWhen?.(record) ?? true);
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index] as SectionSpec;
    const next = sections[index + 1];
    if (section.pairWithNext && next) {
      rows.push([section, next]);
      index += 1;
    } else {
      rows.push([section]);
    }
  }

  return (
    <form className="record-editor" onSubmit={submit} noValidate>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>
          {isNew ? `New ${spec.noun}` : `Edit ${String(record.code ?? spec.noun)}`}
        </h3>
        <div className="spacer" />
      </div>

      {error?.status === 409 ? (
        <div className="message error" role="alert">
          <strong>{error.message}</strong>
          <p style={{ marginBottom: 0 }}>
            Nothing has been saved. Cancel and reopen the record to see their change, then reapply
            yours. Saving over them would discard work you cannot see from here.
          </p>
        </div>
      ) : (
        <ErrorMessage error={error} />
      )}

      {showProblems && problemCount > 0 && (
        <div className="message error" role="alert">
          <strong>
            {problemCount} field{problemCount === 1 ? ' needs' : 's need'} attention
          </strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {Object.entries(problems).map(([key, reason]) => (
              <li key={key}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="record-editor-body">
        <div className="record-editor-sections">
          {rows.map((pair, index) => (
            <div key={index} className={pair.length > 1 ? 'record-editor-pair' : undefined}>
              {pair.map((section) => (
                <fieldset key={section.title} className="record-section">
                  <legend>{section.title}</legend>
                  {section.description && (
                    <p className="field-hint" style={{ marginTop: 0 }}>
                      {section.description}
                    </p>
                  )}
                  <div className="form-grid">
                    {section.fields
                      .filter((field) => field.showWhen?.(record) ?? true)
                      .map((field) => (
                        <FieldControl
                          key={field.key}
                          field={field}
                          record={record}
                          isNew={isNew}
                          error={showProblems ? problems[field.key] : undefined}
                          onChange={(text) => set(field, text)}
                        />
                      ))}
                  </div>
                </fieldset>
              ))}
            </div>
          ))}
        </div>

        {summary.length > 0 && (
          <aside className="record-summary" aria-label={`${spec.noun} summary`}>
            <h4>As it stands</h4>
            <dl>
              {summary.map((entry, index) => (
                <div key={index}>
                  <dt>{entry.label}</dt>
                  <dd>
                    {entry.value}
                    {entry.note && <small>{entry.note}</small>}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="field-hint">
              Arithmetic over the fields on this form, not a calculation. Recalculate the model to
              see what these terms actually do to it.
            </p>
          </aside>
        )}
      </div>

      <div className="row end" style={{ marginTop: 16 }}>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : `Save ${spec.noun}`}
        </button>
      </div>
    </form>
  );
}

function FieldControl({
  field,
  record,
  isNew,
  error,
  onChange,
}: {
  field: FieldSpec;
  record: RecordValues;
  isNew: boolean;
  error: string | undefined;
  onChange: (text: string) => void;
}): JSX.Element {
  const value = fieldText(record, field);
  const readOnly = field.fixedAfterCreate === true && !isNew;
  const hint = field.help;

  const common = {
    value,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    ...(error ? { 'aria-invalid': true as const } : {}),
  };

  let control: JSX.Element;
  if (field.kind === 'choice') {
    control = (
      <select {...common} disabled={readOnly}>
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (field.kind === 'boolean') {
    control = (
      <select {...common} disabled={readOnly}>
        <option value="false">No</option>
        <option value="true">Yes</option>
      </select>
    );
  } else if (field.kind === 'schedule') {
    control = (
      <textarea
        {...common}
        rows={3}
        readOnly={readOnly}
        spellCheck={false}
        {...(field.placeholder ? { placeholder: field.placeholder } : {})}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
      />
    );
  } else if (field.kind === 'date') {
    control = <input type="date" {...common} readOnly={readOnly} />;
  } else {
    control = (
      <input
        {...common}
        readOnly={readOnly}
        inputMode={
          field.kind === 'text' || field.kind === 'curve' ? undefined : ('decimal' as const)
        }
        {...(field.placeholder ? { placeholder: field.placeholder } : {})}
      />
    );
  }

  return (
    <Field
      label={field.label + (field.required ? ' *' : '')}
      {...(hint ? { hint } : {})}
      {...(error ? { error } : {})}
    >
      {control}
    </Field>
  );
}
