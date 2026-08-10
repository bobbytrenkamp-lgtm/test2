/**
 * The application's own release version — distinct from `ENGINE_VERSION`
 * (`@cre/calculation-engine`), which identifies the calculation logic that
 * produced a given result and is stored with every calculation run.
 *
 * A support conversation needs both: the engine version says which formulas
 * ran, and this says which build of the surrounding application — routes,
 * validation, the write paths — a customer was actually using when something
 * went wrong. Bumped by hand alongside `package.json`'s own version, rather
 * than read from it at startup, so the two cannot drift from what was
 * actually deployed by an unrelated `npm version` bump landing between a
 * build and a release.
 */
export const APP_VERSION = '0.1.0';
