-- ---------------------------------------------------------------------------
-- 0029 - Fund-level carried interest and catch-up: waterfall tiers
--
-- Forward-only. A new column with a safe default; nothing an existing row
-- could fail against.
-- ---------------------------------------------------------------------------

-- The tiers a fund's distributions are proposed against: return of capital,
-- a preferred return, a GP catch-up, a residual split, in whatever order and
-- combination the governing document uses. Shaped exactly like a deal's own
-- equity_structure.tiers (models.equity_structure, migration 0003) --
-- computeFundWaterfall's splits[].partnerId names a fund_investors.id here
-- rather than a deal partner, since a fund's investors are the only parties
-- a fund waterfall ever has. Defaults to an empty array, which is exactly
-- what every fund written before this column existed means: no stated
-- waterfall, so no distribution can be proposed until one is.
ALTER TABLE funds
  ADD COLUMN waterfall_tiers jsonb NOT NULL DEFAULT '[]'::jsonb;
