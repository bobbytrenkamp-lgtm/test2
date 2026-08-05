-- ---------------------------------------------------------------------------
-- 0010 - Keyset pagination on the audit log
--
-- Forward-only. Two indexes; no table or column changes.
-- ---------------------------------------------------------------------------

-- The audit log paginated by OFFSET. The load test measured that as fine at a
-- hundred thousand rows and it is: PostgreSQL still has to walk and discard
-- every skipped row, so page one is instant and page four hundred is not. An
-- audit log is the one table that only ever grows, and a compliance reader
-- paging through a year of history is exactly the deep scan offset is worst at.
--
-- Keyset pagination reads from where the last page stopped instead of counting
-- to it, so every page costs the same. It needs the ordering key to be unique,
-- which `occurred_at` is not — two rows written in the same millisecond would
-- otherwise straddle a page boundary and be shown twice or skipped entirely.
-- The id breaks the tie, so the index carries it too.
DROP INDEX IF EXISTS audit_log_org_time_idx;
CREATE INDEX audit_log_org_keyset_idx
  ON audit_log (organization_id, occurred_at DESC, id DESC);

DROP INDEX IF EXISTS audit_log_model_idx;
CREATE INDEX audit_log_model_keyset_idx
  ON audit_log (model_id, occurred_at DESC, id DESC);
