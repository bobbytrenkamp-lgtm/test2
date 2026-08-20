import postgres from 'postgres';

export type Sql = postgres.Sql<Record<string, never>>;
/**
 * Re-exported so a caller catching a unique-violation race (two concurrent
 * inserts of what should be one-of-a-kind row — a duplicate registration
 * email, say) can do so without adding `postgres` as a direct dependency of
 * its own package.
 */
export const PostgresError = postgres.PostgresError;

let singleton: Sql | null = null;

export interface DatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  /** Set on the connection so slow queries are visible in the logs. */
  statementTimeoutMs?: number;
}

/**
 * Creates a connection pool.
 *
 * Numeric columns are returned as strings rather than JavaScript numbers.
 * Money and rates travel through the platform as decimal strings end to end,
 * and letting the driver coerce them to floats would silently reintroduce the
 * binary rounding the calculation engine exists to avoid.
 */
export function createDatabase(options: DatabaseOptions): Sql {
  return postgres(options.connectionString, {
    max: options.maxConnections ?? 10,
    types: {
      // Keep numeric/decimal as text.
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (value: unknown) => String(value),
        parse: (value: string) => value,
      },
    },
    connection: {
      statement_timeout: options.statementTimeoutMs ?? 30_000,
      application_name: 'cre-platform',
    },
    onnotice: () => {
      // PostgreSQL notices (for example "table already exists, skipping") are
      // not application events; suppress them from the request logs.
    },
  }) as unknown as Sql;
}

export function getDatabase(connectionString?: string): Sql {
  if (singleton) return singleton;
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and point it at your PostgreSQL instance.',
    );
  }
  singleton = createDatabase({ connectionString: url });
  return singleton;
}

export async function closeDatabase(): Promise<void> {
  if (singleton) {
    await singleton.end({ timeout: 5 });
    singleton = null;
  }
}
