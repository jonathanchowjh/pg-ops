import { Pool, type PoolClient } from 'pg';
import { CHECKS, PGOPS_APP, messageOf, ownSql, type CheckContext, type IdentityData, type IdentityRow } from '@pgops/checks';
// Extensionless — see the comment on the equivalent import in lib/check.ts.
import { readDatabases, storeUrl, type DatabaseConfig } from './config';

/**
 * Every pool this console holds: one per monitored database and one for the
 * store.
 *
 * On `globalThis`, not module-level: Next compiles this file into the
 * instrumentation bundle, the page bundle and each route's, and module-level
 * maps would be one set of pools per bundle, each up to its `max`, on the
 * database pgops is diagnosing. Opening a pool per request would be worse.
 */

export class UnknownDatabaseError extends Error {
  constructor(name: string, known: string[]) {
    super(`No database named "${name}". Configured: ${known.join(', ') || '(none)'}`);
    this.name = 'UnknownDatabaseError';
  }
}

/** What this process holds for one monitored database. */
interface Target {
  pool: Pool;
  /** Probed on first use; cannot change without a restart or a remove, each of which drops the pool. */
  serverVersion?: number;
}

interface Held {
  /**
   * Keyed by connection URL rather than by name, so two names pointing at
   * one database share a pool, and a renamed database does not strand its pool.
   */
  targets: Map<string, Target>;
  /** Replaced when PGOPS_STORE_URL changes, so it is retired, not left open. */
  store: { pool: Pool; url: string } | null;
}
const KEY = Symbol.for('pgops.pools');
const HELD: Held = ((globalThis as { [KEY]?: Held })[KEY] ??= { targets: new Map(), store: null });

function configured(): DatabaseConfig[] {
  return readDatabases(process.env);
}

export function databaseNames(): string[] {
  return configured().map((d) => d.name);
}

/** Every configured database by name and where it is set: what the fleet's database list may show. Never the URL. */
export function databaseList(): { name: string; source: DatabaseConfig['source'] }[] {
  return configured().map(({ name, source }) => ({ name, source }));
}

/** The longest any statement to a monitored database runs, and waits on a lock, unless its check says otherwise. */
const TARGET_STATEMENT_MS = 15_000;
const TARGET_LOCK_MS = 1_000;

function targetFor(db: DatabaseConfig): Target {
  const existing = HELD.targets.get(db.url);
  if (existing) return existing;
  const target: Target = { pool: targetPool(db.url, 10) };
  HELD.targets.set(db.url, target);
  return target;
}

/** A pool on a monitored database, connected the one way pgops ever connects to one. */
function targetPool(url: string, max: number): Pool {
  const pool = new Pool({
    connectionString: url,
    // So pgops can recognise its own backends on the Sessions page.
    //
    // `pg`'s ConnectionParameters assigns the parsed connection string over
    // the explicit config, so a URL carrying `?application_name=` wins over
    // this line (and over `fallback_application_name`). The checks know
    // pgops by PGOPS_APP exactly, so on such a deployment its own sessions
    // show as anyone's. It over-shows; it never hides a real session.
    application_name: PGOPS_APP,
    // A diagnostic tool must not be the reason connections run out.
    max,
    // Fail visibly rather than hanging a page render forever.
    connectionTimeoutMillis: 5_000,
    // A backstop for every statement no check bounds itself, and a lock it
    // will not wait behind: this pool is aimed at a database that may be
    // the one in trouble. A check's own `SET LOCAL` overrides both.
    //
    // A `SET` once connected, not `pg`'s `statement_timeout` option: that
    // one travels in the startup packet, and Postgres then reports pgops's
    // value as the server's in both `current_setting` and `reset_val`, so
    // Server could never show a timeout of 0. After a `SET`, `reset_val` is
    // still the server's. pg-pool awaits `onConnect` before it hands the
    // client out, and ends a client whose hook failed rather than hand it out
    // unbounded.
    //
    onConnect: async (client) => {
      await client.query(ownSql(`SET statement_timeout = ${TARGET_STATEMENT_MS}`));
      await client.query(ownSql(`SET lock_timeout = ${TARGET_LOCK_MS}`));
    },
    // Read only, so pgops cannot change a row or the schema: the server
    // refuses with 25006. What the actions do is still allowed in a read-only
    // transaction (pg_terminate_backend, ANALYZE, the statistics resets), and
    // those routes exist only with PGOPS_ALLOW_ACTIONS.
    //
    // In the startup packet, not a `SET`. It is the session's reset value,
    // so RESET cannot undo it. And a SET on a server connection a
    // transaction-mode pooler shares stays there for the next client, on a
    // pooler that does not restore settings between clients (PgBouncer 1.26
    // does); that next client could be the application, and its writes would
    // fail. A pooler refuses, honours or ignores a startup option, and
    // `probe` reads back "off" for one that ignores it. A URL
    // carrying its own `?options=` replaces this one, which `probe` catches
    // for a database added in the console.
    options: '-c default_transaction_read_only=on',
  });
  // A pool-level error with no listener is an unhandled 'error' event, which
  // terminates the Node process.
  pool.on('error', () => {});
  return pool;
}

/**
 * Close the pool on a URL no configured database uses any more: the database
 * was removed. Two names can share one URL, and so one pool.
 */
export function retireTarget(url: string): void {
  if (configured().some((d) => d.url === url)) return;
  HELD.targets.get(url)?.pool.end().catch(() => {});
  HELD.targets.delete(url);
}

/**
 * Connect to a database not yet configured, the way `targetFor` would, and
 * say what the server answers: who it is, and whether the session is read
 * only. The pool is closed before this returns.
 */
export async function probe(url: string): Promise<{ identity: IdentityData; readOnly: boolean }> {
  const pool = targetPool(url, 1);
  try {
    const { rows } = await pool.query<IdentityRow>(ownSql(CHECKS.identity.sql as string));
    const ro = await pool.query<{ transaction_read_only: string }>(ownSql('SHOW transaction_read_only'));
    return { identity: CHECKS.identity.map(rows), readOnly: ro.rows[0]?.transaction_read_only === 'on' };
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function contextFor(name: string): Promise<CheckContext> {
  const dbs = configured();
  const db = dbs.find((d) => d.name === name);
  if (!db) throw new UnknownDatabaseError(name, dbs.map((d) => d.name));

  const found = targetFor(db);
  const target = found.pool;

  if (found.serverVersion === undefined) {
    const { rows } = await target.query<{ server_version_num: string }>('SHOW server_version_num');
    found.serverVersion = Number(rows[0]!.server_version_num);
  }
  const serverVersion = found.serverVersion;

  // `store` is undefined, not null, when unset: CheckContext types it as optional.
  const store = storePool(process.env) ?? undefined;
  return { target, store, serverVersion };
}

/** What any one store statement may take, and wait on a lock. */
const STORE_STATEMENT_MS = 10_000;
const STORE_LOCK_MS = 2_000;

/**
 * Retire the cached pool, if any. Best-effort: `.end()` rejecting must not
 * block building a replacement.
 *
 * `end()` stops the pool handing out new clients, closes idle ones
 * immediately, and closes the rest as they are released. It does not cancel
 * a query already in flight.
 */
function retire(): void {
  HELD.store?.pool.end().catch(() => {});
  HELD.store = null;
}

export function storePool(env: Record<string, string | undefined>): Pool | null {
  const url = storeUrl(env);
  if (url === null) {
    // Unsetting PGOPS_STORE_URL evicts too, or the cached pool's sockets
    // leak.
    retire();
    return null;
  }
  if (HELD.store?.url === url) return HELD.store.pool;
  retire();
  // `pgops-store`, not `pgops`: when PGOPS_STORE_URL points at a database
  // pgops also monitors, the capture's writes appear in that database's own
  // Sessions list, and the name tells them apart.
  // Bounded, because every page awaits the store before it renders and a
  // store that hangs must fall back to memory like one that fails. The
  // migrations and the capture lift both for their own work.
  const pool = new Pool({
    connectionString: url, max: 5, connectionTimeoutMillis: 5_000,
    application_name: `${PGOPS_APP}-store`,
    statement_timeout: STORE_STATEMENT_MS, lock_timeout: STORE_LOCK_MS,
  });
  // Same reasoning as targetFor: an unhandled pool 'error' event terminates
  // the process.
  pool.on('error', () => {});
  markOwnStatements(pool);
  HELD.store = { pool, url };
  return pool;
}

/**
 * Mark everything the store sends with `OWN_SQL_MARKER`, so the `queryStats`
 * check excludes it the way it already excludes every statement `runCheck`
 * issues. The store's statements never pass through `runCheck`, and when
 * `PGOPS_STORE_URL` points at a database pgops also monitors they land in
 * that database's own `pg_stat_statements`.
 */
function markOwnStatements(pool: Pool): void {
  onEveryStatement(pool, (args) => {
    const [first, ...rest] = args;
    if (typeof first === 'string') return [ownSql(first), ...rest];
    // The config-object form. Only `text` changes; `name`, `values` and
    // `rowMode` travel untouched — a named prepared statement whose name
    // moved would stop agreeing with the server's cached plan.
    if (first !== null && typeof first === 'object' && typeof (first as { text?: unknown }).text === 'string') {
      const cfg = first as { text: string };
      return [{ ...cfg, text: ownSql(cfg.text) }, ...rest];
    }
    // A cursor or any other submittable: nothing safe to rewrite, so it goes
    // through unchanged.
    return args;
  });
}

/**
 * Pass every statement any client of `pool` sends through `each`, which
 * returns the arguments to send: to mark the store's statements as pgops's own.
 *
 * The client is the one place to stand, because every statement ends up
 * there: `pool.query` checks a client out itself, through the callback form
 * of `connect`. Wrapping `pool.query` as well sees its statements twice.
 *
 * Each client is wrapped once ever. `pg` hands the same `PoolClient` object
 * back on a later checkout, so wrapping per checkout would nest the wrapper.
 * Call this once per pool, for the same reason.
 */
export function onEveryStatement(pool: Pool, each: (args: unknown[]) => unknown[]): void {
  const SEEN = new WeakSet<PoolClient>();
  const wrapClient = (client: PoolClient): PoolClient => {
    if (SEEN.has(client)) return client;
    SEEN.add(client);
    const inner = client.query.bind(client) as (...a: unknown[]) => unknown;
    client.query = function intercepted(...a: unknown[]) {
      return inner(...each(a));
    } as typeof client.query;
    return client;
  };

  /**
   * Both of `connect`'s forms. The callback form returns undefined, so
   * chaining `.then` on it unconditionally would break every `pool.query`.
   */
  const innerConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  pool.connect = function interceptedConnect(...args: unknown[]) {
    const [first] = args;
    if (typeof first === 'function') {
      const cb = first as (err: unknown, client: PoolClient | undefined, done: unknown) => void;
      // `done` travels through untouched: pg's own Pool.query releases the
      // client with it, and an error arrives with no client to wrap.
      return innerConnect((err: unknown, client: PoolClient | undefined, done: unknown) => {
        cb(err ? plainError(err) : err, client === undefined ? client : wrapClient(client), done);
      }, ...args.slice(1));
    }
    return (innerConnect(...args) as Promise<PoolClient>).then(wrapClient, (err: unknown) => { throw plainError(err); });
  } as typeof pool.connect;
}

/**
 * A connect error as a plain Error with its `code`. Node's happy-eyeballs
 * raises an AggregateError with an empty message when every address of
 * `localhost` refuses, which says nothing in a log, and which React's dev
 * server serialises into a stream the browser cannot finish reading: the
 * page hangs. The code is kept so a refusal still reads as unreachable. An
 * ordinary Error passes as it is, with everything pg put on it.
 */
function plainError(err: unknown): unknown {
  if (err instanceof Error && !(err instanceof AggregateError) && err.message !== '') return err;
  return Object.assign(new Error(messageOf(err)), { code: (err as { code?: unknown } | null)?.code });
}
