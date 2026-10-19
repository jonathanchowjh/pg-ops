import type { Pool, PoolClient } from 'pg';
import { guardClient, messageOf } from '../run.js';
import type { CheckContext, FailureReason } from '../types.js';
import { upsertDatabase } from './write.js';

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
 * Namespace for the per-database sample lock, taken for one transaction:
 * two writers of one database's adjacent buckets each recompute the minute
 * from what the other has committed, never from a snapshot that misses it.
 */
export const SAMPLE_LOCK_NS = 4021978;

/**
 * Namespace for the per-database health lock. Separate from the capture
 * lock: the five-minute capture can hold its lock for a long time, and a
 * health tick that shared it would skip every minute the capture ran.
 */
export const HEALTH_LOCK_NS = 4021977;

/**
 * Run `fn` holding a session-level advisory lock, on one dedicated client.
 *
 * Advisory locks are session-scoped, so the lock is taken and released on
 * the same checked-out connection. It is released even when `fn` throws.
 */
export async function withAdvisoryLock<T>(
  pool: Pool,
  key: number,
  fn: (client: PoolClient) => Promise<T> | T,
): Promise<T> {
  const client = await pool.connect();
  // Held for the whole of `fn`; a dropped connection must fail `fn`, not
  // kill the process. See guardClient in run.ts.
  const release = guardClient(client);
  try {
    // Waiting here is the point, and a migration may run long: the pool's
    // bounds are for a page's reads. Set back before the client goes back.
    await client.query('SET statement_timeout = 0');
    await client.query('SET lock_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [key]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
    }
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
    await client.query('RESET lock_timeout').catch(() => {});
    release();
  }
}

/** False immediately when another session holds this database's lock in `ns`; never waits. */
export async function tryCaptureLock(
  client: PoolClient,
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
  client: PoolClient,
  databaseId: number,
  ns: number = CAPTURE_LOCK_NS,
): Promise<void> {
  await client
    .query('SELECT pg_advisory_unlock($1, $2)', [ns, databaseId])
    .catch(() => {});
}

export type CaptureFailure = { ok: false; reason: FailureReason; message: string };
export type CaptureSkip = { ok: 'skipped'; reason: 'locked' };

/**
 * The shell every capture shares: one store client, this database's id, and
 * its advisory lock held for the length of `work`.
 *
 * Never rejects, because captures run on a timer, where an unhandled
 * rejection terminates the web process. No store, a store that cannot be
 * reached and anything `work` throws all come back as a failure.
 *
 * Skipped, never queued, when another replica holds the lock: a queued tick
 * would run a capture nobody needs. The lock is released only when it was
 * taken; unlocking one this session does not own makes Postgres log a
 * warning in the store on every skipped tick.
 *
 * `recording` finishes the sentence an operator reads when there is no store.
 */
export async function withCaptureLock<T>(
  ctx: CheckContext,
  name: string,
  opts: { recording: string; ns?: number },
  work: (client: PoolClient, databaseId: number) => Promise<T>,
): Promise<T | CaptureFailure | CaptureSkip> {
  if (!ctx.store) {
    return {
      ok: false,
      reason: 'missing-store',
      message: `No store configured; set PGOPS_STORE_URL to record ${opts.recording}.`,
    };
  }
  const ns = opts.ns ?? CAPTURE_LOCK_NS;
  let client;
  let release;
  try {
    client = await ctx.store.connect();
    release = guardClient(client);
  } catch (err) {
    return { ok: false, reason: 'unreachable', message: messageOf(err) };
  }
  let lockedId: number | null = null;
  try {
    const databaseId = await upsertDatabase(client, name);
    if (!(await tryCaptureLock(client, databaseId, ns))) return { ok: 'skipped', reason: 'locked' };
    lockedId = databaseId;
    return await work(client, databaseId);
  } catch (err) {
    return { ok: false, reason: 'error', message: messageOf(err) };
  } finally {
    if (lockedId !== null) await releaseCaptureLock(client, lockedId, ns);
    release();
  }
}
