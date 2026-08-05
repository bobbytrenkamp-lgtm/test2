import { useState } from 'react';
import { api } from '../api.js';
import { EmptyState, ErrorMessage, Field, Loading } from '../components.js';
import { formatDateTime } from '../format.js';
import { useMutation, useResource } from '../hooks.js';
import { useSession } from '../session.js';

/**
 * The review conversation about one record.
 *
 * It sits beside the numbers it is about rather than in a separate discussion,
 * because a criticism nobody reads next to the figure it criticises is a
 * criticism nobody acts on.
 *
 * Resolved comments are hidden by default. The open ones are the work; a list
 * that keeps everything forever is one people stop reading, and then an open
 * objection goes unnoticed.
 */

interface Comment {
  id: string;
  body: string;
  mentions: string[];
  created_at: string;
  resolved_at: string | null;
  author_id: string | null;
  author_name: string | null;
  author_email: string | null;
  resolved_by_name: string | null;
}

export function CommentThread({
  entityType,
  entityId,
  title = 'Review comments',
}: {
  entityType: 'model' | 'property' | 'budget_period';
  entityId: string;
  title?: string;
}): JSX.Element {
  const { session, can } = useSession();
  const [includeResolved, setIncludeResolved] = useState(false);
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);

  const comments = useResource<{ comments: Comment[] }>(
    `/comments?entityType=${entityType}&entityId=${entityId}&includeResolved=${includeResolved}`,
    [entityType, entityId, includeResolved],
  );

  // Fetched rather than read off the session: the session does not carry the
  // membership list, and the administrative one needs a permission an analyst
  // has no reason to hold.
  const mentionable = useResource<{ people: Array<{ user_id: string; name: string }> }>(
    can('comment:write') ? '/comments/mentionable' : null,
  );

  const post = useMutation(async () =>
    api.post('/comments', { entityType, entityId, body: draft, mentions }),
  );
  const resolve = useMutation(async (id: string) => api.post(`/comments/${id}/resolve`, {}));

  const colleagues = mentionable.data?.people ?? [];
  const mayComment = can('comment:write');
  const mayApprove = can('model:approve');

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (await post.run()) {
      setDraft('');
      setMentions([]);
      comments.reload();
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="badge">{comments.data?.comments.length ?? 0}</span>
        <div className="spacer" />
        <label className="row" style={{ gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(event) => setIncludeResolved(event.target.checked)}
          />
          Show resolved
        </label>
      </div>

      <ErrorMessage error={comments.error} />
      <ErrorMessage error={resolve.error} />
      {comments.loading && <Loading label="Loading comments" />}

      {comments.data && comments.data.comments.length === 0 ? (
        <EmptyState title={includeResolved ? 'Nothing raised' : 'Nothing open'}>
          {includeResolved
            ? 'No comment has been raised against this record.'
            : 'Every comment raised here has been resolved.'}
        </EmptyState>
      ) : (
        <ul className="comment-list">
          {(comments.data?.comments ?? []).map((comment) => {
            const mine = comment.author_id === session?.user.id;
            return (
              <li key={comment.id} className={comment.resolved_at ? 'comment resolved' : 'comment'}>
                <div className="row" style={{ gap: 8 }}>
                  <strong>{comment.author_name ?? comment.author_email ?? 'Someone'}</strong>
                  <span className="field-hint">{formatDateTime(comment.created_at)}</span>
                  {comment.resolved_at && (
                    <span className="badge positive">
                      Resolved{comment.resolved_by_name ? ` by ${comment.resolved_by_name}` : ''}
                    </span>
                  )}
                  <div className="spacer" />
                  {/* Only the author or an approver: closing someone else's
                      objection would make the review decorative. */}
                  {!comment.resolved_at && (mine || mayApprove) && (
                    <button
                      type="button"
                      className="subtle"
                      disabled={resolve.pending}
                      onClick={async () => {
                        if (await resolve.run(comment.id)) comments.reload();
                      }}
                    >
                      Resolve
                    </button>
                  )}
                </div>
                <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{comment.body}</p>
              </li>
            );
          })}
        </ul>
      )}

      {mayComment && (
        <form onSubmit={submit} style={{ marginTop: 12 }}>
          {post.error?.status === 400 ? (
            <div className="message error" role="alert">
              <strong>{post.error.message}</strong>
            </div>
          ) : (
            <ErrorMessage error={post.error} />
          )}

          <Field
            label="Add a comment"
            hint="Say what should change, not only that something is wrong."
          >
            <textarea
              required
              rows={3}
              maxLength={5000}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>

          {colleagues.length > 0 && (
            <Field
              label="Draw someone in"
              hint="Only members of this organization can be mentioned."
            >
              <select
                multiple
                size={Math.min(colleagues.length, 4)}
                value={mentions}
                onChange={(event) =>
                  setMentions([...event.target.selectedOptions].map((option) => option.value))
                }
              >
                {colleagues.map((member) => (
                  <option key={member.user_id} value={member.user_id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <button type="submit" className="primary" disabled={post.pending || draft.trim() === ''}>
            {post.pending ? 'Posting…' : 'Post comment'}
          </button>
        </form>
      )}
    </div>
  );
}
