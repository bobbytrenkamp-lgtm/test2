import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  enrolmentUri,
  generateRecoveryCodes,
  generateSecret,
  hashPassword,
  normaliseRecoveryCode,
  verifyPassword,
  verifyTotp,
  writeAudit,
} from '@cre/database';
import { badRequest, requireUser } from '../context.js';

/**
 * Enrolling and removing a second factor.
 *
 * A platform holding institutional valuations behind a password alone fails any
 * serious security review, and the `mfa_enrolled` column has been in the schema
 * since it was written with nothing to set it. This is what sets it.
 *
 * ## Enrolment is two steps, deliberately
 *
 * `POST /auth/mfa/enrol` issues a secret and returns it once. `POST
 * /auth/mfa/confirm` takes a code generated from that secret and only then
 * marks the account enrolled. Doing it in one step would flip the flag on a
 * secret the user might never have successfully scanned, and lock them out of
 * their own account — the failure mode where the security feature is the
 * attacker.
 *
 * ## The secret leaves the server exactly once
 *
 * It is returned by the enrolment call and never again: not by `/auth/me`, not
 * by any later read, and never into the audit log. Somebody who has already
 * stolen a session should not be able to ask the API for the second factor that
 * session is supposed to be protected by.
 */

const codeSchema = z
  .string()
  .min(6)
  .max(20)
  .transform((value) => value.replace(/\s/g, ''));

export async function registerMfaRoutes(app: FastifyInstance): Promise<void> {
  const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.get('/auth/mfa', async (request) => {
    const auth = requireUser(request);
    const rows = (await request.db`
      SELECT mfa_enrolled, mfa_confirmed_at, mfa_secret IS NOT NULL AS has_secret
      FROM users WHERE id = ${auth.user.id}
    `) as unknown as Array<{
      mfa_enrolled: boolean;
      mfa_confirmed_at: Date | null;
      has_secret: boolean;
    }>;
    const user = rows[0];

    const remaining = (await request.db`
      SELECT count(*)::int AS remaining FROM mfa_recovery_codes
      WHERE user_id = ${auth.user.id} AND used_at IS NULL
    `) as unknown as Array<{ remaining: number }>;

    return {
      enrolled: user?.mfa_enrolled ?? false,
      confirmedAt: user?.mfa_confirmed_at ?? null,
      // Whether an enrolment is part-finished, so the screen can offer to
      // resume rather than silently issuing a second secret.
      pending: (user?.has_secret ?? false) && !(user?.mfa_enrolled ?? false),
      recoveryCodesRemaining: remaining[0]?.remaining ?? 0,
    };
  });

  app.post('/auth/mfa/enrol', { config: authLimit }, async (request) => {
    const auth = requireUser(request);

    const rows = (await request.db`
      SELECT mfa_enrolled FROM users WHERE id = ${auth.user.id}
    `) as unknown as Array<{ mfa_enrolled: boolean }>;
    if (rows[0]?.mfa_enrolled) {
      // Re-enrolling would issue a new secret and silently invalidate the
      // authenticator entry that currently works.
      throw badRequest(
        'This account already has an authenticator. Remove the existing one before enrolling again.',
      );
    }

    const secret = generateSecret();
    await request.db`
      UPDATE users SET mfa_secret = ${secret}, mfa_enrolled = false, mfa_confirmed_at = NULL
      WHERE id = ${auth.user.id}
    `;

    await writeAudit(request.db, {
      organizationId: auth.organizationId ?? null,
      userId: auth.user.id,
      action: 'user.mfa_enrolment_started',
      entityType: 'user',
      entityId: auth.user.id,
      // Deliberately no secret and no URI here. An append-only log that
      // recorded either would be a permanent copy of the second factor.
      ipAddress: request.ip,
    });

    return {
      secret,
      uri: enrolmentUri(secret, auth.user.email, 'CRE Platform'),
      // Said plainly, because it is the only time it is true.
      note: 'Store this now. It is shown once and cannot be read back.',
    };
  });

  app.post('/auth/mfa/confirm', { config: authLimit }, async (request) => {
    const auth = requireUser(request);
    const body = z.object({ code: codeSchema }).parse(request.body);

    const rows = (await request.db`
      SELECT mfa_secret, mfa_enrolled FROM users WHERE id = ${auth.user.id}
    `) as unknown as Array<{ mfa_secret: string | null; mfa_enrolled: boolean }>;
    const user = rows[0];

    if (!user?.mfa_secret) {
      throw badRequest('Start an enrolment before confirming one.');
    }
    if (user.mfa_enrolled) {
      throw badRequest('This account is already enrolled.');
    }
    if (!verifyTotp(user.mfa_secret, body.code)) {
      throw badRequest(
        'That code is not right. Check your authenticator is showing the current code, and that the device clock is correct.',
      );
    }

    /*
     * Recovery codes are issued here rather than at enrolment, so they only
     * ever exist for an account that has actually proved it can generate a
     * code. Issuing them earlier would hand out a set of working bypass codes
     * to an enrolment that was never completed.
     */
    const codes = generateRecoveryCodes(10);
    const hashes = await Promise.all(
      codes.map((code) => hashPassword(normaliseRecoveryCode(code))),
    );

    await request.db.begin(async (tx) => {
      await tx`
        UPDATE users SET mfa_enrolled = true, mfa_confirmed_at = now()
        WHERE id = ${auth.user.id}
      `;
      // Any codes from an earlier enrolment are gone with the secret they
      // belonged to.
      await tx`DELETE FROM mfa_recovery_codes WHERE user_id = ${auth.user.id}`;
      for (const hash of hashes) {
        await tx`
          INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (${auth.user.id}, ${hash})
        `;
      }
    });

    await writeAudit(request.db, {
      organizationId: auth.organizationId ?? null,
      userId: auth.user.id,
      action: 'user.mfa_enrolled',
      entityType: 'user',
      entityId: auth.user.id,
      ipAddress: request.ip,
    });

    return {
      enrolled: true,
      recoveryCodes: codes,
      note: 'These are shown once. Each works a single time, and only if your authenticator is unavailable.',
    };
  });

  app.post('/auth/mfa/disable', { config: authLimit }, async (request) => {
    const auth = requireUser(request);
    const body = z.object({ password: z.string().min(1).max(256) }).parse(request.body);

    /*
     * The current password, again. Removing a second factor is the single most
     * valuable action an attacker with a stolen session could take, and it is
     * the one place where re-proving the first factor costs a legitimate user
     * almost nothing.
     */
    const rows = (await request.db`
      SELECT password_hash FROM users WHERE id = ${auth.user.id}
    `) as unknown as Array<{ password_hash: string | null }>;
    if (!(await verifyPassword(body.password, rows[0]?.password_hash ?? null))) {
      throw badRequest('That password is not correct.');
    }

    await request.db.begin(async (tx) => {
      await tx`
        UPDATE users SET mfa_enrolled = false, mfa_secret = NULL, mfa_confirmed_at = NULL
        WHERE id = ${auth.user.id}
      `;
      await tx`DELETE FROM mfa_recovery_codes WHERE user_id = ${auth.user.id}`;
    });

    await writeAudit(request.db, {
      organizationId: auth.organizationId ?? null,
      userId: auth.user.id,
      action: 'user.mfa_disabled',
      entityType: 'user',
      entityId: auth.user.id,
      ipAddress: request.ip,
    });

    return { enrolled: false };
  });
}
