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
   * The test above proves the SQL runs against a live server; an empty
   * `pg_stat_activity` makes it pass whether or not the WHERE/floor logic
   * is correct. This fixture opens a dedicated connection, reads its own
   * backend pid, then starts a real `pg_sleep` without awaiting it — the
   * connection stays 'active' with a real, growing query age for the
   * duration. `minSecs` is set below the sleep, not the other way around,
   * so the test doesn't need to sleep longer than necessary to clear a
   * fixed threshold. `limit` is set generously high (unlike the default 10)
   * because this SQL, like `blocked`'s, scans the whole shared server, not
   * just this test's own isolated database — see the comment on the
   * `blocked` fixture above for why concurrent sibling test files matter
   * here; a wide `limit` keeps this fixture's own row from being pushed out
   * by unrelated concurrent activity elsewhere on the same container.
   * Against a check that always returned `{ queries: [], truncated: false
   * }`, the final assertion would fail.
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

  // A7: proves the truncation signal is real against Postgres, not just the
  // pure `map` unit test. Three concurrently-sleeping backends (on the
  // pool's own connections) give pg_stat_activity more 'active' rows than
  // `limit: 1`, so a regression to a bare `LIMIT $2` (no truncation signal)
  // would make this pass with `truncated` silently `false`. Same pattern as
  // sessions.int.test.ts's own truncation fixture. Unlike the fixture
  // above, this one is inherently robust to concurrent sibling test files:
  // extra unrelated activity elsewhere can only make truncation MORE
  // certain at `limit: 1`, never less.
  it('reports truncation when the limit clips the result (A7)', async () => {
    await withPostgres(async (ctx, pool) => {
      const sleepers = Promise.all([
        pool.query('SELECT pg_sleep(2)'),
        pool.query('SELECT pg_sleep(2)'),
        pool.query('SELECT pg_sleep(2)'),
      ]);
      // Let the sleeping backends actually register as 'active' before the
      // check's own query (on the pool's 4th connection) runs.
      await new Promise((r) => setTimeout(r, 300));

      const result = await runCheck(ctx, longRunning, { minSecs: 0, limit: 1 });
      await sleepers;
      if (!result.ok) throw new Error(result.message);

      expect(result.data.queries.length).toBeLessThanOrEqual(1);
      expect(result.data.truncated).toBe(true);
    });
  }, 120_000);
});
