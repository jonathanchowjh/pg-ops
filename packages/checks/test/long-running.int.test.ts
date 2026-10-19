import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { runCheck } from '../src/run.js';
import { longRunning } from '../src/checks/long-running.js';
import { withPostgres } from './harness.js';

describe('longRunning', () => {
  it('returns the longest active queries above its floor', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, longRunning, { minSecs: 0 });
      if (!r.ok) throw new Error(r.message);
      expect(Array.isArray(r.data.queries)).toBe(true);
    });
  }, 120_000);

  /**
   * The test above passes on an empty `pg_stat_activity` whether or not the
   * floor logic is correct. This one starts a real `pg_sleep` without
   * awaiting it, so the connection stays 'active' with a growing query age.
   * `limit` is high because the SQL scans the whole shared server, and
   * unrelated activity on the container could push this fixture's row out.
   */
  it('finds a query that has been running past its floor', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      const sleeper = new pg.Client({ connectionString: uri, application_name: 'long-running-sleeper' });
      sleeper.on('error', () => {});
      try {
        await sleeper.connect();
        const { rows } = await sleeper.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const sleeperPid = rows[0]!.pid;
        const sleep = sleeper.query('SELECT pg_sleep(2)');
        await new Promise((r) => setTimeout(r, 500));

        const r = await runCheck(ctx, longRunning, { minSecs: 0.2, limit: 200 });
        await sleep;
        if (!r.ok) throw new Error(r.message);
        expect(r.data.queries.some((q) => q.pid === sleeperPid)).toBe(true);
      } finally {
        await sleeper.end().catch(() => {});
      }
    });
  }, 120_000);

  /**
   * The PID-reuse guard depends on the `::text` cast round-tripping back to a
   * timestamptz. Dropping the cast would hand node-pg a `Date`, which
   * re-serialises through JSON with millisecond truncation and stops
   * matching the session it identifies.
   */
  it('returns an identity Postgres accepts back as a timestamptz', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      const sleeper = new pg.Client({ connectionString: uri, application_name: 'identity-sleeper' });
      sleeper.on('error', () => {});
      try {
        await sleeper.connect();
        const { rows } = await sleeper.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const sleeperPid = rows[0]!.pid;
        const sleep = sleeper.query('SELECT pg_sleep(2)');
        await new Promise((r) => setTimeout(r, 500));

        const r = await runCheck(ctx, longRunning, { minSecs: 0.2, limit: 200 });
        await sleep;
        if (!r.ok) throw new Error(r.message);
        const mine = r.data.queries.find((q) => q.pid === sleeperPid);
        expect(mine).toBeDefined();
        expect(typeof mine!.backendStart).toBe('string');

        // The comparison killBackend makes, against the same session.
        const check = await pool.query<{ ok: boolean | null }>(
          `SELECT $1::timestamptz = backend_start AS ok
             FROM pg_stat_activity WHERE pid = $2`,
          [mine!.backendStart, sleeperPid]);
        expect(check.rows[0]?.ok).toBe(true);
      } finally {
        await sleeper.end().catch(() => {});
      }
    });
  }, 120_000);

  // Three sleeping backends give pg_stat_activity more 'active' rows than
  // `limit: 1`. Unrelated activity elsewhere on the server can only make
  // truncation more certain.
  it('reports truncation when the limit clips the result (A7)', async () => {
    await withPostgres(async (ctx, pool) => {
      const sleepers = Promise.all([
        pool.query('SELECT pg_sleep(2)'),
        pool.query('SELECT pg_sleep(2)'),
        pool.query('SELECT pg_sleep(2)'),
      ]);
      // Let the sleepers register as 'active' before the check's own query.
      await new Promise((r) => setTimeout(r, 300));

      const result = await runCheck(ctx, longRunning, { minSecs: 0, limit: 1 });
      await sleepers;
      if (!result.ok) throw new Error(result.message);

      expect(result.data.queries.length).toBeLessThanOrEqual(1);
      expect(result.data.truncated).toBe(true);
    });
  }, 120_000);
});
