import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { createDatabase, recordError, resolveSession, type Sql } from '@cre/database';
import type { Env } from './env.js';
import { HttpError, SESSION_COOKIE, assertSameOriginIntent } from './context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerPropertyRoutes } from './routes/properties.js';
import { registerModelRoutes } from './routes/models.js';
import { registerCalculationRoutes } from './routes/calculations.js';
import { registerFundRoutes } from './routes/funds.js';
import { registerPortfolioRoutes } from './routes/portfolios.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerBudgetRoutes } from './routes/budgets.js';

export interface ServerOptions {
  env: Env;
  /** Injected in tests so each run gets an isolated pool. */
  db?: Sql;
  logger?: boolean;
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

  app.setErrorHandler((error, request, reply) => {
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
    void recordError(db, {
      organizationId: request.auth?.organizationId ?? null,
      userId: request.auth?.user.id ?? null,
      method: request.method,
      route: request.routeOptions?.url ?? 'unknown',
      statusCode: 500,
      errorName: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
  });

  app.get('/api/v1/health', async () => {
    const [row] = (await db`SELECT 1 AS ok`) as unknown as Array<{ ok: number }>;
    return { status: row?.ok === 1 ? 'ok' : 'degraded', engineChecked: true };
  });

  await app.register(
    async (api) => {
      await registerAuthRoutes(api, env);
      await registerOrganizationRoutes(api, env);
      await registerPropertyRoutes(api);
      await registerModelRoutes(api);
      await registerCalculationRoutes(api);
      await registerPortfolioRoutes(api);
      await registerFundRoutes(api);
      await registerAuditRoutes(api);
      await registerImportRoutes(api);
      await registerReportRoutes(api);
      await registerBudgetRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
