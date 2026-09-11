import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import type { Check } from '../src/types.js';
import { withPostgres } from './harness.js';

const { Pool } = pg;

const slow: Check<{ ok: number }, number> = {
  id: 'slow', gate: 'work', title: 'Slow', class: 'hygiene',
  timeoutMs: 250,
  sql: 'SELECT 1 AS ok FROM pg_sleep(3)',
  map: (rows) => rows.length,
};

const fast: Check<{ ok: number }, number> = {
  id: 'fast', gate: 'work', title: 'Fast', class: 'hygiene',
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
      // `fast`, not `slow`: Postgres treats parameter-setting as transactional
      // for BOTH forms — a bare `SET` inside a transaction that ROLLBACKs is
      // undone right along with `SET LOCAL`, exactly as if it had never run.
      // `slow` always hits the timeout, so its transaction always aborts and
      // rolls back; running it here would leave this test unable to tell
      // `SET LOCAL` apart from a bare `SET` no matter how many connections it
      // checks — confirmed against a bare `SET`, see task-2-report.md. The
      // real leak path is the COMMIT that follows a check finishing on time,
      // which is what a bare `SET` would carry past `client.release()`.
      await runCheck(ctx, fast);
      // SET LOCAL is transaction-scoped, so the pooled connection this
      // returns to the pool must carry no statement_timeout at all. A plain
      // `SET` here would leave 5000ms on that connection and randomly kill
      // whichever incident check drew it next.
      //
      // Why a single follow-up query here is a real test of the leak, not a
      // coin flip: `withPostgres` (harness.ts) hands `fn` a pool that already
      // has exactly one idle connection (its own setup queries opened and
      // returned it), and every call in this test is sequential and awaited
      // — nothing here ever asks pg-pool for a second connection while the
      // first is checked out. pg-pool always prefers an idle connection over
      // opening a new one, so the query below necessarily draws the SAME
      // physical connection `fast` just committed on. That is exactly where
      // a bare `SET` would have survived.
      //
      // `current_setting(..) AS t`, not `SHOW statement_timeout`: SHOW's
      // result column is named after the GUC itself (`statement_timeout`),
      // not `t` — aliasing here is what makes `rows[0].t` correct instead of
      // `undefined`.
      const { rows } = await ctx.target.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t");
      expect(rows[0]!.t).toBe('0');
    });
  });

  it('survives its connection dying mid-query: no crash, no poisoned pool', async () => {
    await withPostgres(async (ctx) => {
      // A second, independent connection used only to find and kill the
      // backend `queryWithTimeout` is using once it is actually running —
      // simulating a connection that drops mid-transaction (a DB restart, a
      // network blip), which is what forces ROLLBACK itself to fail inside
      // queryWithTimeout's catch branch.
      //
      // What this test can and cannot pin: once a real connection's socket
      // actually dies, node-postgres marks the Client `_queryable = false`,
      // and pg-pool's own `_release` evicts a non-queryable client from the
      // pool regardless of the argument our code passes to `release()` — so
      // a live "does the broken connection get destroyed" assertion here
      // would pass even against the pre-fix bug (bare `release()`, no err),
      // and would not be evidence for that fix. That fix is pinned instead
      // by run.test.ts's `queryWithTimeout: pool hygiene when ROLLBACK
      // itself fails` tests, which fake a client whose ROLLBACK rejects
      // while everything else about it still looks healthy — the one case
      // pg-pool's own dead-socket handling can't paper over.
      //
      // What THIS test is for: pg's `Client` is an EventEmitter, and it
      // emits a low-level 'error' event on itself when the connection drops
      // — separately from rejecting the in-flight query — which is fatal to
      // the whole Node process if nothing is listening. Only a real dropped
      // connection exercises that path, which is why this stays a live,
      // Docker-backed integration test rather than a fake.
      const admin = new Pool({ connectionString: ctx.target.options.connectionString, max: 1 });
      try {
        const marker = 'timeout-kill-marker';
        const doomed: Check<{ ok: number }, number> = {
          id: 'doomed', gate: 'work', title: 'Doomed', class: 'hygiene',
          // Generous on purpose: this test is not exercising statement_timeout
          // firing, it is exercising the connection dying out from under the
          // query. A short timeout here would race the kill below.
          timeoutMs: 30_000,
          sql: `SELECT 1 AS ok FROM pg_sleep(5) /* ${marker} */`,
          map: (rows) => rows.length,
        };

        const runPromise = runCheck(ctx, doomed);

        // Poll pg_stat_activity for the marker query rather than guessing a
        // wall-clock delay: `doomed`'s BEGIN/SET LOCAL/query dispatch has no
        // externally observable signal other than the query itself becoming
        // active, so a fixed sleep here would be a race, not a wait.
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

        // No crash: if the client's 'error' event went unhandled, this
        // `await` itself would never resolve — the process would die first.
        const result = await runPromise;
        expect(result.ok).toBe(false);

        // No poisoned pool: a fresh query still succeeds cleanly afterward,
        // rather than failing with "current transaction is aborted, commands
        // ignored until end of transaction block".
        const follow = await ctx.target.query<{ ok: number }>('SELECT 1 AS ok');
        expect(follow.rows[0]!.ok).toBe(1);
      } finally {
        await admin.end().catch(() => {});
      }
    });
  });
});
