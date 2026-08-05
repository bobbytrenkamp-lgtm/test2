-- ---------------------------------------------------------------------------
-- 0009 - Fund investors, commitments and capital transactions
--
-- Forward-only. New tables and two nullable columns; nothing an existing row
-- could fail.
-- ---------------------------------------------------------------------------

-- The `funds` table has existed since 0002 and has been unused: there was
-- nowhere to record who committed capital to one, so nothing could be reported
-- about it. A fund is not a bigger property — its investors commit, the manager
-- calls capital over time, and distributions come back on their own schedule.
-- Those are the flows the return is solved from.

CREATE TABLE fund_investors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id         uuid NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Stable identifier used in reports, chosen by the user, as everywhere else.
  code            text NOT NULL,
  name            text NOT NULL,
  investor_class  text NOT NULL DEFAULT 'lp' CHECK (investor_class IN ('lp', 'gp')),
  commitment      numeric(20, 2) NOT NULL DEFAULT 0 CHECK (commitment >= 0),
  contact_email   text,
  notes           text,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fund_id, code)
);
CREATE INDEX fund_investors_fund_idx ON fund_investors (fund_id);

-- Capital called and capital returned. The amount is always positive and the
-- direction comes from `type`: a signed amount invites a contribution recorded
-- as a negative that then reads as a distribution, and nothing downstream could
-- tell the difference.
CREATE TABLE fund_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_id       uuid NOT NULL REFERENCES funds(id) ON DELETE CASCADE,
  investor_id   uuid NOT NULL REFERENCES fund_investors(id) ON DELETE CASCADE,
  transaction_date date NOT NULL,
  type          text NOT NULL CHECK (type IN ('contribution', 'distribution')),
  amount        numeric(20, 2) NOT NULL CHECK (amount > 0),
  reference     text,
  notes         text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fund_transactions_fund_idx ON fund_transactions (fund_id, transaction_date);
CREATE INDEX fund_transactions_investor_idx ON fund_transactions (investor_id);

-- Which portfolio a fund holds, so residual value can come from the same
-- aggregation the portfolio screen already reports rather than a second,
-- divergent roll-up.
ALTER TABLE funds
  ADD COLUMN portfolio_id uuid REFERENCES portfolios(id) ON DELETE SET NULL,
  ADD COLUMN version integer NOT NULL DEFAULT 1;
