import { Pool } from 'pg';
import type { CheckContext } from '@pgops/checks';
// Extensionless — see the comment on the equivalent import in lib/check.ts.
import { readDatabases, type DatabaseConfig } from './config';

export class UnknownDatabaseError extends Error {
  constructor(name: string, known: string[]) {
    super(`No database named "${name}". Configured: ${known.join(', ') || '(none)'}`);
    this.name = 'UnknownDatabaseError';
  }
}

/**
 * The ONE piece of module-level mutable state in this app, and deliberately so
 * (see the plan's note to reviewers). `packages/checks` forbids it because a
 * library that reaches for a pool can only ever address one database. A web
 * PROCESS is the opposite case: opening a pool per request would exhaust
 * max_connections on the database it is diagnosing, at exactly the moment that
 * matters. Keyed by connection URL rather than by name so that two names
 * pointing at one database share a pool, and so a renamed database does not
 * strand its pool.
 */
const POOLS = new Map<string, Pool>();
const VERSIONS = new Map<string, number>();

function configured(): DatabaseConfig[] {
  return readDatabases(process.env);
}

export function databaseNames(): string[] {
  return configured().map((d) => d.name);
}

function poolFor(db: DatabaseConfig): Pool {
  const existing = POOLS.get(db.url);
  if (existing) return existing;
  const pool = new Pool({
    connectionString: db.url,
    // A diagnostic tool must not be the reason connections run out. Ten is
    // ample for a console rendering a handful of checks per page view.
    max: 10,
    // Fail visibly rather than hanging a page render forever.
    connectionTimeoutMillis: 5_000,
  });
  // A pool-level error with no listener is an unhandled 'error' event, which
  // terminates the Node process. A console that dies because an idle backend
  // was terminated server-side is worse than one that renders a failed check.
  pool.on('error', () => {});
  POOLS.set(db.url, pool);
  return pool;
}

export async function contextFor(name: string): Promise<CheckContext> {
  const dbs = configured();
  const db = dbs.find((d) => d.name === name);
  if (!db) throw new UnknownDatabaseError(name, dbs.map((d) => d.name));

  const target = poolFor(db);

  // Probed once per database, then cached: server_version_num cannot change
  // without the server restarting, and a restart drops the pool anyway.
  let serverVersion = VERSIONS.get(db.url);
  if (serverVersion === undefined) {
    const { rows } = await target.query<{ server_version_num: string }>('SHOW server_version_num');
    serverVersion = Number(rows[0]!.server_version_num);
    VERSIONS.set(db.url, serverVersion);
  }

  return { target, serverVersion };
}
