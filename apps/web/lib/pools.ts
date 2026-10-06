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

/**
 * B11: statements this process has issued against each database since the
 * count was last read, keyed by connection URL.
 *
 * Counted HERE, at the pool, because this is where a statement actually
 * leaves the process — not in `runCheckFor`, which would miss the version
 * probe below and anything a page runs outside a check, and so would
 * under-report the console's own share. Under-reporting it is the one error
 * this count exists to prevent: the number is on screen precisely so an
 * operator does not read pgops's polling as the application's load.
 *
 * Keyed by URL, as POOLS is, and NOT by name as rates.ts's own Map is: a
 * commit counter is a fact about a database, so two names pointing at one
 * database share the count the same way they share the pool and share the
 * `pg_stat_database` row these numbers are compared against.
 *
 * Per process, like every other rate here. A second replica's polling is
 * invisible to this one, which is exactly why `Throughput` STATES this
 * number beside the rate instead of subtracting it from it.
 */
const OWN = new Map<string, number>();

/**
 * How many statements this process has issued against `name` since the last
 * call, resetting the count. Read once per sample by `ratesFor`, so the
 * count always covers the same window as the rate it is divided into.
 *
 * Never throws. It resolves a name through the environment, which can fail
 * on a misconfigured deployment, and a throughput line is not worth taking a
 * page down for — an unresolvable name has issued nothing.
 */
export function ownStatementsSince(name: string): number {
  let url: string | undefined;
  try {
    url = configured().find((d) => d.name === name)?.url;
  } catch {
    return 0;
  }
  if (url === undefined) return 0;
  const n = OWN.get(url) ?? 0;
  OWN.set(url, 0);
  return n;
}


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
  // B11. `pg` emits no per-query event, so the count is taken by wrapping
  // `query` once, here, at the moment the pool is created — every check's
  // statement goes through it (run.ts reaches for `ctx.target.query`), as
  // does the version probe below.
  //
  // A client checked out with `pool.connect()` is deliberately NOT counted:
  // that path is explain and terminate, which an operator ran on purpose and
  // which happen once, where this number exists to explain a rate that
  // repeats every five seconds.
  const inner = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  pool.query = function wrapped(...args: unknown[]) {
    OWN.set(db.url, (OWN.get(db.url) ?? 0) + 1);
    return inner(...args);
  } as typeof pool.query;
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
