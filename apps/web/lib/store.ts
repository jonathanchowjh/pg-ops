import { Pool } from 'pg';
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
  STORE = pool;
  STORE_FOR = url;
  return pool;
}
