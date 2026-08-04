import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from the Node standard library.
 *
 * scrypt is memory-hard and needs no native dependency, which keeps the
 * container image small and the build reproducible. Parameters are stored in
 * the hash string so they can be raised later without invalidating existing
 * passwords: a login with outdated parameters is rehashed on success.
 */
const DEFAULT_N = 16384; // 2^14
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 128 * DEFAULT_N * DEFAULT_R * 4;

export const MINIMUM_PASSWORD_LENGTH = 12;

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Length is the dominant factor in password strength, so the policy leads with
 * it rather than with character-class rules that push users toward predictable
 * substitutions.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 256) {
    problems.push('Use no more than 256 characters.');
  }
  if (/^\s|\s$/.test(password)) {
    problems.push('Remove leading or trailing whitespace.');
  }
  if (/^(.)\1+$/.test(password)) {
    problems.push('Use more than a single repeated character.');
  }
  return { ok: problems.length === 0, problems };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: MAX_MEM,
  });
  return [
    'scrypt',
    DEFAULT_N,
    DEFAULT_R,
    DEFAULT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] as string, 'base64');
  const expected = Buffer.from(parts[5] as string, 'base64');
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: Math.max(MAX_MEM, 128 * n * r * 4),
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** True when a stored hash was produced with weaker parameters than current. */
export function needsRehash(stored: string | null): boolean {
  if (!stored) return true;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < DEFAULT_N;
}
