-- Import rollback.
--
-- import_batches.status has allowed 'rolled_back' since migration 0004 --
-- rollback was designed in from the start but never implemented
-- (docs/feature-status.md recorded this honestly: "Import is transactional;
-- no undo after commit"). This is the missing piece: a snapshot of what each
-- affected lease looked like immediately before the commit that touched it,
-- captured at commit time, so a rollback can restore exactly that -- delete
-- a lease the import created fresh, or put back the exact previous row
-- (including its rent steps and spaces) for a lease the import only updated.
--
-- Both columns are nullable and additive. Every row written before this
-- migration has rollback_snapshot = NULL; the rollback route refuses such a
-- batch with a clear reason rather than attempting to restore from nothing.
ALTER TABLE import_batches
  ADD COLUMN rollback_snapshot jsonb,
  ADD COLUMN rolled_back_at timestamptz;
