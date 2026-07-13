import pg from 'pg';

const { Pool } = pg;

/**
 * One shared connection pool per process (ADR-005).
 *
 * - Reads `DATABASE_URL` from the environment unless an explicit connection
 *   string is passed (the `-d` flag).
 * - `max: 2` keeps pgops's connection-count impact on a production DB tiny — one
 *   for the polling query, one spare for an action (e.g. a kill) mid-poll.
 * - `application_name=pgops` so a DBA watching `pg_stat_activity` can see exactly
 *   which sessions are ours.
 *
 * The connection string is never logged (plan §G, Secrets handling).
 */
export class ConnectionError extends Error {}

let pool: pg.Pool | undefined;

export interface ConnectOptions {
  /** Explicit connection string from the `-d` flag; falls back to DATABASE_URL. */
  connectionString?: string;
}

export function getPool(opts: ConnectOptions = {}): pg.Pool {
  if (pool) return pool;

  const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new ConnectionError(
      'No database connection. Set DATABASE_URL or pass -d "postgres://...".',
    );
  }

  pool = new Pool({
    connectionString,
    max: 2,
    application_name: 'pgops',
    // Fail fast at connect time rather than hanging during an incident.
    connectionTimeoutMillis: 5_000,
  });

  // An idle pooled connection can drop out from under us — an RDS failover, an
  // admin terminating pgops's own backend (57P01), the network blipping. pg
  // surfaces that as an 'error' event on the pool; with no listener Node would
  // crash the whole process. We're a tool you run *during* the incident, so we
  // absorb it: the active query path has its own try/catch, and the next poll
  // reconnects and re-surfaces any real problem through the normal channel.
  pool.on('error', (err) => {
    lastPoolError = err;
  });

  return pool;
}

/** Most recent idle-connection error, if any (surfaced by views that want it). */
export let lastPoolError: Error | undefined;

/** Run a parameterized query against the shared pool. Always typed, never string-built. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as never[]);
  return result.rows;
}

/**
 * Show "host:port/db" without credentials — the status-bar target label.
 * Lives in core because every runner (locks, top, sessions, home) needs it and
 * the redaction must be identical in all of them (plan §G, Secrets handling).
 */
export function safeTarget(connectionString?: string): string | undefined {
  if (!connectionString) return undefined;
  try {
    const u = new URL(connectionString);
    // A URL with no host ("postgres://") parses but has nothing to show; an
    // empty label in the status bar is worse than none.
    if (!u.hostname) return undefined;
    const db = u.pathname.replace(/^\//, '');
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${db ? `/${db}` : ''}`;
  } catch {
    return undefined;
  }
}

/** Close the pool cleanly on exit. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
