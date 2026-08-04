-- ---------------------------------------------------------------------------
-- 0005 - Budget account classification and variance approval
--
-- Forward-only and backward compatible, per docs/deployment-guide.md: this adds
-- columns with defaults and adds no constraint that existing rows could fail.
-- ---------------------------------------------------------------------------

-- What a budget or actuals line represents. Used for grouping and subtotals.
--
-- It deliberately plays no part in deciding whether a variance is favourable.
-- Amounts follow the cash-flow sign convention — money in positive, money out
-- negative — under which a favourable variance is simply a positive one, for
-- every account. A miscategorised row therefore lands in the wrong subtotal,
-- which someone notices, rather than reversing its own variance, which nobody
-- would. See docs/calculation-specification.md.
ALTER TABLE budget_entries
  ADD COLUMN account_category text NOT NULL DEFAULT 'other'
    CHECK (account_category IN (
      'revenue', 'operating_expense', 'capital', 'debt_service', 'other'));

-- Reading a variance report costs nothing; the expensive query is the one that
-- pulls a whole year of entries for one period, which is what this serves.
CREATE INDEX IF NOT EXISTS budget_entries_account_idx
  ON budget_entries (budget_period_id, account_code);

-- Commentary is written by an asset manager and signed off by a reviewer, so
-- the two roles have to be distinguishable after the fact. `approved_by` and
-- `approved_at` already exist; this records what was actually agreed to, since
-- editing commentary after approval would otherwise silently change what the
-- reviewer signed.
ALTER TABLE variance_commentary
  ADD COLUMN approved_text text;

-- A property's commentary for one account in one month is one thread, not many.
-- Without this, two people writing at once silently produce two rows and one of
-- them is invisible in a report that takes the first.
CREATE UNIQUE INDEX IF NOT EXISTS variance_commentary_unique_idx
  ON variance_commentary (property_id, fiscal_year, period_month, account_code);
