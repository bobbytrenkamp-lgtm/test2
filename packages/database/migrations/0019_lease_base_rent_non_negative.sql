-- A CHECK constraint on leases.base_rent, mirroring leases_area_non_negative
-- (migration 0003), which base_rent never had.
--
-- Found by a fourteenth audit pass: the rent-roll importer's own number
-- parser (`normalizeNumber`) reads accounting notation -- "(30.00)" -- as
-- negative by design, correct for a P&L figure but never meaningful for a
-- contractual rent rate. `mapRows` already rejected a negative area outright;
-- base rent had no equivalent check, at the importer, at the manual
-- add/edit-lease routes, or here. A stray credit column, a misidentified
-- subtotal row, or a plain minus-sign typo all passed straight through --
-- imported, calculated, and reported with no diagnostic anywhere, silently
-- understating gross potential rent, NOI and every return metric built on it.
-- `mapRows` is fixed separately (packages/reporting/src/rent-roll-import.ts)
-- to catch this before the write, with a clear message naming the row; this
-- is the same fix again at the layer that cannot be bypassed by a caller
-- nobody anticipated -- the same reasoning migrations 0017 and 0018 already
-- used for the enum columns they added CHECK constraints to.
--
-- Additive from the previous release's point of view: a lease with a
-- negative base rent was never a value this platform's own UI or import path
-- could produce on purpose, so nothing legitimate is refused here.

ALTER TABLE leases
  ADD CONSTRAINT leases_base_rent_non_negative CHECK (base_rent >= 0);
