import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { createDatabase, resolveSession, type Sql } from '@cre/database';
import type { Env } from './env.js';
import { HttpError, SESSION_COOKIE, assertSameOriginIntent } from './context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerPropertyRoutes } from './routes/properties.js';
import { registerModelRoutes } from './routes/models.js';
import { registerCalculationRoutes } from './routes/calculations.js';
import { registerPortfolioRoutes } from './routes/portfolios.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerReportRoutes } from './routes/reports.js';

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
  const db = options.db ?? createDatabase({ connectionString: env.DATABASE_URL });

  const app = Fastify({
    logger: options.logger ?? env.NODE_ENV !== 'test',
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    // Rent rolls and tenant financial detail must never reach the logs.
    disableRequestLogging: false,
  });

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
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply
        .status(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } });
    }

    // Unexpected failures are logged in full but never echoed to the client,
    // because the message can contain SQL, file paths or model data.
    request.log.error({ err: error }, 'Unhandled error');
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
      await registerAuditRoutes(api);
      await registerImportRoutes(api);
      await registerReportRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
