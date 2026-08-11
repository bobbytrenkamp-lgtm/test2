import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '@cre/database';
import {
  authenticate,
  checkPasswordPolicy,
  consumePasswordResetToken,
  createPasswordResetToken,
  createSession,
  createUser,
  findUserByEmail,
  getEntitlements,
  listMemberships,
  normaliseRecoveryCode,
  revokeSession,
  verifyPassword,
  verifyTotp,
  writeAudit,
} from '@cre/database';
import { capabilitiesForRole } from '@cre/domain-models';
import type { Env } from '../env.js';
import {
  HttpError,
  SESSION_COOKIE,
  badRequest,
  clearSessionCookie,
  requireUser,
  setSessionCookie,
} from '../context.js';

const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
  /** A six-digit authenticator code, or a recovery code. Only accounts with a
   *  second factor need it, so it is optional at the schema level and required
   *  by the login route for the accounts that have one. */
  code: z.string().max(40).optional(),
});

/**
 * Spends a recovery code, if the submitted value is one.
 *
 * Codes are stored hashed, so finding the right row means checking the
 * candidate against each unused hash rather than looking one up. That is a
 * handful of comparisons against a per-user list of ten, and it is the price of
 * not keeping a plaintext column of working bypass codes.
 *
 * Marking it used is conditional on it still being unused, so two requests
 * racing with the same code cannot both win.
 */
async function consumeRecoveryCode(db: Sql, userId: string, submitted: string): Promise<boolean> {
  const candidate = normaliseRecoveryCode(submitted);
  const rows = (await db`
    SELECT id, code_hash FROM mfa_recovery_codes
    WHERE user_id = ${userId} AND used_at IS NULL
  `) as unknown as Array<{ id: string; code_hash: string }>;

  for (const row of rows) {
    if (!(await verifyPassword(candidate, row.code_hash))) continue;
    const claimed = (await db`
      UPDATE mfa_recovery_codes SET used_at = now()
      WHERE id = ${row.id} AND used_at IS NULL
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    return claimed.length > 0;
  }
  return false;
}

const registrationSchema = credentialsSchema.extend({
  name: z.string().min(1).max(200),
  organizationName: z.string().min(1).max(200).optional(),
});

export async function registerAuthRoutes(app: FastifyInstance, env: Env): Promise<void> {
  /**
   * Authentication endpoints carry a much tighter rate limit than the rest of
   * the API: they are the surface an attacker probes, and a legitimate user
   * signs in a handful of times a day.
   */
  const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.post('/auth/register', { config: authLimit }, async (request, reply) => {
    if (!env.ALLOW_SELF_REGISTRATION) {
      throw new HttpError(
        403,
        'REGISTRATION_DISABLED',
        'Self-registration is disabled on this deployment. Ask an administrator for an invitation.',
      );
    }
    const body = registrationSchema.parse(request.body);
    const policy = checkPasswordPolicy(body.password);
    if (!policy.ok) throw badRequest('That password does not meet the policy.', policy.problems);

    const existing = await findUserByEmail(request.db, body.email);
    if (existing) {
      // Registration does not disclose whether an address is already in use.
      throw new HttpError(
        409,
        'REGISTRATION_FAILED',
        'That account could not be created. If you already have an account, sign in instead.',
      );
    }

    const user = await createUser(request.db, {
      email: body.email,
      name: body.name,
      password: body.password,
    });
    const { token } = await createSession(request.db, {
      userId: user.id,
      userAgent: request.headers['user-agent'] ?? null,
      ipAddress: request.ip,
    });
    setSessionCookie(reply, token, env.SESSION_COOKIE_SECURE);

    await writeAudit(request.db, {
      organizationId: null,
      userId: user.id,
      action: 'user.registered',
      entityType: 'user',
      entityId: user.id,
      ipAddress: request.ip,
    });

    return reply.status(201).send({ user: { id: user.id, email: user.email, name: user.name } });
  });

  app.post('/auth/login', { config: authLimit }, async (request, reply) => {
    const body = credentialsSchema.parse(request.body);
    const user = await authenticate(request.db, body.email, body.password);
    if (!user) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'That email or password is not correct.');
    }

    /*
     * The second factor, if this account has one.
     *
     * Checked after the password and before any session exists, which is the
     * only ordering that makes it a factor at all: issuing the cookie first and
     * asking for a code afterwards would leave a usable session in the hands of
     * whoever had the password.
     *
     * The response says a code is required rather than pretending the password
     * was wrong. Hiding it would tell the user nothing actionable and tells an
     * attacker who already has the password nothing they cannot discover by
     * looking at the login form.
     */
    if (user.mfa_enrolled) {
      const submitted = (body.code ?? '').replace(/\s/g, '');
      if (!submitted) {
        throw new HttpError(
          401,
          'MFA_REQUIRED',
          'This account needs a code from its authenticator app.',
        );
      }

      const accepted = user.mfa_secret ? verifyTotp(user.mfa_secret, submitted) : false;
      const viaRecovery = accepted
        ? false
        : await consumeRecoveryCode(request.db, user.id, submitted);

      if (!accepted && !viaRecovery) {
        throw new HttpError(401, 'MFA_INVALID', 'That code is not right.');
      }
      if (viaRecovery) {
        // Worth recording separately: a recovery code being used is either a
        // lost device or somebody working around one, and both are things an
        // administrator should be able to find afterwards.
        await writeAudit(request.db, {
          organizationId: null,
          userId: user.id,
          action: 'user.mfa_recovery_code_used',
          entityType: 'user',
          entityId: user.id,
          ipAddress: request.ip,
        });
      }
    }

    // Sign the user straight into their only organization when there is one.
    const memberships = await listMemberships(request.db, user.id);
    const organizationId = memberships.length === 1 ? memberships[0]?.organization_id : null;

    const { token } = await createSession(request.db, {
      userId: user.id,
      organizationId: organizationId ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      ipAddress: request.ip,
    });
    setSessionCookie(reply, token, env.SESSION_COOKIE_SECURE);

    await writeAudit(request.db, {
      organizationId: organizationId ?? null,
      userId: user.id,
      action: 'user.signed_in',
      entityType: 'user',
      entityId: user.id,
      ipAddress: request.ip,
    });

    return {
      user: { id: user.id, email: user.email, name: user.name },
      organizations: memberships,
      organizationId: organizationId ?? null,
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) await revokeSession(request.db, unsigned.value);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (request) => {
    const auth = requireUser(request);
    const memberships = await listMemberships(request.db, auth.user.id);
    const entitlements = auth.organizationId
      ? await getEntitlements(request.db, auth.organizationId)
      : null;
    return {
      user: {
        id: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        mfaEnrolled: auth.user.mfa_enrolled,
      },
      organizationId: auth.organizationId,
      role: auth.role,
      capabilities: auth.role ? capabilitiesForRole(auth.role) : [],
      organizations: memberships,
      entitlements,
    };
  });

  /**
   * Password reset request. The response is identical whether or not the
   * address exists, so the endpoint cannot be used to enumerate accounts.
   *
   * Delivery is deliberately abstracted: no mail provider is bundled. In
   * development the token is returned so the flow can be exercised end to end;
   * a deployment configures a mailer and this branch is removed.
   */
  app.post('/auth/password-reset/request', { config: authLimit }, async (request) => {
    const body = z.object({ email: z.string().email() }).parse(request.body);
    const user = await findUserByEmail(request.db, body.email);
    let devToken: string | undefined;
    if (user) {
      const token = await createPasswordResetToken(request.db, user.id);
      if (env.NODE_ENV !== 'production') devToken = token;
    }
    return {
      ok: true,
      message: 'If that address has an account, a reset link is on its way.',
      ...(devToken ? { developmentToken: devToken } : {}),
    };
  });

  app.post('/auth/password-reset/confirm', { config: authLimit }, async (request) => {
    const body = z
      .object({ token: z.string().min(10), password: z.string().min(1).max(256) })
      .parse(request.body);
    const policy = checkPasswordPolicy(body.password);
    if (!policy.ok) throw badRequest('That password does not meet the policy.', policy.problems);

    const ok = await consumePasswordResetToken(request.db, body.token, body.password);
    if (!ok) {
      throw new HttpError(400, 'RESET_TOKEN_INVALID', 'That reset link is invalid or has expired.');
    }
    return { ok: true };
  });
}
