-- ---------------------------------------------------------------------------
-- 0028 - Fund-level recallable distributions
--
-- Forward-only. A new nullable-by-default column and a widened CHECK
-- constraint; nothing an existing row could fail against.
-- ---------------------------------------------------------------------------

-- Whether a distribution may be drawn back later is an LPA term the caller
-- states, not something this schema infers. Meaningful only on a
-- 'distribution' row; not enforced against a later 'recall', because this
-- table records what happened, not what the governing document permits.
ALTER TABLE fund_transactions
  ADD COLUMN recallable boolean NOT NULL DEFAULT false;

-- rollback-unsafe: replaces fund_transactions_type_check with a strictly
-- wider one (adds 'recall' to the allowed set; drops nothing the previous
-- release, 0027 and earlier, ever wrote). check:migrations flags any DROP
-- CONSTRAINT on principle, but this one is additive in effect: the previous
-- release only ever inserts 'contribution' or 'distribution', both still
-- accepted, so redeploying it against this schema is unaffected.
ALTER TABLE fund_transactions
  DROP CONSTRAINT fund_transactions_type_check,
  ADD CONSTRAINT fund_transactions_type_check
    CHECK (type IN ('contribution', 'distribution', 'recall'));
