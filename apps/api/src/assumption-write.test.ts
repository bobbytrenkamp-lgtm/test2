import { describe, expect, it } from 'vitest';
import { COLLECTIONS as TARGET_COLLECTIONS, MODEL_SECTIONS } from '@cre/domain-models';
import { COLLECTIONS as WRITE_COLLECTIONS, MODEL_COLUMNS } from './assumption-write.js';

/**
 * This file against the domain target registry, as the doc comment on
 * `assumption-write.ts` promises.
 *
 * The registry says what a target means; this file says how to write it.
 * They are two files because one is about domain shape and the other about
 * SQL columns and `upsert` wiring, but a target the registry calls writable
 * has to have somewhere to actually land, and a target this file can write
 * has to be one the registry — and therefore the target-dictionary endpoint
 * a Claude Skill reads — actually advertises. This test is what keeps a
 * change to one from silently stopping short of the other.
 */
describe('assumption-write targets match the domain registry', () => {
  it('has a column for every model-level target the registry lists', () => {
    const registryTargets = Object.entries(MODEL_SECTIONS).flatMap(([section, fields]) =>
      fields.map((field) => `${section}.${field.field}`),
    );
    const missing = registryTargets.filter((target) => !MODEL_COLUMNS[target]);
    expect(missing, `registry targets with no MODEL_COLUMNS entry: ${missing}`).toEqual([]);
  });

  it('has no column for a target the registry does not list', () => {
    // The other direction: a stray MODEL_COLUMNS entry would be writable
    // through the proposal decision route while invisible to the target
    // dictionary and to describeTarget's own resolution — reachable, but
    // undocumented and unreviewable.
    const registryTargets = new Set(
      Object.entries(MODEL_SECTIONS).flatMap(([section, fields]) =>
        fields.map((field) => `${section}.${field.field}`),
      ),
    );
    const stray = Object.keys(MODEL_COLUMNS).filter((target) => !registryTargets.has(target));
    expect(stray, `MODEL_COLUMNS entries not in the registry: ${stray}`).toEqual([]);
  });

  it('has an upsert for every collection the registry lists', () => {
    const registryCollections = TARGET_COLLECTIONS.map((entry) => entry.collection);
    const missing = registryCollections.filter((name) => !WRITE_COLLECTIONS[name]);
    expect(missing, `registry collections with no upsert wired: ${missing}`).toEqual([]);
  });

  it('has no upsert for a collection the registry does not list', () => {
    const registryCollections = new Set(TARGET_COLLECTIONS.map((entry) => entry.collection));
    const stray = Object.keys(WRITE_COLLECTIONS).filter((name) => !registryCollections.has(name));
    expect(stray, `wired collections not in the registry: ${stray}`).toEqual([]);
  });
});
