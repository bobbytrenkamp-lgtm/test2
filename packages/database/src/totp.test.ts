import { describe, expect, it } from 'vitest';
import {
  fromBase32,
  generateRecoveryCodes,
  generateSecret,
  hotp,
  normaliseRecoveryCode,
  toBase32,
  totp,
  verifyTotp,
  STEP_SECONDS,
  enrolmentUri,
} from './totp.js';

/**
 * TOTP, checked against numbers nobody here chose.
 *
 * RFC 6238 Appendix B and RFC 4226 Appendix D publish test vectors. Using them
 * is the whole point: an expected value produced by running this code would
 * agree with this code by construction and would still pass on the day the
 * truncation breaks. These are the same vectors every other implementation is
 * checked against, so agreement means agreement with the standard rather than
 * with itself.
 */

/** RFC 6238 §4: the ASCII seed, repeated to the length each algorithm needs. */
const SEED_SHA1 = Buffer.from('12345678901234567890', 'ascii');

describe('HOTP against RFC 4226 Appendix D', () => {
  // The RFC's table for the secret above, counters 0 through 9.
  const EXPECTED = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];

  it.each(EXPECTED.map((code, counter) => ({ counter, code })))(
    'counter $counter gives $code',
    ({ counter, code }) => {
      expect(hotp(SEED_SHA1, counter)).toBe(code);
    },
  );
});

describe('TOTP against RFC 6238 Appendix B', () => {
  /*
   * The RFC's SHA-1 rows. The published table uses a different seed per
   * algorithm; these are the SHA-1 ones, which is what authenticator apps use
   * and therefore what this application uses.
   */
  const VECTORS = [
    { time: 59, code: '94287082' },
    { time: 1111111109, code: '07081804' },
    { time: 1111111111, code: '14050471' },
    { time: 1234567890, code: '89005924' },
    { time: 2000000000, code: '69279037' },
    { time: 20000000000, code: '65353130' },
  ];

  it.each(VECTORS)('at $time the code ends $code', ({ time, code }) => {
    /*
     * The RFC tabulates eight digits; this implementation emits six, because
     * that is what every authenticator app expects. Six digits is the last six
     * of the eight — both are the same truncated integer taken modulo a
     * different power of ten — so the vector is checked against its own last
     * six rather than being rewritten to suit.
     */
    const secret = toBase32(SEED_SHA1);
    expect(totp(secret, time)).toBe(code.slice(-6));
  });
});

describe('base32', () => {
  it('round-trips a secret', () => {
    const bytes = Buffer.from('12345678901234567890', 'ascii');
    expect(fromBase32(toBase32(bytes)).equals(bytes)).toBe(true);
  });

  it('encodes the RFC 4648 test vectors', () => {
    // RFC 4648 §10, again numbers chosen by the standard rather than by me.
    expect(toBase32(Buffer.from('f'))).toBe('MY');
    expect(toBase32(Buffer.from('fo'))).toBe('MZXQ');
    expect(toBase32(Buffer.from('foo'))).toBe('MZXW6');
    expect(toBase32(Buffer.from('foob'))).toBe('MZXW6YQ');
    expect(toBase32(Buffer.from('fooba'))).toBe('MZXW6YTB');
    expect(toBase32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('reads a secret back whatever case or spacing it arrives in', () => {
    // Authenticator apps display secrets in spaced groups, and people retype
    // them. Refusing a correctly transcribed secret over whitespace would be a
    // support ticket, not a security control.
    const secret = generateSecret();
    const spaced = (secret.match(/.{1,4}/g) ?? []).join(' ').toLowerCase();
    expect(fromBase32(spaced).equals(fromBase32(secret))).toBe(true);
  });

  it('refuses a secret containing characters base32 has no meaning for', () => {
    expect(() => fromBase32('ABC!DEF')).toThrow(/valid base32/);
  });
});

describe('verification', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const now = 1_700_000_000;

  it('accepts the code for the current step', () => {
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(true);
  });

  it('accepts one step either side, for a clock that is slightly out', () => {
    expect(verifyTotp(secret, totp(secret, now - STEP_SECONDS), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now + STEP_SECONDS), now)).toBe(true);
  });

  it('refuses a code two steps away', () => {
    // The window has to end somewhere, or an intercepted code stays useful.
    expect(verifyTotp(secret, totp(secret, now - STEP_SECONDS * 2), now)).toBe(false);
    expect(verifyTotp(secret, totp(secret, now + STEP_SECONDS * 2), now)).toBe(false);
  });

  it('refuses anything that is not six digits', () => {
    expect(verifyTotp(secret, '', now)).toBe(false);
    expect(verifyTotp(secret, '12345', now)).toBe(false);
    expect(verifyTotp(secret, '1234567', now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
  });

  it('refuses a code from a different secret', () => {
    const other = generateSecret();
    expect(verifyTotp(secret, totp(other, now), now)).toBe(false);
  });

  it('tolerates the spacing an app displays', () => {
    const code = totp(secret, now);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
  });
});

describe('enrolment', () => {
  it('builds a URI an authenticator app can read', () => {
    const uri = enrolmentUri('JBSWY3DPEHPK3PXP', 'analyst@example.invalid', 'CRE Platform');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('period=30');
    expect(uri).toContain('digits=6');
    // The label carries issuer and account, encoded — a raw colon or space
    // there is the classic reason a QR code scans into the wrong app entry.
    expect(uri).toContain(encodeURIComponent('CRE Platform:analyst@example.invalid'));
  });

  it('generates a secret of the size RFC 4226 recommends', () => {
    // 160 bits, which is 20 bytes, which is 32 base32 characters.
    expect(fromBase32(generateSecret())).toHaveLength(20);
  });

  it('does not generate the same secret twice', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(secrets.size).toBe(50);
  });
});

describe('recovery codes', () => {
  it('generates the requested number, all distinct', () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
  });

  it('normalises the way somebody would actually type one', () => {
    const [code] = generateRecoveryCodes(1);
    const typed = (code as string).toLowerCase().replace('-', ' ');
    expect(normaliseRecoveryCode(typed)).toBe(normaliseRecoveryCode(code as string));
  });
});
