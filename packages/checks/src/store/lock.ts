import type { Pool } from 'pg';
import { guardClient } from '../run.js';

/**
 * A fixed key for the migration lock. Arbitrary, but it must never change:
 * two pgops versions racing to migrate the same store have to contend on the
 * same key or the lock does nothing.
 */
export const MIGRATION_LOCK_KEY = 4021975;

/**
 * Namespace for per-database capture locks, used with the two-int form
 * `pg_try_advisory_lock(ns, database_id)` so a capture lock can never collide
 * with the single-int migration lock above.
 */
export const CAPTURE_LOCK_NS = 4021976;

/**
 * Namespace for the per-database health lock. Separate from the capture
 * lock on purpose: the five-minute capture can hold its lock for a long time
 * on a database with many relations, and a health tick that shared it would
 * skip every minute the capture ran — a gap in the chart caused by pgops.
 */
export const HEALTH_LOCK_NS = 4021977;

/**
 * Run `fn` holding a session-level advisory lock, on one dedicated client.
 *
 * The lock must be taken and released on the SAME connection — advisory locks
 * are session-scoped — which is why this checks a client out rather than
 * querying the pool. `finally` releases it even when `fn` throws; without
 * that, one failed migration would block every replica from ever migrating
 * again until the process died.
 */
export async function withAdvisoryLock<T>(
  pool: Pool,
  key: number,
  fn: (client: import('pg').PoolClient) => Promise<T> | T,
): Promise<T> {
  const client = await pool.connect();
  // A checked-out pg client has no 'error' listener of its own, and an
  // 'error' event without one is fatal to the process — see guardClient in
  // run.ts. This client is held for the whole of `fn`, which for the
  // migration lock means every migration in the list: the longest checkout
  // in the package, taken at boot, against a store that may still be coming
  // up. A store that drops the connection mid-migration must fail the
  // migration (which `startScheduler` already swallows into "history is
  // disabled for this process"), not kill the console.
  const release = guardClient(client);
  try {
    await client.query('SELECT pg_advisory_lock($1)', [key]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
    }
  } finally {
    release();
  }
}

/**
 * Try to take a per-database capture lock. Returns false immediately when
 * another replica holds it, rather than waiting.
 *
 * Waiting would be wrong: a tick that queues behind another replica's tick
 * runs a capture nobody needs, against a database pgops is meant to leave
 * alone. Skipping is the same rule usePoll applies to the browser — a tick
 * that lands while one is in flight is skipped, not queued.
 */
export async function tryCaptureLock(
  client: import('pg').PoolClient,
  databaseId: number,
  ns: number = CAPTURE_LOCK_NS,
): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1, $2) AS locked',
    [ns, databaseId],
  );
  return rows[0]!.locked;
}

export async function releaseCaptureLock(
  client: import('pg').PoolClient,
  databaseId: number,
  ns: number = CAPTURE_LOCK_NS,
): Promise<void> {
  await client
    .query('SELECT pg_advisory_unlock($1, $2)', [ns, databaseId])
    .catch(() => {});
}
