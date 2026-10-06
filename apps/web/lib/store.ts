import { Pool, type PoolClient } from 'pg';
import { OWN_SQL_MARKER } from '@pgops/checks';
import { APP_NAME } from './config';

/**
 * The store is opt-in, and deliberately has NO fallback to a monitored
 * database.
 *
 * The parent spec had it fall back to the monitored database when only one was
 * configured. On the documented simplest deployment — `docker run -e
 * DATABASE_URL=…` — that would have pgops issue CREATE SCHEMA against a
 * production database an operator pointed it at expecting a read-only tool,
 * contradicting the README's "pgops runs no DDL against a monitored
 * database". Cut. See spec 2026-09-03 §3.3.
 */
export function storeUrl(env: Record<string, string | undefined>): string | null {
  const url = env.PGOPS_STORE_URL;
  // Unset and empty both mean "no store". Empty is called out explicitly
  // rather than left to fall through, because a `Pool` built on an empty
  // connection string fails at connect time, not at configuration time —
  // the failure would show up far from its cause.
  if (url === undefined || url === '') return null;
  return url;
}

// Module-level, for the same reason lib/pools.ts keeps POOLS: a pool per
// request would exhaust the store's connections. One store, so one entry —
// unlike POOLS, this slot DOES evict (a changed PGOPS_STORE_URL replaces
// it), so eviction must end the superseded pool or its sockets leak.
let STORE: Pool | null = null;
let STORE_FOR: string | null = null;

/**
 * Retire the cached pool, if any.
 *
 * Best-effort: match packages/checks/test/harness.ts's `.end().catch(() =>
 * {})`. `.end()` rejecting on a double-end (or any other pg quirk) must not
 * block building a replacement.
 *
 * What `end()` actually does, stated correctly because an earlier version of
 * this comment did not: it stops the pool handing out new clients, closes
 * idle ones immediately, and closes the rest as they are released. It does
 * NOT cancel a query already in flight — that query runs to completion on its
 * connection, which is closed afterwards.
 */
function retire(): void {
  if (STORE) STORE.end().catch(() => {});
  STORE = null;
  STORE_FOR = null;
}

export function storePool(env: Record<string, string | undefined>): Pool | null {
  const url = storeUrl(env);
  if (url === null) {
    // Unsetting PGOPS_STORE_URL evicts too. Returning null while leaving the
    // cached pool open orphaned a Pool with live sockets — the same leak the
    // changed-URL branch below exists to prevent, one branch over.
    retire();
    return null;
  }
  if (STORE && STORE_FOR === url) return STORE;
  retire();
  // `pgops-store`, not `pgops`: when PGOPS_STORE_URL points at a database
  // pgops also monitors — the documented single-database dev setup does
  // exactly this — the capture's writes appear in that database's own
  // Sessions list, and "which of these is the store" is the first question an
  // operator asks when the store is the thing misbehaving.
  const pool = new Pool({
    connectionString: url, max: 5, connectionTimeoutMillis: 5_000,
    application_name: `${APP_NAME}-store`,
  });
  // Same reasoning as poolFor: an unhandled pool 'error' event terminates the
  // process, and a console that dies because the store blinked is worse than
  // one that reports history as unavailable.
  pool.on('error', () => {});
  markOwnStatements(pool);
  STORE = pool;
  STORE_FOR = url;
  return pool;
}

/**
 * Mark everything the store sends with `OWN_SQL_MARKER`, so the `queryStats`
 * check excludes it the way it already excludes every statement `runCheck`
 * issues.
 *
 * WHY THIS IS NEEDED AT ALL. A8 stopped the console reporting its own
 * polling as the database's load, by marking each check's SQL in
 * `run.ts`'s `ownSql` and filtering on it in `query-stats.ts`. The store's
 * statements never pass through `runCheck`, so none of them were marked —
 * and when `PGOPS_STORE_URL` points at a database pgops also monitors, which
 * the comment in `storePool` above notes the documented single-database dev
 * setup does, they land in that database's own `pg_stat_statements`.
 *
 * Measured on the dev console with a freshly reset `pg_stat_statements`:
 * three store reads appeared unmarked on every page load, and over an hour
 * of captures the store's `INSERT INTO pgops.queries` was the NUMBER ONE
 * statement by total time on the Queries page. The console's headline answer
 * to "what is slow on this database" was the console describing itself.
 *
 * `application_name: pgops-store` above already solved the sibling problem
 * for the Sessions list; this is the same idea for `pg_stat_statements`.
 *
 * WRAPPED HERE, at the one place a store pool is built, rather than at the
 * store's sixteen call sites across four files — the same reasoning, and the
 * same shape, as `pools.ts`'s own `query` wrapper for B11's counter.
 *
 * BOTH `query` AND `connect` are wrapped, and `connect` is the load-bearing
 * one: every statement the store actually issues goes through
 * `client.query` on a checked-out client (`store.connect()` in capture.ts,
 * `PoolClient` throughout `store/write.ts`), so wrapping `pool.query` alone
 * would have marked almost nothing. `pool.query` is wrapped because
 * `store/read.ts` accepts a `Pool` as well as a `PoolClient`.
 *
 * Each client is wrapped ONCE EVER, tracked in `WRAPPED`, and that is not a
 * micro-optimisation. `pg` pools the `PoolClient` OBJECTS and hands the same
 * one back on a later checkout, so wrapping per checkout nests the wrapper
 * and the text grows a marker each time. A test pinned it: three checkouts
 * produced `SELECT 1\n/* pgops *\/\n/* pgops *\/`. Every variant is still
 * excluded, so nothing would look wrong on screen — it would just quietly
 * fill `pg_stat_statements` with a fresh queryid per checkout, which is the
 * catalog this console reads to answer what is slow.
 */
const WRAPPED = new WeakSet<object>();

function markOwnStatements(pool: Pool): void {
  const mark = (args: unknown[]): unknown[] => {
    const [first, ...rest] = args;
    if (typeof first === 'string') return [ownText(first), ...rest];
    // The config-object form. Only `text` changes; `name`, `values` and
    // `rowMode` travel untouched — a named prepared statement whose name
    // moved would stop agreeing with the server's cached plan.
    if (first !== null && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string') {
      const cfg = first as { text: string };
      return [{ ...cfg, text: ownText(cfg.text) }, ...rest];
    }
    // A cursor or any other submittable: nothing safe to rewrite, so it goes
    // through unchanged rather than being guessed at.
    return args;
  };

  const innerQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  pool.query = function wrapped(...args: unknown[]) {
    return innerQuery(...mark(args));
  } as typeof pool.query;

  const wrapClient = (client: PoolClient): PoolClient => {
    if (WRAPPED.has(client)) return client;
    WRAPPED.add(client);
    const innerClientQuery = client.query.bind(client) as (...a: unknown[]) => unknown;
    client.query = function wrappedClientQuery(...a: unknown[]) {
      return innerClientQuery(...mark(a));
    } as typeof client.query;
    return client;
  };

  /**
   * BOTH of `connect`'s forms, and the callback one is not exotic: `pg`'s own
   * `Pool.query` calls `this.connect(callback)` internally. The first version
   * of this wrapper did `innerConnect(...args).then(...)` unconditionally,
   * which returns undefined for the callback form — so every `pool.query` on
   * the store pool threw `Cannot read properties of undefined (reading
   * 'then')` and the Queries page reported history as unreadable. 612 tests
   * passed; driving the page found it in one look, because every test here
   * had used the promise form and so only ever asked the wrapper the
   * question it could answer.
   */
  const innerConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  pool.connect = function wrappedConnect(...args: unknown[]) {
    const [first] = args;
    if (typeof first === 'function') {
      const cb = first as (err: unknown, client: PoolClient | undefined, done: unknown) => void;
      // `done` travels through untouched: pg's own Pool.query releases the
      // client with it, and an error arrives with no client to wrap.
      return innerConnect((err: unknown, client: PoolClient | undefined, done: unknown) => {
        cb(err, client === undefined ? client : wrapClient(client), done);
      }, ...args.slice(1));
    }
    return (innerConnect(...args) as Promise<PoolClient>).then(wrapClient);
  } as typeof pool.connect;
}

/**
 * The marker on its own line.
 *
 * The newline is load-bearing and copied from `run.ts`'s `ownSql` rather
 * than re-derived: a statement whose last line ends in a `--` comment would
 * swallow a marker appended to that same line.
 */
function ownText(text: string): string {
  return `${text}\n${OWN_SQL_MARKER}`;
}
