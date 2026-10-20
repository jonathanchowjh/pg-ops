import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import type { Check } from '../src/types.js';
import { withPostgres } from './harness.js';

const { Pool } = pg;

const slow: Check<{ ok: number }, number> = {
  id: 'slow', home: 'database', title: 'Slow', class: 'captured',
  timeoutMs: 250,
  sql: 'SELECT 1 AS ok FROM pg_sleep(3)',
  map: (rows) => rows.length,
};

const fast: Check<{ ok: number }, number> = {
  id: 'fast', home: 'database', title: 'Fast', class: 'captured',
  timeoutMs: 5_000,
  sql: 'SELECT 1 AS ok',
  map: (rows) => rows.length,
};

describe('timeoutMs', () => {
  it('turns a query that outruns it into a failed check, not a hung render', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, slow);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('error');
      expect(result.message).toMatch(/statement timeout/i);
    });
  });

  it('leaves a query that finishes inside it alone', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, fast);
      expect(result.ok && result.data).toBe(1);
    });
  });

  it('does not leak the timeout onto the next query on the same pooled connection', async () => {
    await withPostgres(async (ctx) => {
      // `fast`, not `slow`: a bare `SET` inside a transaction that rolls back
      // is undone just like `SET LOCAL`, and `slow` always times out and
      // rolls back. The leak path is the COMMIT after a check that finishes
      // on time.
      await runCheck(ctx, fast);
      // A plain `SET` would leave 5000ms on the pooled connection and kill
      // whichever check drew it next.
      //
      // Every call here is sequential and pg-pool prefers an idle connection,
      // so the query below draws the same physical connection `fast` just
      // committed on.
      const { rows } = await ctx.target.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t");
      expect(rows[0]!.t).toBe('0');
    });
  });

  it('survives its connection dying mid-query: no crash, no poisoned pool', async () => {
    await withPostgres(async (ctx) => {
      // `admin` is a second connection used only to kill the backend running
      // the check, simulating a connection that drops mid-transaction.
      //
      // pg's `Client` emits an 'error' event on itself when the connection
      // drops, separately from rejecting the in-flight query, and that is
      // fatal to the process if nothing is listening. Only a real dropped
      // connection exercises that path. The `release(err)` argument is
      // pinned in run.test.ts, because pg-pool evicts a really dead socket
      // whatever `release()` is given.
      const admin = new Pool({ connectionString: ctx.target.options.connectionString, max: 1 });
      try {
        const marker = 'timeout-kill-marker';
        const doomed: Check<{ ok: number }, number> = {
          id: 'doomed', home: 'database', title: 'Doomed', class: 'captured',
          // Generous: a short timeout would race the kill below.
          timeoutMs: 30_000,
          sql: `SELECT 1 AS ok FROM pg_sleep(5) /* ${marker} */`,
          map: (rows) => rows.length,
        };

        const runPromise = runCheck(ctx, doomed);

        // Poll pg_stat_activity for the marker query; a fixed sleep would race.
        let pid: number | undefined;
        for (let i = 0; i < 100 && pid === undefined; i++) {
          const { rows } = await admin.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE query LIKE $1 AND state = 'active'",
            [`%${marker}%`],
          );
          pid = rows[0]?.pid;
          if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(pid).toBeDefined();
        await admin.query('SELECT pg_terminate_backend($1)', [pid]);

        // No crash: an unhandled 'error' event would kill the process before
        // this resolves.
        const result = await runPromise;
        expect(result.ok).toBe(false);

        // No poisoned pool: a fresh query succeeds rather than failing with
        // "current transaction is aborted".
        const follow = await ctx.target.query<{ ok: number }>('SELECT 1 AS ok');
        expect(follow.rows[0]!.ok).toBe(1);
      } finally {
        await admin.end().catch(() => {});
      }
    });
  });
});
