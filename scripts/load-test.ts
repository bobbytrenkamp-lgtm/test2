/**
 * Database load test.
 *
 * `pnpm benchmark` measures the calculation engine — pure arithmetic, no I/O.
 * This measures the other half: what the queries do when an organization holds
 * thousands of properties rather than five. They are different failure modes.
 * An engine that is linear in the model tells you nothing about a list query
 * that scans a table, or a loop that issues one round trip per property.
 *
 *   pnpm load-test                     # 1,000 properties
 *   LOAD_PROPERTIES=5000 pnpm load-test
 *
 * It builds its own database, measures, reports, and drops it again. Like the
 * restore drill, it refuses to run against a database whose name does not mark
 * it as disposable.
 */
import { performance } from 'node:perf_hooks';
import { createDatabase, migrate, resetSchema } from '../packages/database/src/index.js';
import {
  getLatestCalculation,
  listModels,
  listProperties,
  listAudit,
} from '../packages/database/src/index.js';

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://cre:cre@127.0.0.1:5432/cre_platform';
const PROPERTIES = Number(process.env.LOAD_PROPERTIES ?? 1000);
const MODELS_PER_PROPERTY = Number(process.env.LOAD_MODELS ?? 2);
const LEASES_PER_MODEL = Number(process.env.LOAD_LEASES ?? 20);
const AUDIT_ROWS = Number(process.env.LOAD_AUDIT ?? 50_000);

const url = new URL(BASE_URL);
url.pathname = '/cre_platform_load';
const databaseName = 'cre_platform_load';

interface Timing {
  name: string;
  millis: number;
  detail: string;
  budget?: number;
}

const timings: Timing[] = [];

async function time<T>(
  name: string,
  detail: string,
  budget: number | undefined,
  run: () => Promise<T>,
): Promise<T> {
  // A warm-up so the first measurement is not paying for a cold connection
  // and an unplanned query.
  await run();
  const started = performance.now();
  const result = await run();
  timings.push({
    name,
    millis: performance.now() - started,
    detail,
    ...(budget ? { budget } : {}),
  });
  return result;
}

const maintenance = new URL(BASE_URL);
maintenance.pathname = '/postgres';
const admin = createDatabase({ connectionString: maintenance.toString(), maxConnections: 1 });

async function dropLoadDatabase(): Promise<void> {
  await admin`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${databaseName}
  `;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
}

console.warn(
  `Database load test\n  ${PROPERTIES} properties, ${MODELS_PER_PROPERTY} models each, ` +
    `${LEASES_PER_MODEL} leases per model, ${AUDIT_ROWS} audit rows\n`,
);

try {
  await dropLoadDatabase();
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);

  const sql = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
  try {
    await resetSchema(sql);
    await migrate(sql);

    /* ------------------------------------------------------------------ */
    /* Build the estate                                                    */
    /* ------------------------------------------------------------------ */

    const seedStarted = performance.now();

    const [org] = (await sql`
      INSERT INTO organizations (name, slug) VALUES ('Load Test Partners', 'load-test')
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const organizationId = (org as { id: string }).id;

    const [user] = (await sql`
      INSERT INTO users (email, name, password_hash)
      VALUES ('load@example.invalid', 'Load Test', 'not-a-real-hash')
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    const userId = (user as { id: string }).id;

    // Inserted in batches rather than row by row: a thousand round trips would
    // measure the network, not the database.
    const propertyRows = Array.from({ length: PROPERTIES }, (_, i) => ({
      organization_id: organizationId,
      name: `Load Property ${String(i + 1).padStart(5, '0')}`,
      property_type: ['office', 'industrial', 'retail', 'multifamily'][i % 4] as string,
      city: `City ${i % 50}`,
      market: `Market ${i % 20}`,
      rentable_area: String(50_000 + (i % 100) * 1000),
      unit_count: 0,
      created_by: userId,
    }));
    const propertyIds: string[] = [];
    for (let i = 0; i < propertyRows.length; i += 500) {
      const batch = propertyRows.slice(i, i + 500);
      const inserted = (await sql`
        INSERT INTO properties ${sql(batch as never)} RETURNING id
      `) as unknown as Array<{ id: string }>;
      propertyIds.push(...inserted.map((row) => row.id));
    }

    const modelRows = propertyIds.flatMap((propertyId, i) =>
      Array.from({ length: MODELS_PER_PROPERTY }, (_, m) => ({
        organization_id: organizationId,
        property_id: propertyId,
        name: `Model ${m + 1}`,
        classification: m === 0 ? 'valuation' : 'business_plan',
        status: m === 0 ? 'published' : 'draft',
        owner_id: userId,
        valuation_date: '2026-01-01',
        forecast_start_date: '2026-01-01',
        forecast_months: 120,
        discount_rate: '0.08',
        terminal_cap_rate: '0.065',
        sale_month: 108,
        acquisition_price: String(10_000_000 + i * 1000),
        created_by: userId,
      })),
    );
    const modelIds: string[] = [];
    for (let i = 0; i < modelRows.length; i += 500) {
      const batch = modelRows.slice(i, i + 500);
      const inserted = (await sql`
        INSERT INTO models ${sql(batch as never)} RETURNING id
      `) as unknown as Array<{ id: string }>;
      modelIds.push(...inserted.map((row) => row.id));
    }

    // One stored calculation per published model, carrying a result of a size
    // comparable to a real ten-year monthly forecast. The size matters: the
    // aggregate reads these, and a small stub would flatter it.
    const monthly = Object.fromEntries(
      ['scheduledBaseRent', 'operatingExpenses', 'netOperatingIncome', 'unleveredCashFlow'].map(
        (line) => [line, Array.from({ length: 120 }, (_, m) => String(10_000 + m))],
      ),
    );
    const sampleResult = {
      engineVersion: '3.3.1',
      calculatedAt: '2026-01-01T00:00:00.000Z',
      currency: 'USD',
      areaUnit: 'sqft',
      monthly,
      annual: Array.from({ length: 10 }, (_, y) => ({
        fiscalYear: 2026 + y,
        months: 12,
        lines: {},
      })),
      periods: Array.from({ length: 120 }, (_, m) => ({ index: m + 1, startDate: '2026-01-01' })),
      occupancy: Array.from({ length: 120 }, () => ({ physicalOccupancyPercent: '0.95' })),
      returns: { unleveredIrr: '0.0812', leveredIrr: null, equityMultiple: '1.9' },
      valuations: [{ method: 'dcf', value: '12500000', detail: {} }],
      debtSchedules: [],
      waterfall: [],
      diagnostics: [],
      trace: [],
    };

    const publishedModelIds = modelIds.filter((_, i) => i % MODELS_PER_PROPERTY === 0);
    for (let i = 0; i < publishedModelIds.length; i += 200) {
      const batch = publishedModelIds.slice(i, i + 200).map((modelId) => ({
        model_id: modelId,
        engine_version: '3.3.1',
        status: 'succeeded',
        result: sql.json(sampleResult as never),
        diagnostics: sql.json([] as never),
        requested_by: userId,
        completed_at: new Date(),
      }));
      await sql`INSERT INTO calculation_runs ${sql(batch as never)}`;
    }

    // One tenant per property, so leases reference a real counterparty rather
    // than a null the schema would rightly refuse.
    const tenantIds: string[] = [];
    for (let i = 0; i < propertyIds.length; i += 500) {
      const batch = propertyIds.slice(i, i + 500).map((propertyId, k) => ({
        organization_id: organizationId,
        property_id: propertyId,
        name: `Load Tenant ${i + k + 1}`,
        industry: 'Testing',
      }));
      const inserted = (await sql`
        INSERT INTO tenants ${sql(batch as never)} RETURNING id
      `) as unknown as Array<{ id: string }>;
      tenantIds.push(...inserted.map((row) => row.id));
    }

    // Leases, which is where the row count actually gets large.
    let leaseCount = 0;
    for (let m = 0; m < modelIds.length; m += 50) {
      const slice = modelIds.slice(m, m + 50);
      const batch = slice.flatMap((modelId, k) =>
        Array.from({ length: LEASES_PER_MODEL }, (_, l) => ({
          model_id: modelId,
          // Models were generated property by property, so this recovers the
          // property a model belongs to without a second lookup.
          tenant_id: tenantIds[Math.floor((m + k) / MODELS_PER_PROPERTY)] as string,
          code: `L-${k}-${l}`,
          status: 'occupied',
          area: '2500',
          commencement_date: '2024-01-01',
          expiration_date: '2031-12-31',
          base_rent: '30.00',
          base_rent_basis: 'per_area_per_year',
        })),
      );
      await sql`INSERT INTO leases ${sql(batch as never)}`;
      leaseCount += batch.length;
    }

    for (let i = 0; i < AUDIT_ROWS; i += 2000) {
      const batch = Array.from({ length: Math.min(2000, AUDIT_ROWS - i) }, (_, k) => ({
        organization_id: organizationId,
        user_id: userId,
        action: 'model.calculated',
        entity_type: 'model',
        entity_id: modelIds[(i + k) % modelIds.length] as string,
        metadata: sql.json({} as never),
      }));
      await sql`INSERT INTO audit_log ${sql(batch as never)}`;
    }

    const seedSeconds = (performance.now() - seedStarted) / 1000;
    console.warn(
      `  built in ${seedSeconds.toFixed(1)}s: ${propertyIds.length} properties, ` +
        `${modelIds.length} models, ${leaseCount} leases, ${AUDIT_ROWS} audit rows\n`,
    );

    /* ------------------------------------------------------------------ */
    /* Measure                                                             */
    /* ------------------------------------------------------------------ */

    await time('property list, first page', 'LIMIT 50 with a count', 250, async () =>
      listProperties(sql, organizationId, { limit: 50 }),
    );

    await time('property list, deep page', 'OFFSET 900', 250, async () =>
      listProperties(sql, organizationId, { limit: 50, offset: 900 }),
    );

    await time('property search', 'name ILIKE %00042%', 400, async () =>
      listProperties(sql, organizationId, { limit: 50, search: '00042' }),
    );

    await time('model list, whole organization', 'LIMIT 500', 300, async () =>
      listModels(sql, organizationId),
    );

    await time('model list for one property', 'unbounded by design', 100, async () =>
      listModels(sql, organizationId, propertyIds[0] as string),
    );

    await time('audit log, first page', 'LIMIT 100 of 50k', 300, async () =>
      listAudit(sql, { organizationId, limit: 100 }),
    );

    await time('latest calculation for one model', 'full result JSONB', 100, async () =>
      getLatestCalculation(sql, publishedModelIds[0] as string),
    );

    // What the portfolio aggregate does today, reproduced exactly: for each
    // property, find its leading model, then read that model's whole stored
    // result. Measured over a portfolio of 100 because that is a plausible
    // fund, and because a thousand would take long enough to make the point
    // twice.
    // What the portfolio aggregate does: find each property's leading model and
    // read its stored result. Measured both ways — the loop this used to be,
    // and the single query it is now — because the point of a load test is to
    // show the difference, not to assert it.
    for (const size of [100, 500]) {
      const portfolioSize = Math.min(size, propertyIds.length);
      const slice = propertyIds.slice(0, portfolioSize);

      await time(
        `aggregate ${portfolioSize}, per-property loop`,
        `${portfolioSize * 2} round trips`,
        undefined,
        async () => {
          const results = [];
          for (const propertyId of slice) {
            const rows = (await sql`
              SELECT id FROM models
              WHERE property_id = ${propertyId} AND organization_id = ${organizationId}
                AND deleted_at IS NULL
              ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                       updated_at DESC
              LIMIT 1
            `) as unknown as Array<{ id: string }>;
            const modelId = rows[0]?.id;
            if (!modelId) continue;
            results.push(await getLatestCalculation(sql, modelId));
          }
          return results;
        },
      );

      await time(
        `aggregate ${portfolioSize}, single query`,
        '1 round trip',
        Math.max(300, portfolioSize),
        async () =>
          sql`
            WITH leading_model AS (
              SELECT DISTINCT ON (m.property_id) m.property_id, m.id AS model_id
              FROM models m
              WHERE m.organization_id = ${organizationId}
                AND m.property_id = ANY(${slice}::uuid[])
                AND m.deleted_at IS NULL
              ORDER BY m.property_id,
                       CASE m.status WHEN 'published' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                       m.updated_at DESC
            )
            SELECT DISTINCT ON (lm.property_id) lm.property_id, lm.model_id, r.result
            FROM leading_model lm
            LEFT JOIN calculation_runs r
              ON r.model_id = lm.model_id AND r.status = 'succeeded' AND r.result IS NOT NULL
            ORDER BY lm.property_id, r.created_at DESC
          `,
      );
    }

    /* ------------------------------------------------------------------ */
    /* Report                                                              */
    /* ------------------------------------------------------------------ */

    const pad = (value: string, width: number): string => value.padEnd(width);
    const padLeft = (value: string, width: number): string => value.padStart(width);

    console.warn(`${pad('Query', 44)}${padLeft('ms', 10)}${padLeft('budget', 10)}  Detail`);
    console.warn('-'.repeat(100));

    const exceeded: Timing[] = [];
    for (const entry of timings) {
      const ok = entry.budget === undefined || entry.millis <= entry.budget;
      if (!ok) exceeded.push(entry);
      console.warn(
        pad(entry.name, 44) +
          padLeft(entry.millis.toFixed(1), 10) +
          padLeft(entry.budget ? (ok ? 'ok' : 'EXCEEDED') : '—', 10) +
          '  ' +
          entry.detail,
      );
    }

    console.warn(
      '\nMeasured against a local PostgreSQL on this machine. Absolute numbers are\n' +
        'not portable; what is portable is which queries scale and which do not.',
    );

    if (exceeded.length > 0) {
      console.error(`\n${exceeded.length} quer(y/ies) exceeded budget:`);
      for (const entry of exceeded) {
        console.error(`  - ${entry.name}: ${entry.millis.toFixed(0)}ms against ${entry.budget}ms`);
      }
      process.exitCode = 1;
    } else {
      console.warn('\nEvery query is inside its budget.');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
} finally {
  await dropLoadDatabase();
  await admin.end({ timeout: 5 });
}
