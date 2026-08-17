import { describe, expect, it } from 'vitest';
import {
  generateCreosUlid,
  isValidCreosUlid,
  creosDisplayId,
  CreosUlidSchema,
  CreosPropertyIdSchema,
  MAX_CREOS_ULID_TIMESTAMP_MS,
  newCreosPropertyId,
  newCreosDealId,
  newCreosMarketId,
  newCreosReportId,
} from './creos-ids.js';

/**
 * Reference values are the same ones test4 (CREOS Enterprise) verified
 * independently in Python against the ULID spec's own reference algorithm
 * (repeated `divmod(n, 32)`, most-significant digit first) — see
 * test4/src/domain/ids.test.ts and test4/BUG_TRACKER.md's BUG-005.
 * Re-checking them here catches this port drifting from the spec-verified
 * original, not just from itself.
 */
const KNOWN_TIMESTAMP_VECTORS: Array<[timestamp: number, expectedPrefix: string]> = [
  [0, '0000000000'],
  [1, '0000000001'],
  [31, '000000000Z'],
  [32, '0000000010'],
  [1000, '00000000Z8'],
  [1_700_000_000_000, '01HF7YAT00'],
  [281_474_976_710_655, '7ZZZZZZZZZ'], // MAX_CREOS_ULID_TIMESTAMP_MS
];

describe('generateCreosUlid — known timestamp vectors (BUG-005 regression, ported)', () => {
  it.each(KNOWN_TIMESTAMP_VECTORS)('timestamp %i encodes to prefix %s', (timestamp, expectedPrefix) => {
    expect(generateCreosUlid(timestamp).slice(0, 10)).toBe(expectedPrefix);
  });

  it('MAX_CREOS_ULID_TIMESTAMP_MS matches 2^48 - 1', () => {
    expect(MAX_CREOS_ULID_TIMESTAMP_MS).toBe(2 ** 48 - 1);
  });

  it('rejects a timestamp one past the maximum representable value', () => {
    expect(() => generateCreosUlid(MAX_CREOS_ULID_TIMESTAMP_MS + 1)).toThrow();
  });

  it('rejects a negative timestamp', () => {
    expect(() => generateCreosUlid(-1)).toThrow();
  });

  it('rejects a non-integer timestamp', () => {
    expect(() => generateCreosUlid(1.5)).toThrow();
  });
});

describe('generateCreosUlid', () => {
  it('produces a 26-character string', () => {
    expect(generateCreosUlid()).toHaveLength(26);
  });

  it('generates unique IDs across many calls (collision check)', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => generateCreosUlid()));
    expect(ids.size).toBe(5000);
  });
});

describe('isValidCreosUlid / CreosUlidSchema', () => {
  it('accepts a freshly generated ulid', () => {
    expect(isValidCreosUlid(generateCreosUlid())).toBe(true);
    expect(CreosUlidSchema.safeParse(generateCreosUlid()).success).toBe(true);
  });

  it('rejects a too-short string', () => {
    expect(isValidCreosUlid('01ARZ3NDEK')).toBe(false);
  });

  it('rejects lowercase', () => {
    expect(isValidCreosUlid('01arz3ndektsv4rrffq69g5fav')).toBe(false);
  });

  it('rejects excluded letters (I, L, O, U)', () => {
    expect(isValidCreosUlid('0IARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isValidCreosUlid(12345)).toBe(false);
  });

  it.each(['0', '1', '7'])("accepts first character '%s' (in-range timestamp)", (c) => {
    const candidate = c + '1ARZ3NDEKTSV4RRFFQ69G5FAV'.slice(0, 25);
    expect(candidate).toHaveLength(26);
    expect(isValidCreosUlid(candidate)).toBe(true);
  });

  it.each(['8', '9', 'A', 'H', 'Z'])("rejects first character '%s' (timestamp overflow)", (c) => {
    const candidate = c + '1ARZ3NDEKTSV4RRFFQ69G5FAV'.slice(0, 25);
    expect(candidate).toHaveLength(26);
    expect(isValidCreosUlid(candidate)).toBe(false);
  });
});

describe('branded ID schemas + factories', () => {
  it('CreosPropertyIdSchema accepts a valid ulid, rejects garbage', () => {
    expect(CreosPropertyIdSchema.safeParse(generateCreosUlid()).success).toBe(true);
    expect(CreosPropertyIdSchema.safeParse('garbage').success).toBe(false);
  });

  it('newCreosPropertyId/newCreosDealId/newCreosMarketId/newCreosReportId each produce a valid ulid', () => {
    expect(isValidCreosUlid(newCreosPropertyId())).toBe(true);
    expect(isValidCreosUlid(newCreosDealId())).toBe(true);
    expect(isValidCreosUlid(newCreosMarketId())).toBe(true);
    expect(isValidCreosUlid(newCreosReportId())).toBe(true);
  });
});

describe('creosDisplayId', () => {
  it('formats CREOS-<PREFIX>-<last 5 chars> uppercase', () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(creosDisplayId('PROP', ulid)).toBe('CREOS-PROP-G5FAV');
  });

  it('supports every documented prefix', () => {
    const ulid = generateCreosUlid();
    for (const prefix of ['PROP', 'DEAL', 'MKT', 'REPORT'] as const) {
      expect(creosDisplayId(prefix, ulid)).toBe(`CREOS-${prefix}-${ulid.slice(-5)}`);
    }
  });

  it('throws on an invalid ulid rather than silently producing a bad display id', () => {
    expect(() => creosDisplayId('PROP', 'not-a-ulid')).toThrow();
  });
});
