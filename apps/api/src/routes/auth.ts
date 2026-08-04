import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  authenticate,
  checkPasswordPolicy,
  consumePasswordResetToken,
  createPasswordResetToken,
  createSession,
  createUser,
  findUserByEmail,
  listMemberships,
  revokeSession,
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
});

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
