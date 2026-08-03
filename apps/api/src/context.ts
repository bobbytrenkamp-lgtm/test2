import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Capability, Role } from '@cre/domain-models';
import { roleHasCapability } from '@cre/domain-models';
import type { AuthenticatedContext, Sql } from '@cre/database';

/**
 * Request authorization.
 *
 * Two things are checked on every protected route, in this order:
 *   1. identity  - a valid, unexpired session resolves to a user;
 *   2. authority - that user's role in the *currently selected organization*
 *                  carries the capability the route requires.
 *
 * Both checks happen on the server for every request. The web client hides
 * controls a user cannot use, but that is a convenience, never the control.
 */

export const SESSION_COOKIE = 'cre_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedContext;
    db: Sql;
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function unauthorized(message = 'Sign in to continue.'): HttpError {
  return new HttpError(401, 'UNAUTHENTICATED', message);
}

export function forbidden(message = 'You do not have permission to do that.'): HttpError {
  return new HttpError(403, 'FORBIDDEN', message);
}

export function notFound(message = 'Not found.'): HttpError {
  return new HttpError(404, 'NOT_FOUND', message);
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, 'BAD_REQUEST', message, details);
}

export function unprocessable(message: string, details?: unknown): HttpError {
  return new HttpError(422, 'UNPROCESSABLE', message, details);
}

export interface RequestAuth {
  userId: string;
  organizationId: string;
  role: Role;
  sessionId: string;
  ipAddress: string | null;
}

/** Requires a signed-in user. Does not require an organization to be selected. */
export function requireUser(request: FastifyRequest): AuthenticatedContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

/**
 * Requires a signed-in user with an organization selected and the given
 * capability in that organization.
 *
 * A user who belongs to several organizations only ever acts inside the one
 * their session currently points at, which is what keeps a single request from
 * reading across organization boundaries.
 */
export function requireCapability(request: FastifyRequest, capability: Capability): RequestAuth {
  const auth = requireUser(request);
  if (!auth.organizationId) {
    throw new HttpError(
      409,
      'NO_ORGANIZATION_SELECTED',
      'Select an organization before using this endpoint.',
    );
  }
  if (!auth.role) throw forbidden('You are not a member of the selected organization.');
  if (!roleHasCapability(auth.role, capability)) {
    throw forbidden(`Your role (${auth.role}) cannot perform "${capability}".`);
  }
  return {
    userId: auth.user.id,
    organizationId: auth.organizationId,
    role: auth.role,
    sessionId: auth.session.id,
    ipAddress: (request.ip as string) ?? null,
  };
}

/**
 * A state-changing request must carry an explicit header that a cross-site form
 * post cannot set. Combined with a SameSite=Lax session cookie this blocks
 * cross-site request forgery without a token round trip.
 */
export function assertSameOriginIntent(request: FastifyRequest): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const header = request.headers['x-requested-with'];
  if (header !== 'cre-platform') {
    throw new HttpError(
      403,
      'CSRF_CHECK_FAILED',
      'State-changing requests must include the X-Requested-With: cre-platform header.',
    );
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    signed: true,
    maxAge: 12 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
