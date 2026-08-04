-- ---------------------------------------------------------------------------
-- 0006 - Optimistic concurrency control on leases
--
-- Forward-only and backward compatible: a defaulted column, no constraint an
-- existing row could fail.
-- ---------------------------------------------------------------------------

-- The concurrency test measured ten simultaneous writes to one lease: all ten
-- succeeded and the last one won. Two analysts editing the same lease did not
-- collide, and the second save silently discarded the first — on a record that
-- decides what a property is worth.
--
-- `version` increments on every write. A caller that read the lease can send
-- the version it saw; if the stored one has moved, the write is refused rather
-- than applied over work the caller never saw.
ALTER TABLE leases
  ADD COLUMN version integer NOT NULL DEFAULT 1;
