-- Mention notifications.
--
-- comments.mentions has stored who was drawn into a discussion since
-- migration 0004, but nobody was ever told out of band -- the mention sat in
-- the thread until somebody happened to reopen it. docs/feature-status.md
-- recorded this honestly ("A mention is recorded on the comment and shown in
-- the thread; nobody is told out of band"). This table is the missing piece:
-- one row per person a comment drew in, so a personal feed and an unread
-- count are both just a query away.
--
-- No `type` column -- a mention is the only thing that creates a
-- notification today, and a column with one possible value names nothing.
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  comment_id      uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_id, read_at, created_at DESC);
