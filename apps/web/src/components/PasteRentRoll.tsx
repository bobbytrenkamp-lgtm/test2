import { useState } from 'react';
import { api } from '../api.js';
import { ErrorMessage, Field } from '../components.js';
import { useMutation } from '../hooks.js';
import { titleCase } from '../format.js';

/**
 * Paste a rent roll straight out of a spreadsheet.
 *
 * An analyst's rent roll lives in Excel. Copying a block of cells and pasting
 * it is how they actually work, and asking them to save a CSV first is a step
 * that exists only because the software could not be bothered.
 *
 * The clipboard hands over tab-separated text, and the existing import pipeline
 * already detects its delimiter, finds the header row, matches columns and
 * normalises every value. So this is the same proven parser reached by a
 * different door — not a second, subtly different reader that would drift away
 * from the first.
 *
 * Nothing is written until the analyst has seen the findings.
 */
interface Analysis {
  batchId: string;
  headers: string[];
  headerRowIndex: number;
  confidence: number;
  suggestedMapping: Record<string, number>;
  rowCount: number;
}

interface Validation {
  readyToImport: boolean;
  leaseCount: number;
  issues: Array<{ rowIndex: number; severity: string; message: string; field?: string }>;
}

export function PasteRentRoll({
  modelId,
  onImported,
  onCancel,
}: {
  modelId: string;
  onImported: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [content, setContent] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);

  const check = useMutation(async () => {
    const analysed = await api.post<Analysis>(`/models/${modelId}/imports/analyze`, {
      filename: 'pasted-selection.tsv',
      content,
    });
    setAnalysis(analysed);
    const validated = await api.post<Validation>(`/models/${modelId}/imports/validate`, {
      batchId: analysed.batchId,
      content,
      mapping: analysed.suggestedMapping,
    });
    setValidation(validated);
    return validated;
  });

  const commit = useMutation(async () =>
    api.post<{ imported: number; skipped: number }>(`/models/${modelId}/imports/commit`, {
      batchId: analysis?.batchId,
      content,
      mapping: analysis?.suggestedMapping ?? {},
      skipRowsWithErrors: true,
    }),
  );

  const errors = validation?.issues.filter((issue) => issue.severity === 'error') ?? [];

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Paste from a spreadsheet</h3>
      <p className="field-hint" style={{ marginTop: 0 }}>
        Select the rows in Excel — including the header row — and paste them here. Columns are
        matched by name, every value is normalised, and you see the result before anything is
        written. Parsing happens on this deployment; the data is not sent anywhere else.
      </p>

      <Field
        label="Pasted rows"
        hint="Tab-separated is what the clipboard provides; comma-separated works too."
      >
        <textarea
          rows={8}
          value={content}
          spellCheck={false}
          placeholder={'Suite\tTenant\tArea\tStart\tEnd\tRent'}
          onChange={(event) => {
            setContent(event.target.value);
            setAnalysis(null);
            setValidation(null);
          }}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        />
      </Field>

      <ErrorMessage error={check.error} />
      <div className="row end">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!content.trim() || check.pending}
          onClick={() => void check.run()}
        >
          {check.pending ? 'Checking…' : 'Check the paste'}
        </button>
      </div>

      {analysis && validation && (
        <>
          <div
            className={`message ${errors.length > 0 ? 'warning' : 'info'}`}
            style={{ marginTop: 16 }}
            role="status"
            aria-label="Paste summary"
          >
            Header row {analysis.headerRowIndex + 1}, {analysis.rowCount} data rows,{' '}
            {(analysis.confidence * 100).toFixed(0)}% of columns recognised. {validation.leaseCount}{' '}
            lease{validation.leaseCount === 1 ? '' : 's'} would be written
            {errors.length > 0 ? `, and ${errors.length} row(s) skipped.` : '.'}
          </div>

          {validation.issues.length > 0 && (
            <div className="table-scroll" tabIndex={0} style={{ maxHeight: 220 }}>
              <table>
                <caption className="visually-hidden">Findings in the pasted rows</caption>
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Finding</th>
                  </tr>
                </thead>
                <tbody>
                  {validation.issues.slice(0, 60).map((issue, index) => (
                    <tr key={index}>
                      <td>{issue.rowIndex >= 0 ? issue.rowIndex + 1 : 'File'}</td>
                      <td>
                        <span
                          className={`badge ${issue.severity === 'error' ? 'negative' : 'warning'}`}
                        >
                          {titleCase(issue.severity)}
                        </span>
                      </td>
                      <td style={{ whiteSpace: 'normal', minWidth: '22rem' }}>{issue.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <ErrorMessage error={commit.error} />
          <div className="row end" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="primary"
              disabled={commit.pending || validation.leaseCount === 0}
              onClick={async () => {
                if (await commit.run()) onImported();
              }}
            >
              {commit.pending ? 'Importing…' : `Import ${validation.leaseCount} lease(s)`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
