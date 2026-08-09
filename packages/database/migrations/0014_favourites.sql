-- Pinned properties and models, per person.
--
-- Purely additive: the previous release never reads or writes this table, so
-- every screen behaves exactly as it does today. See scripts/check-migrations.mjs.

-- A property or model somebody chose to keep at hand.
--
-- Server-side rather than in the browser, deliberately, and the *only* half of
-- "recents and favourites" that is. A favourite is a decision — this is one of
-- the six assets I am actually working on — and a decision should follow the
-- person to whatever machine they sign in from. A recently-viewed list is not a
-- decision; it is a trace of one device's afternoon, it is different on a
-- laptop and a desk machine for good reason, and storing it would mean writing
-- a row on every navigation to record something nobody asked for.
--
-- Scoped by organization as well as by user. Somebody who belongs to two
-- organizations is doing two different jobs, and a list mixing both would be
-- useless in each.
CREATE TABLE user_favourites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- 'property' or 'model'. Text rather than an enumeration so a third kind can
  -- be pinned without a migration; an unrecognised kind is skipped when the
  -- list is resolved rather than breaking the screen.
  entity_type     text NOT NULL CHECK (entity_type IN ('property', 'model')),

  -- Not a foreign key, because it addresses two different tables. The read
  -- joins to whichever the type names and drops rows whose target is gone, so a
  -- deleted model leaves no dangling entry on anybody's dashboard.
  entity_id       uuid NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Pinning twice is the same as pinning once, and the toggle depends on it.
CREATE UNIQUE INDEX user_favourites_unique_idx
  ON user_favourites (user_id, organization_id, entity_type, entity_id);

-- The list is read for one person in one organization, newest first.
CREATE INDEX user_favourites_owner_idx
  ON user_favourites (user_id, organization_id, created_at DESC);
