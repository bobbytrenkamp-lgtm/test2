import { z } from 'zod';

/**
 * CREOS universal entity ID utility (Phase 4, integration boundary only —
 * see `docs/creos-ids.md`).
 *
 * `docs/creos-ids.md` documented a shared `CREOS-*-XXXXX` ID scheme but
 * marked it "Not implemented." This module implements the generator/
 * validator side of that scheme so a future SiteIntel/MarketSignal ->
 * Underwrite handoff can produce and check real, collision-safe CREOS
 * IDs. It does NOT touch this app's own identifiers — `packages/database`'s
 * primary keys, `docs/domain-model.md`'s model IDs, etc. remain the source
 * of truth for everything this app does internally. Nothing in this
 * repository calls `generateCreosUlid()` yet; it exists so the capability
 * is available and tested before it's wired into any real handoff.
 *
 * Ported line-for-line in spirit from the CREOS Enterprise repository's
 * hardened, spec-verified implementation
 * (test4's `src/domain/ids.ts` — see that repo's BUG-005 in
 * `BUG_TRACKER.md` for why the timestamp has to be encoded this specific
 * way, not the more "obvious" byte-array approach). Ported by hand rather
 * than depending on test4 as a package, since these are independently
 * deployed applications — keeping the algorithm identical to the
 * spec-verified original is what matters.
 *
 * ULID spec: https://github.com/ulid/spec — a 26-character Crockford
 * base32 string: 10 characters of millisecond timestamp (48 bits) + 16
 * characters of randomness (80 bits).
 */

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Canonical ULID timestamp encoding: repeated `value % 32` / `value / 32`
 * in the INTEGER domain, most-significant digit first — the algorithm the
 * spec actually defines. A byte-array + generic streaming base32 encoder
 * does NOT match this for a 48-bit value (48 isn't a multiple of 5); that
 * mismatch was test4's BUG-005.
 */
function encodeCrockfordInt(value: number, length: number): string {
  let output = '';
  let n = value;
  for (let i = length; i > 0; i--) {
    const digit = n % 32;
    output = CROCKFORD_ALPHABET[digit] + output;
    n = (n - digit) / 32;
  }
  return output;
}

/**
 * Byte-array streaming encoder — correct here because 80 bits (10 random
 * bytes) is exactly 16 Crockford digits with no remainder, unlike the
 * 48-bit timestamp above.
 */
function encodeCrockfordBytesExact(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits !== 0) {
    throw new Error('encodeCrockfordBytesExact: input bit length must be a multiple of 5');
  }
  return output;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export const MAX_CREOS_ULID_TIMESTAMP_MS = 281_474_976_710_655; // 2^48 - 1

/**
 * Generates a fresh CREOS ULID. `now` defaults to `Date.now()`; passing an
 * explicit timestamp is for tests only.
 *
 * Same-millisecond ordering is NOT guaranteed to be monotonic — each call
 * draws independent randomness for its lower 80 bits (Option A per test4's
 * hardening milestone; see that repo's `AI_CHANGELOG.md`). If a true
 * monotonic generator is ever needed here, that is a deliberate follow-up,
 * not an assumption baked into this function.
 */
export function generateCreosUlid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_CREOS_ULID_TIMESTAMP_MS) {
    throw new Error(
      `generateCreosUlid: timestamp ${now} is out of ULID's representable range (0 to ${MAX_CREOS_ULID_TIMESTAMP_MS})`,
    );
  }
  const timePart = encodeCrockfordInt(now, 10);
  const randomPart = encodeCrockfordBytesExact(randomBytes(10));
  return timePart + randomPart;
}

/**
 * A syntactically well-formed 26-char Crockford string can still encode a
 * timestamp above `MAX_CREOS_ULID_TIMESTAMP_MS` unless its first character
 * is restricted to '0'-'7' (2^48 only needs 1 of the first digit's 5 bits).
 */
const OVERFLOW_PATTERN = /^[0-7]/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidCreosUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value) && OVERFLOW_PATTERN.test(value);
}

export const CreosUlidSchema = z
  .string()
  .refine((value) => isValidCreosUlid(value), { message: 'Expected a valid CREOS ULID' });

/** Branded so `CreosPropertyId` and `CreosMarketId` are distinct at the type level, even though both are plain ULID strings at runtime. */
export const CreosPropertyIdSchema = CreosUlidSchema.brand<'CreosPropertyId'>();
export const CreosDealIdSchema = CreosUlidSchema.brand<'CreosDealId'>();
export const CreosMarketIdSchema = CreosUlidSchema.brand<'CreosMarketId'>();
export const CreosReportIdSchema = CreosUlidSchema.brand<'CreosReportId'>();

export type CreosPropertyId = z.infer<typeof CreosPropertyIdSchema>;
export type CreosDealId = z.infer<typeof CreosDealIdSchema>;
export type CreosMarketId = z.infer<typeof CreosMarketIdSchema>;
export type CreosReportId = z.infer<typeof CreosReportIdSchema>;

export function newCreosPropertyId(): CreosPropertyId {
  return CreosPropertyIdSchema.parse(generateCreosUlid());
}
export function newCreosDealId(): CreosDealId {
  return CreosDealIdSchema.parse(generateCreosUlid());
}
export function newCreosMarketId(): CreosMarketId {
  return CreosMarketIdSchema.parse(generateCreosUlid());
}
export function newCreosReportId(): CreosReportId {
  return CreosReportIdSchema.parse(generateCreosUlid());
}

export type CreosDisplayIdPrefix = 'PROP' | 'DEAL' | 'MKT' | 'REPORT';

/** `CREOS-<PREFIX>-<last 5 chars, uppercase>` — a derived display id only, never a second source of truth. */
export function creosDisplayId(prefix: CreosDisplayIdPrefix, ulid: string): string {
  if (!isValidCreosUlid(ulid)) {
    throw new Error(`creosDisplayId: not a valid CREOS ULID: ${ulid}`);
  }
  return `CREOS-${prefix}-${ulid.slice(-5)}`;
}
