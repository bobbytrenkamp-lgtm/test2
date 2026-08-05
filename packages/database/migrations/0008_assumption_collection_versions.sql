-- ---------------------------------------------------------------------------
-- 0008 - Optimistic concurrency control on the assumption collections
--
-- Forward-only and backward compatible: defaulted columns, no constraint an
-- existing row could fail.
-- ---------------------------------------------------------------------------

-- 0007 gave models a version and deliberately stopped there, because binding
-- these tables to a model-wide version would make two people editing unrelated
-- collections collide for no reason: one analyst adding a roof replacement and
-- another adjusting the insurance line are not in conflict, and software that
-- says they are gets ignored.
--
-- Each row therefore carries its own version. Two people editing the same
-- expense line collide, as they should; two people editing different lines of
-- the same model do not.
--
-- The lease table already had this from 0006. These six are every remaining
-- table the assumptions editor writes to.
ALTER TABLE operating_expenses ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE other_revenue_items ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE capital_items ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE debt_facilities ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE growth_curves ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE market_leasing_profiles ADD COLUMN version integer NOT NULL DEFAULT 1;
