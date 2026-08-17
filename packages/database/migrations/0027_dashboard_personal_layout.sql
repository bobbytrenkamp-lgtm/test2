-- Configurable dashboards: one personal layout per person per scope.
--
-- `dashboards` (migration 0004) has stood ready since this platform's first
-- release -- scope, layout jsonb, owner_id, is_shared -- but nothing wrote
-- or read it. This is the write path's missing piece: an upsert needs a
-- unique target, and none existed. Scoped to a personal row (owner_id set,
-- is_shared false) at an unqualified scope (scope_id null) -- the only shape
-- this release's API actually writes; a future shared or scope_id-qualified
-- dashboard is additive; it does not need this index to already anticipate it.
CREATE UNIQUE INDEX dashboards_personal_idx ON dashboards (organization_id, scope, owner_id)
  WHERE scope_id IS NULL AND owner_id IS NOT NULL AND NOT is_shared;
