import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Written here rather than pulled in, for two reasons. The algorithm is about
 * forty lines — an HMAC, a dynamic truncation, a modulo — so a dependency would
 * be more code to audit than the thing it replaces, and this is an
 * authentication path where "audit" is not rhetorical. And **RFC 6238 publishes
 * official test vectors**, so the implementation can be checked against numbers
 * nobody here chose. That is the same rule the calculation engine follows: an
 * expected value taken from your own output agrees with you by construction and
 * would pass on the day the code breaks.
 *
 * ## What this is not
 *
 * Not a second factor on its own. A code proves possession of the shared
 * secret; it proves nothing about who typed it. The value comes from combining
 * it with the password, which the login route does — a stolen password alone
 * stops being enough.
 *
 * Not proof against a real-time phishing proxy either. Somebody who relays a
 * code to the genuine site within its window is inside it, and no shared-secret
 * scheme fixes that. WebAuthn does, by binding the response to the origin, and
 * is the honest upgrade path when a browser-side credential store is available.
 * Recording that here so nobody mistakes this for the strongest thing there is.
 */

/** Digits in a generated code. Six is what every authenticator app expects. */
const DIGITS = 6;

/** Seconds each code is valid for. Thirty is the near-universal default. */
export const STEP_SECONDS = 30;

/**
 * How many steps either side of the present are accepted.
 *
 * One step, so a code entered as it rolls over is still taken, and a clock a
 * few seconds out still works. Wider would be friendlier and would also widen
 * the window in which an intercepted code is still worth something.
 */
const DRIFT_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, which is how every authenticator app expects a secret. */
export function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function fromBase32(secret: string): Buffer {
  const cleaned = secret.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    const index = BASE32.indexOf(character);
    if (index === -1) throw new Error('That is not a valid base32 secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, which is the size RFC 4226 recommends for SHA-1. */
export function generateSecret(): string {
  return toBase32(randomBytes(20));
}

/**
 * One code for one counter value.
 *
 * `algorithm` is a parameter only so the RFC's SHA-256 and SHA-512 vectors can
 * be checked too. Everything in this application uses SHA-1, because that is
 * what authenticator apps implement — and it is sound here: HMAC-SHA-1 is not
 * weakened by the collision attacks that retired bare SHA-1, and the output is
 * truncated to six digits anyway.
 */
export function hotp(secret: Buffer, counter: number, algorithm = 'sha1'): string {
  const buffer = Buffer.alloc(8);
  // Written as two 32-bit halves: a JavaScript number cannot hold a 64-bit
  // integer exactly, and the counter never needs the high bits in practice.
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac(algorithm, secret).update(buffer).digest();
  // Dynamic truncation, RFC 4226 §5.3: the low nibble of the last byte picks
  // where to read four bytes from, and the top bit is masked off so the result
  // is never negative.
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code for a moment in time. `atSeconds` is Unix time, not milliseconds. */
export function totp(secret: string, atSeconds = Math.floor(Date.now() / 1000)): string {
  return hotp(fromBase32(secret), Math.floor(atSeconds / STEP_SECONDS));
}

/**
 * Whether a submitted code is valid now.
 *
 * Compared with `timingSafeEqual` rather than `===`. The saving from an early
 * exit is tiny and the discipline is not negotiable on a credential check: a
 * comparison that returns faster for a wrong first digit leaks the code one
 * digit at a time to anyone who can measure it.
 */
export function verifyTotp(
  secret: string,
  submitted: string,
  atSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const cleaned = submitted.replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;

  const key = fromBase32(secret);
  const step = Math.floor(atSeconds / STEP_SECONDS);
  let matched = false;
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
    const candidate = hotp(key, step + drift);
    const a = Buffer.from(candidate);
    const b = Buffer.from(cleaned);
    // Every step is checked even after a match, so the time taken does not
    // reveal which step matched.
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  return matched;
}

/**
 * The URI an authenticator app scans.
 *
 * The secret is in this string, so it is returned exactly once at enrolment and
 * never stored anywhere it could be read back — not in the audit log, not in a
 * response to any later request.
 */
export function enrolmentUri(secret: string, email: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/**
 * Recovery codes, for the phone that fell in a river.
 *
 * Single-use and stored hashed, like passwords, because a list of plaintext
 * bypass codes in a database is a second password column with none of the care.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // Grouped for transcription; the hyphen is cosmetic and stripped on use.
    const raw = randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export const normaliseRecoveryCode = (code: string): string =>
  code.replace(/[\s-]/g, '').toUpperCase();
