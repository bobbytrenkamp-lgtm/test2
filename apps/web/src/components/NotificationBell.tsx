import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { ErrorMessage } from '../components.js';
import { formatDateTime } from '../format.js';
import { useMutation, useResource } from '../hooks.js';

/**
 * What involves you.
 *
 * A mention has always been recorded on the comment it was made in
 * (`CommentThread.tsx`), but until now it only ever surfaced to someone who
 * happened to reopen that thread. This polls `GET /notifications` — a light
 * interval, not a socket, matching the rest of this application's read model
 * — and lets a mention be read (and the whole feed cleared) from one place
 * that follows you between screens rather than being anchored to any one of
 * them.
 */

const POLL_INTERVAL_MS = 30_000;

interface NotificationRow {
  id: string;
  href: string | null;
  excerpt: string;
  actor_name: string | null;
  read_at: string | null;
  created_at: string;
}

interface NotificationFeed {
  notifications: NotificationRow[];
  unreadCount: number;
}

export function NotificationBell(): JSX.Element {
  const [open, setOpen] = useState(false);
  const feed = useResource<NotificationFeed>('/notifications');
  const markRead = useMutation((id: string) => api.post(`/notifications/${id}/read`));
  const markAll = useMutation(() => api.post('/notifications/read-all'));
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const interval = setInterval(feed.reload, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [feed.reload]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onClick = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const notifications = feed.data?.notifications ?? [];
  const unreadCount = feed.data?.unreadCount ?? 0;

  async function openNotification(notification: NotificationRow): Promise<void> {
    setOpen(false);
    if (!notification.read_at) {
      await markRead.run(notification.id);
      feed.reload();
    }
  }

  return (
    <div className="notification-bell" ref={containerRef}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="notification-panel"
        onClick={() => setOpen((value) => !value)}
      >
        Notifications
        {unreadCount > 0 && (
          <span className="badge accent" style={{ marginLeft: 6 }}>
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          id="notification-panel"
          role="region"
          aria-label="Notifications"
          className="notification-panel"
        >
          <div className="notification-panel-header">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void markAll.run().then(() => feed.reload())}
                disabled={markAll.pending}
              >
                Mark all read
              </button>
            )}
          </div>
          <ErrorMessage error={markAll.error ?? markRead.error} />
          {notifications.length === 0 ? (
            <p className="notification-empty">Nobody has mentioned you yet.</p>
          ) : (
            <ul className="notification-list">
              {notifications.map((notification) => {
                const body = (
                  <>
                    <span className="notification-actor">
                      {notification.actor_name ?? 'Someone'}
                    </span>{' '}
                    mentioned you: <q>{notification.excerpt}</q>
                    <span className="notification-time">
                      {formatDateTime(notification.created_at)}
                    </span>
                  </>
                );
                const className = notification.read_at
                  ? 'notification-item'
                  : 'notification-item unread';
                return (
                  <li key={notification.id} className={className}>
                    {notification.href ? (
                      <Link
                        to={notification.href}
                        onClick={() => void openNotification(notification)}
                      >
                        {body}
                      </Link>
                    ) : (
                      <button type="button" onClick={() => void openNotification(notification)}>
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
