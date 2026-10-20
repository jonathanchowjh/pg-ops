import type { Pool, PoolClient } from 'pg';
import { guardClient, messageOf } from '../run.js';
import type { CheckContext, FailureReason } from '../types.js';
import { CAPTURE_LOCK_NS, upsertDatabase } from './write.js';

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

type CaptureFailure = { ok: false; reason: FailureReason; message: string };
type CaptureSkip = { ok: 'skipped'; reason: 'locked' };

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
