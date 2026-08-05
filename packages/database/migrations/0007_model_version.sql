-- ---------------------------------------------------------------------------
-- 0007 - Optimistic concurrency control on models
--
-- Forward-only and backward compatible: a defaulted column, no constraint an
-- existing row could fail.
-- ---------------------------------------------------------------------------

-- Leases got this in 0006 after the concurrency test found simultaneous writes
-- silently discarding one another. A model's assumptions carry the same
-- exposure and rather more leverage: a discount rate or an exit capitalisation
-- rate moves every figure in the valuation at once, so two people adjusting
-- them at the same time is exactly the collision worth refusing.
--
-- `version` increments on every write. A caller that read the model can send
-- the version it saw; if the stored one has moved, the write is refused rather
-- than applied over an assumption the caller never saw.
--
-- Deliberately not covering the assumption collections (expenses, capital,
-- debt and the rest). Those are separate rows edited one at a time, and binding
-- them to a single model-wide version would make two people editing unrelated
-- collections collide for no reason. They need their own row-level versions;
-- see docs/implementation-roadmap.md.
ALTER TABLE models
  ADD COLUMN version integer NOT NULL DEFAULT 1;
