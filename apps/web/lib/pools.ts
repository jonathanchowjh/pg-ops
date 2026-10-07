import { Pool, type PoolClient } from 'pg';
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
 * The same count as OWN, never reset. OWN is read-and-reset by the
 * Throughput line; the health tick needs its own window over the same
 * statements, and two readers cannot share one read-and-reset counter
 * without each stealing from the other.
 */
const OWN_TOTAL = new Map<string, number>();

/** Statements this process has sent the named database since it started. */
export function ownStatementsTotal(name: string): number {
  let url: string | undefined;
  try {
    url = configured().find((d) => d.name === name)?.url;
  } catch {
    return 0;
  }
  return url === undefined ? 0 : OWN_TOTAL.get(url) ?? 0;
}

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

/** pg hands the same client object out again and again; each is wrapped once. */
const COUNTED = new WeakSet<object>();
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/i;

/**
 * Count statements sent on a checked-out client into OWN_TOTAL.
 *
 * `pool.query` is counted where it is wrapped below, but the health tick and
 * every check with a timeout run on a client from `connect()`, and those
 * were invisible: the Health page's "statements pgops itself sent" read zero
 * beside a commit rate that was pgops's own. BEGIN, COMMIT, ROLLBACK and
 * SET LOCAL are not counted; they are the envelope, not a statement.
 *
 * Only OWN_TOTAL. The Throughput line's counter keeps the meaning its own
 * tests pin.
 */
function countClientStatements(pool: Pool, url: string): void {
  const count = (client: PoolClient): PoolClient => {
    if (COUNTED.has(client)) return client;
    COUNTED.add(client);
    const inner = client.query.bind(client) as (...a: unknown[]) => unknown;
    client.query = function counted(...a: unknown[]) {
      const first = a[0];
      const text = typeof first === 'string' ? first : (first as { text?: unknown } | null)?.text;
      if (typeof text === 'string' && !TRANSACTION_CONTROL.test(text)) {
        OWN_TOTAL.set(url, (OWN_TOTAL.get(url) ?? 0) + 1);
      }
      return inner(...a);
    } as typeof client.query;
    return client;
  };
  const innerConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  // `pool.query` itself calls the CALLBACK form of connect (the trap
  // lib/store.ts documents). That path is passed through untouched: its
  // statement was already counted by the pool.query wrapper.
  pool.connect = function countedConnect(...args: unknown[]) {
    if (typeof args[0] === 'function') return innerConnect(...args);
    return (innerConnect(...args) as Promise<PoolClient>).then(count);
  } as typeof pool.connect;
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
    OWN_TOTAL.set(db.url, (OWN_TOTAL.get(db.url) ?? 0) + 1);
    return inner(...args);
  } as typeof pool.query;
  countClientStatements(pool, db.url);
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
