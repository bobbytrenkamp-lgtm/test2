import { useRef, useState } from 'react';
import { api } from '../api.js';
import { EmptyState, ErrorMessage, Loading } from '../components.js';
import { readAsBase64 } from '../files.js';
import { formatBytes, formatDateTime } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useSession } from '../session.js';

/**
 * Files attached to a property.
 *
 * `documents` (migration 0004) and `STORAGE_DRIVER` have existed since this
 * platform's first release, designed but never wired to a route or a
 * screen. Content travels as base64 in the same JSON body every other
 * upload in this application already sends (`ImportsTab`'s rent-roll and
 * workbook uploads), so this is the only place a document is fetched with
 * `Content-Type: application/json`, and the only place it comes back as raw
 * bytes for a browser download.
 */

interface DocumentRow {
  id: string;
  filename: string;
  content_type: string;
  byte_size: string;
  scan_status: string;
  uploaded_by_name: string | null;
  created_at: string;
}

export function DocumentsCard({ propertyId }: { propertyId: string }): JSX.Element {
  const { can } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pendingFilename, setPendingFilename] = useState<string | null>(null);

  const documents = useResource<{ documents: DocumentRow[] }>(
    `/documents?propertyId=${propertyId}`,
  );
  const upload = useMutation(async (file: File) =>
    api.post('/documents', {
      propertyId,
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      content: await readAsBase64(file),
    }),
  );
  const remove = useMutation(async (id: string) => api.delete(`/documents/${id}`));

  async function handleUpload(file: File): Promise<void> {
    setPendingFilename(file.name);
    if (await upload.run(file)) documents.reload();
    setPendingFilename(null);
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Documents</h2>
        <span className="badge">{documents.data?.documents.length ?? 0}</span>
        <div className="spacer" />
        {can('property:write') && (
          <>
            <label htmlFor="document-upload" className="visually-hidden">
              Upload a document
            </label>
            <input
              ref={inputRef}
              id="document-upload"
              type="file"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void handleUpload(file);
              }}
            />
            <button
              type="button"
              disabled={upload.pending}
              onClick={() => inputRef.current?.click()}
            >
              {upload.pending ? `Uploading ${pendingFilename ?? ''}…` : 'Upload a document'}
            </button>
          </>
        )}
      </div>

      <ErrorMessage error={upload.error} />
      <ErrorMessage error={remove.error} />
      {documents.loading && <Loading label="Loading documents" />}

      {documents.data && documents.data.documents.length === 0 ? (
        <EmptyState title="No documents yet">
          Leases, offering memoranda, appraisals and anything else worth keeping beside this asset
          can be attached here.
        </EmptyState>
      ) : (
        documents.data && (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">Documents attached to this property</caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Uploaded</th>
                  <th scope="col" className="numeric">
                    Size
                  </th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {documents.data.documents.map((document) => (
                  <tr key={document.id}>
                    <th scope="row" style={{ fontWeight: 600 }}>
                      <a
                        href={`/api/v1/documents/${document.id}/download`}
                        download={document.filename}
                      >
                        {document.filename}
                      </a>
                    </th>
                    <td>
                      {document.uploaded_by_name ?? 'Someone'} ·{' '}
                      {formatDateTime(document.created_at)}
                    </td>
                    <td className="numeric">{formatBytes(document.byte_size)}</td>
                    <td>
                      {can('property:write') && (
                        <button
                          type="button"
                          className="subtle"
                          disabled={remove.pending}
                          onClick={async () => {
                            if (
                              window.confirm(`Delete "${document.filename}"?`) &&
                              (await remove.run(document.id))
                            )
                              documents.reload();
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
