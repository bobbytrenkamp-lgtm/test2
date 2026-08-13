-- Two more enum-shaped text columns found by the same sweep as migration
-- 0017, without a CHECK constraint: `capital_items.category` and
-- `debt_facilities.type`. Both are real zod enums in model-input.ts
-- (capitalItemSchema.category, debtTypeEnum) with no data-layer guard, the
-- same gap 0017 closed for the four columns an accepted assumption proposal
-- could actually reach. These two are not reachable through that same path
-- today (neither appears in assumption-targets.ts's writable-target
-- registry), but registerCollection's generic collection routes
-- (apps/api/src/routes/models.ts) write to both with no schema validation
-- of their own -- the larger, not-yet-fixed gap noted in the 0017 PR -- so
-- closing the data-layer gap now is cheap insurance against exactly the
-- silent-corruption failure mode 0017 fixed, rather than waiting on that
-- larger fix to land first.
--
-- Additive from the previous release's point of view: it only ever wrote
-- values already inside these sets, so nothing it does is refused here.

ALTER TABLE capital_items
  ADD CONSTRAINT capital_items_category_check CHECK (category IN (
    'recurring_capital', 'replacement_reserve', 'major_project',
    'building_improvement', 'deferred_maintenance', 'development_hard_cost',
    'development_soft_cost', 'contingency', 'other'
  ));

ALTER TABLE debt_facilities
  ADD CONSTRAINT debt_facilities_type_check CHECK (type IN (
    'acquisition', 'permanent', 'construction', 'bridge', 'revolver',
    'mezzanine', 'preferred_equity', 'seller_financing', 'supplemental'
  ));
