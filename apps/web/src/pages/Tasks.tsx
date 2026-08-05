import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { EmptyState, ErrorMessage, Field, Loading, StatusBadge } from '../components.js';
import { formatDate } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useSession } from '../session.js';

/**
 * The asset-management board.
 *
 * A model says what a building is expected to do. This says what somebody is
 * supposed to do about it, and — the part that makes it worth having at all —
 * which building or model that work is against, so it is visible to whoever
 * picks the asset up next rather than only to whoever was on the email.
 *
 * ## Today
 *
 * "Overdue" is decided here, in the browser, from the reader's own clock, and
 * sent to the server as a date. The alternative is the server answering in its
 * own timezone, which is wrong for anybody who is not in it — and on a screen
 * whose whole purpose is telling you what is late, being a day out is not a
 * small error.
 */

interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  due_date: string | null;
  property_id: string | null;
  property_name: string | null;
  model_id: string | null;
  model_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  created_by_name: string | null;
  created_at: string;
  completed_at: string | null;
}

const STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;

/** The reader's own calendar date, as YYYY-MM-DD. */
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The date part of whatever the column serialised to.
 *
 * `due_date` is a PostgreSQL `date` and arrives as a full timestamp. Comparing
 * the raw strings happens to work — ISO-8601 sorts lexicographically — but only
 * by accident of the trailing time being longer than nothing, and a screen that
 * tells people what is late should not be right by accident.
 */
const dayOf = (value: string): string => value.slice(0, 10);

const isLate = (task: Task, now: string): boolean =>
  task.due_date !== null && dayOf(task.due_date) < now && task.completed_at === null;

export function TasksPage(): JSX.Element {
  const { session, can } = useSession();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [adding, setAdding] = useState(false);

  const now = today();
  const query = new URLSearchParams();
  if (includeClosed) query.set('includeClosed', 'true');
  if (mineOnly && session) query.set('assigneeId', session.user.id);
  if (overdueOnly) query.set('overdueAsOf', now);

  const tasks = useResource<{ tasks: Task[] }>(`/tasks?${query.toString()}`, [
    includeClosed,
    mineOnly,
    overdueOnly,
  ]);
  const properties = useResource<{ properties: Array<{ id: string; name: string }> }>(
    can('task:write') ? '/properties' : null,
  );
  /*
   * The assignee picker needs "people in my organization I may name", which is
   * exactly what the mention list already is — so it is reused rather than
   * duplicated, and gated on the capability that endpoint actually requires
   * rather than on `task:write`. Every role that can raise a task can also
   * comment, so in practice the picker is always populated; asking for the
   * wrong capability would turn a future divergence into a 403 in the console
   * instead of an empty list.
   */
  const colleagues = useResource<{ people: Array<{ user_id: string; name: string }> }>(
    can('comment:write') ? '/comments/mentionable' : null,
  );

  const update = useMutation(async (id: string, patch: Record<string, unknown>) =>
    api.patch(`/tasks/${id}`, patch),
  );

  const mayWrite = can('task:write');
  const rows = tasks.data?.tasks ?? [];
  const overdueCount = rows.filter((task) => isLate(task, now)).length;

  return (
    <>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h1 style={{ margin: 0 }}>Tasks</h1>
          <span className="badge">{rows.length}</span>
          {overdueCount > 0 && <span className="badge negative">{overdueCount} overdue</span>}
          <div className="spacer" />
          {mayWrite && (
            <button type="button" className="primary" onClick={() => setAdding((value) => !value)}>
              {adding ? 'Cancel' : 'Add task'}
            </button>
          )}
        </div>

        <p className="field-hint" style={{ marginTop: 0 }}>
          Work against a property or a model, so it stays with the asset rather than in somebody’s
          inbox. Dates are read against your own calendar, not the server’s.
        </p>

        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(event) => setMineOnly(event.target.checked)}
            />
            Assigned to me
          </label>
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(event) => setOverdueOnly(event.target.checked)}
            />
            Overdue or due today
          </label>
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(event) => setIncludeClosed(event.target.checked)}
              // Closing a task while the closed ones are hidden makes it vanish;
              // that is the point, but only if the reader can get it back.
            />
            Show finished and cancelled
          </label>
        </div>
      </div>

      {adding && mayWrite && (
        <NewTask
          properties={properties.data?.properties ?? []}
          people={colleagues.data?.people ?? []}
          onCreated={() => {
            setAdding(false);
            tasks.reload();
          }}
        />
      )}

      <div className="card">
        <ErrorMessage error={tasks.error} />
        <ErrorMessage error={update.error} />
        {tasks.loading && <Loading label="Loading tasks" />}

        {tasks.data && rows.length === 0 ? (
          <EmptyState title={includeClosed ? 'No tasks' : 'Nothing outstanding'}>
            {includeClosed
              ? 'No work has been raised in this organization yet.'
              : 'Every task raised here has been finished or cancelled.'}
          </EmptyState>
        ) : (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="visually-hidden">
                Outstanding asset-management tasks, soonest due first.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Against</th>
                  <th scope="col">Assigned to</th>
                  <th scope="col">Due</th>
                  <th scope="col">Status</th>
                  {mayWrite && <th scope="col">Move to</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((task) => {
                  const late = isLate(task, now);
                  return (
                    <tr key={task.id}>
                      <th scope="row">
                        {task.title}
                        {task.description && (
                          <div className="field-hint" style={{ fontWeight: 400 }}>
                            {task.description}
                          </div>
                        )}
                      </th>
                      <td>
                        {task.model_id ? (
                          <Link to={`/models/${task.model_id}`}>{task.model_name}</Link>
                        ) : task.property_id ? (
                          <Link to={`/properties/${task.property_id}`}>{task.property_name}</Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{task.assignee_name ?? 'Nobody'}</td>
                      <td className={late ? 'negative' : ''}>
                        {task.due_date ? formatDate(task.due_date) : '—'}
                        {late && <span className="visually-hidden"> — overdue</span>}
                      </td>
                      <td>
                        <StatusBadge status={task.status} />
                      </td>
                      {mayWrite && (
                        <td>
                          <label className="visually-hidden" htmlFor={`status-${task.id}`}>
                            Status of {task.title}
                          </label>
                          <select
                            id={`status-${task.id}`}
                            value={task.status}
                            disabled={update.pending}
                            onChange={async (event) => {
                              if (await update.run(task.id, { status: event.target.value })) {
                                tasks.reload();
                              }
                            }}
                          >
                            {STATUSES.map((status) => (
                              <option key={status} value={status}>
                                {status.replace(/_/g, ' ')}
                              </option>
                            ))}
                          </select>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function NewTask({
  properties,
  people,
  onCreated,
}: {
  properties: Array<{ id: string; name: string }>;
  people: Array<{ user_id: string; name: string }>;
  onCreated: () => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [propertyId, setPropertyId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');

  const create = useMutation(async () =>
    api.post('/tasks', {
      title,
      // Empty strings are not "no value": the server takes an absent key for
      // that, and would reject "" against the date pattern.
      ...(description ? { description } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(propertyId ? { propertyId } : {}),
      ...(assigneeId ? { assigneeId } : {}),
    }),
  );

  return (
    <div className="card">
      <h2>Add a task</h2>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await create.run()) onCreated();
        }}
      >
        <ErrorMessage error={create.error} />

        <Field label="What needs doing" hint="Short enough to read on a board.">
          <input
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>

        <Field label="Detail" hint="Optional. The context somebody picking this up would want.">
          <textarea
            rows={2}
            maxLength={5000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <div className="form-grid">
          {/* "Due date", not "Due": the board's filter is named for dueness
              too, and two controls a screen reader announces as near-identical
              is a real ambiguity, not just an awkward test selector. */}
          <Field label="Due date" hint="Optional. Undated work sorts after dated work.">
            <input
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </Field>

          <Field label="Property" hint="Optional. Keeps the work with the asset.">
            <select value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>
              <option value="">Not about one property</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Assign to" hint="Optional. Only members of this organization.">
            <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
              <option value="">Nobody yet</option>
              {people.map((person) => (
                <option key={person.user_id} value={person.user_id}>
                  {person.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <button type="submit" className="primary" disabled={create.pending}>
          {create.pending ? 'Saving…' : 'Add task'}
        </button>
      </form>
    </div>
  );
}
