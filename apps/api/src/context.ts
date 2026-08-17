import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Capability, EntitlementFeature, Role } from '@cre/domain-models';
import { z } from 'zod';
import { canUseFeature, roleHasCapability } from '@cre/domain-models';
import type { AuthenticatedContext, Sql } from '@cre/database';
import { getEntitlements } from '@cre/database';
import type { Mailer } from './mailer.js';
import type { Scanner } from './malware-scanner.js';
import { InfectedFileError, ScannerUnavailableError } from './malware-scanner.js';
import type { Storage } from './storage.js';

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
    mailer: Mailer;
    scanner: Scanner;
    storage: Storage;
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

/**
 * Scans raw uploaded bytes before anything parses them, translating the
 * scanner's own error types into the HTTP errors this module's other
 * helpers produce. An infected file and an unreachable scanner are refused
 * differently on purpose: the first is the caller's problem (400), the
 * second is this deployment's (503) — conflating them would let "the
 * scanner is down" read as "this file is infected" or vice versa.
 */
export async function scanUpload(
  request: FastifyRequest,
  buffer: Buffer,
): Promise<{ scanned: boolean }> {
  try {
    return await request.scanner.scan(buffer);
  } catch (error) {
    if (error instanceof InfectedFileError) {
      throw new HttpError(400, 'FILE_INFECTED', error.message);
    }
    if (error instanceof ScannerUnavailableError) {
      throw new HttpError(503, 'SCANNER_UNAVAILABLE', error.message);
    }
    throw error;
  }
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
 * Requires the organization's current plan to include a feature, on top of
 * whatever capability check already gated the route.
 *
 * Missing an entitlements row is treated as access, not denial: every
 * organization gets one at creation (`createOrganization`) and existing ones
 * were backfilled by migration 0016, so a missing row means the bookkeeping
 * is broken, not that the customer bought nothing — a workflow should never
 * go dark over that distinction. See `canUseFeature` in `@cre/domain-models`
 * for how trial and internal organizations get every feature regardless of
 * their nominal plan.
 */
export async function requireFeature(
  request: FastifyRequest,
  organizationId: string,
  feature: EntitlementFeature,
): Promise<void> {
  const entitlements = await getEntitlements(request.db, organizationId);
  if (!entitlements) return;
  if (!canUseFeature(entitlements, feature)) {
    throw new HttpError(
      402,
      'FEATURE_NOT_AVAILABLE',
      'Your plan does not include this feature. Contact your organization admin to upgrade.',
    );
  }
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

/**
 * A boolean from a query string.
 *
 * `z.coerce.boolean()` is the obvious choice and is wrong here: it applies
 * JavaScript truthiness, so the string "false" becomes `true` and the flag can
 * only ever be turned on. Query values arrive as strings, so the two spellings
 * have to be read explicitly.
 */
export const queryBoolean = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === 'true' || value === '1'));
