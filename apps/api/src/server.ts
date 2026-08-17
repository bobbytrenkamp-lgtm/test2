import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { ENGINE_VERSION } from '@cre/calculation-engine';
import { createDatabase, recordError, referenceFor, resolveSession, type Sql } from '@cre/database';
import type { Env } from './env.js';
import { HttpError, SESSION_COOKIE, assertSameOriginIntent } from './context.js';
import { createMailer, type Mailer } from './mailer.js';
import { createScanner, type Scanner } from './malware-scanner.js';
import { APP_VERSION } from './version.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerPropertyRoutes } from './routes/properties.js';
import { registerModelRoutes } from './routes/models.js';
import { registerUnderwritingRoutes } from './routes/underwriting.js';
import { registerCalculationRoutes } from './routes/calculations.js';
import { registerCollaborationRoutes } from './routes/collaboration.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerMfaRoutes } from './routes/mfa.js';
import { registerFundRoutes } from './routes/funds.js';
import { registerPortfolioRoutes } from './routes/portfolios.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerBudgetRoutes } from './routes/budgets.js';
import { registerAssumptionProposalRoutes } from './routes/assumption-proposals.js';
import { registerAssumptionImportRoutes } from './routes/assumption-import.js';
import { registerFavouriteRoutes } from './routes/favourites.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerGrowthCurveTemplateRoutes } from './routes/growth-curve-templates.js';
import { registerMarketLeasingProfileTemplateRoutes } from './routes/market-leasing-profile-templates.js';
import { registerOperatingExpenseTemplateRoutes } from './routes/expense-templates.js';
import { registerDebtFacilityTemplateRoutes } from './routes/debt-facility-templates.js';

export interface ServerOptions {
  env: Env;
  /** Injected in tests so each run gets an isolated pool. */
  db?: Sql;
  /** Injected in tests to assert on what would have been sent, without a real mailer. */
  mailer?: Mailer;
  /** Injected in tests so a scan can be asserted on without a real clamd. */
  scanner?: Scanner;
  logger?: boolean;
}

/** One route the server exposes: a method and the path it is registered at. */
export interface RouteInventoryEntry {
  method: string;
  url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    routeInventory: RouteInventoryEntry[];
  }
}

/**
 * Builds the API.
 *
 * Exposed as a factory rather than a module-level singleton so integration
 * tests can construct a server against a throwaway database and exercise real
 * routes through `inject()` without opening a socket.
 */
export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { env } = options;
  const db =
    options.db ??
    createDatabase({
      connectionString: env.DATABASE_URL,
      maxConnections: env.DATABASE_MAX_CONNECTIONS,
    });

  const app = Fastify({
    logger: options.logger ?? env.NODE_ENV !== 'test',
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  const mailer = options.mailer ?? createMailer(env, app.log);
  const scanner = options.scanner ?? (await createScanner(env, app.log));

  /*
   * Every route this server exposes, recorded as it is registered.
   *
   * Hand-written lists of endpoints are wrong within a release. This one cannot
   * be, because it is the router's own answer: `tests/route-inventory.test.ts`
   * walks it and requires each route to refuse an unauthenticated request
   * unless it appears on an explicit public allowlist, and
   * `scripts/api-inventory.mjs` prints it as documentation. A route added
   * without authentication therefore fails the build rather than waiting to be
   * noticed.
   */
  const routes: RouteInventoryEntry[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // HEAD is added automatically alongside every GET and is not a separate
      // surface to document or defend.
      if (method === 'HEAD') continue;
      routes.push({ method, url: route.url });
    }
  });
  app.decorate('routeInventory', routes);

  // Several endpoints take no payload but are still POSTs. A client that sets a
  // JSON content-type and sends nothing is making a well-formed request, so an
  // empty body is parsed as an empty object rather than rejected.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body === undefined || body === null || body.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        const failure = error as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", env.WEB_ORIGIN],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'same-origin' },
  });

  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
    allowedHeaders: ['content-type', 'x-requested-with'],
  });

  await app.register(cookie, { secret: env.SESSION_SECRET });

  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (request) => `${request.ip}:${request.routeOptions?.url ?? request.url}`,
  });

  // The pool is attached per request rather than imported, so tests can supply
  // their own database without the routes reaching for a module singleton.
  app.addHook('onRequest', async (request) => {
    request.db = db;
    request.mailer = mailer;
    request.scanner = scanner;
  });

  // Identity resolution runs for every request; authorization is per route.
  app.addHook('preHandler', async (request) => {
    assertSameOriginIntent(request);
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const auth = await resolveSession(db, unsigned.value);
    if (auth) request.auth = auth;
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request body failed validation.',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
      });
    }

    // A client error raised by the framework itself (a malformed body, an
    // unsupported content type) is the caller's to fix, so its status and
    // message are passed through rather than being reported as a server fault.
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: {
          code: (error as { code?: string }).code ?? 'BAD_REQUEST',
          message: error instanceof Error ? error.message : 'The request could not be processed.',
        },
      });
    }

    /*
     * Unexpected failures are logged in full but never echoed to the client,
     * because the message can contain SQL, file paths or model data.
     *
     * They are also recorded, so a fault on an unwatched machine is noticed
     * before somebody complains — which on a valuation platform may be after
     * the number has been relied on. Only the fault's shape is stored: the
     * route pattern rather than the resolved path, and no body, query, header
     * or session token. See `error_events` in migration 0011.
     */
    request.log.error({ err: error }, 'Unhandled error');
    const errorEventId = await recordError(db, {
      organizationId: request.auth?.organizationId ?? null,
      userId: request.auth?.user.id ?? null,
      method: request.method,
      route: request.routeOptions?.url ?? 'unknown',
      statusCode: 500,
      errorName: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });
    // A customer cannot quote a fingerprint or a stack trace to a support
    // conversation, but a short reference is exactly what "what's the error
    // code" already expects the answer to look like — and it is read from
    // the same row a support conversation would otherwise have to search the
    // logs to find, not a second identifier invented just for display.
    const reference = errorEventId ? referenceFor(errorEventId) : null;
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', reference },
    });
  });

  app.get('/api/v1/health', async () => {
    const [row] = (await db`SELECT 1 AS ok`) as unknown as Array<{ ok: number }>;
    return {
      status: row?.ok === 1 ? 'ok' : 'degraded',
      engineChecked: true,
      appVersion: APP_VERSION,
      engineVersion: ENGINE_VERSION,
    };
  });

  await app.register(
    async (api) => {
      await registerAuthRoutes(api, env);
      await registerOrganizationRoutes(api, env);
      await registerPropertyRoutes(api);
      await registerModelRoutes(api);
      await registerUnderwritingRoutes(api);
      await registerCalculationRoutes(api);
      await registerPortfolioRoutes(api);
      await registerFundRoutes(api);
      await registerCollaborationRoutes(api);
      await registerTaskRoutes(api);
      await registerMfaRoutes(api);
      await registerAuditRoutes(api);
      await registerImportRoutes(api);
      await registerReportRoutes(api);
      await registerBudgetRoutes(api);
      await registerAssumptionProposalRoutes(api);
      await registerAssumptionImportRoutes(api);
      await registerFavouriteRoutes(api);
      await registerNotificationRoutes(api);
      await registerGrowthCurveTemplateRoutes(api);
      await registerMarketLeasingProfileTemplateRoutes(api);
      await registerOperatingExpenseTemplateRoutes(api);
      await registerDebtFacilityTemplateRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
