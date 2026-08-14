-- Traceability for a growth curve created from the organization's library
-- (migration 0020): which template it started from, and what that template
-- was called at the moment it was applied.
--
-- Deliberately not a foreign key to growth_curve_templates. A live reference
-- is exactly what this feature is not: editing or deleting the library entry
-- later must never change, break, or cascade into a model that already
-- applied it. A plain text snapshot of the template's code and name is an
-- honest historical record even after the template it names is gone --
-- "started from a library entry that no longer exists" is still true and
-- still worth knowing, the same way an audit log entry naming a deleted user
-- stays legible.
--
-- Both columns are null for the overwhelming majority of existing rows --
-- every growth curve a model has ever had, since this app has never had a
-- library to start one from before now -- and stay null for any curve
-- entered by hand going forward. Additive and backward compatible: a
-- previous release reading this table sees two columns it does not
-- recognise and nothing else changes shape underneath it.

ALTER TABLE growth_curves
  ADD COLUMN source_template_code text,
  ADD COLUMN source_template_name text;
