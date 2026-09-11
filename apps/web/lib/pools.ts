import { Pool } from 'pg';
import type { CheckContext } from '@pgops/checks';
// Extensionless — see the comment on the equivalent import in lib/check.ts.
import { APP_NAME, readDatabases, type DatabaseConfig } from './config';
import { storePool } from './store';

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
    // So pgops can recognise its own backends, which it could not do at all.
    //
    // Without this, every pool opened here reported an EMPTY application_name,
    // and the Sessions page showed pgops's own ~19 idle connections
    // interleaved with the application's — each with its own Terminate link,
    // offering to kill the console. Three real sessions in an incident were
    // three rows out of twenty-two.
    //
    // Verified against PG 17, not assumed: `pg`'s ConnectionParameters
    // Object.assigns the PARSED connection string over the explicit config,
    // so a URL carrying `?application_name=` wins over this line (and over
    // `fallback_application_name`, which behaves identically here). That is
    // the right precedence — an operator who named their connections meant
    // it — and the consequence is stated where it lands: the Sessions fold
    // keys on APP_NAME, so on such a deployment it matches nothing and every
    // row stays visible. It over-shows; it never hides a real session.
    application_name: APP_NAME,
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

  // `store` is undefined, not null, when unset: CheckContext types it as
  // optional, and runSeries tests presence rather than nullness.
  const store = storePool(process.env) ?? undefined;
  return { target, store, serverVersion };
}
