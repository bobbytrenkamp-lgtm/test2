-- CHECK constraints on four enum-shaped text columns that never had one.
--
-- rate_type (migration 0003) and the valuation-section enums have always
-- refused a value outside their real set. These four columns store the same
-- kind of value -- a fixed vocabulary the engine's own zod schema enforces
-- on every ordinary write -- but had no equivalent CHECK, so nothing at the
-- data layer stopped an invalid value from being written through a path
-- that does not go through that schema. An accepted assumption proposal is
-- exactly such a path: `validateTypedValue`'s `'enum'` case only checked
-- that a value was non-empty text, never that it was one of the target's own
-- allowed values, so an analyst accepting a mistyped proposal (or a
-- `market_data`/`calculated` source sending one) wrote a string the engine's
-- `parseModelInput` schema would refuse on the very next calculation --
-- corrupting the model until someone found and repaired the row by hand.
-- `validateTypedValue` is fixed separately to catch this before the write;
-- this is the same fix again at the layer that cannot be bypassed by a
-- caller nobody anticipated.
--
-- Additive from the previous release's point of view: it only ever wrote
-- values already inside these sets (they come from the same zod enums this
-- migration's own lists are copied from), so nothing it does is refused here.

ALTER TABLE operating_expenses
  ADD CONSTRAINT operating_expenses_method_check CHECK (method IN (
    'fixed_annual', 'per_area_per_year', 'per_unit_per_year',
    'percent_of_effective_gross_revenue', 'percent_of_base_rent',
    'custom_monthly_schedule'
  ));

ALTER TABLE other_revenue_items
  ADD CONSTRAINT other_revenue_items_method_check CHECK (method IN (
    'fixed_annual', 'per_unit_per_month', 'per_area_per_year',
    'percent_of_base_rent', 'custom_monthly_schedule'
  ));

ALTER TABLE capital_items
  ADD CONSTRAINT capital_items_method_check CHECK (method IN (
    'fixed_annual', 'per_area_per_year', 'per_unit_per_year',
    'custom_monthly_schedule', 'one_time'
  ));

ALTER TABLE market_leasing_profiles
  ADD CONSTRAINT market_leasing_profiles_market_rent_basis_check CHECK (market_rent_basis IN (
    'per_area_per_year', 'per_area_per_month', 'annual_amount',
    'monthly_amount', 'per_unit_per_month'
  ));
