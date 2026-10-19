import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { runCheck } from '../src/run.js';
import type { CheckResult } from '../src/types.js';
import { blocked, type BlockedData } from '../src/checks/blocked.js';
import { withPostgres } from './harness.js';

describe('blocked', () => {
  it('reports zero on a quiet database and names the field honestly (A8)', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, blocked);
      if (!r.ok) throw new Error(r.message);
      expect(r.data.count).toBe(0);
      expect(r.data.longestQueryAgeSecs).toBeNull();
      // `blocked` carries a verdict function, so this is never null in practice.
      expect(r.verdict!.level).toBe('ok');
    });
  }, 120_000);

  it('calls pg_blocking_pids once per backend, not twice', () => {
    const text = typeof blocked.sql === 'string' ? blocked.sql : blocked.sql(undefined as never).text;
    expect(text.match(/pg_blocking_pids/g) ?? []).toHaveLength(1);
  });

  /**
   * Returning zero is how this check fails, so the quiet-database test cannot
   * prove it works. `holder` keeps an advisory transaction lock; `waiter`
   * blocks on it. Each client is pushed to `clients` before it connects, so a
   * failure partway through cannot leak an open transaction that would hang
   * the harness's `DROP DATABASE`.
   *
   * `blocked` reports the single longest-blocked session server-wide, and the
   * container is shared with concurrently running files, so a sibling's
   * short-lived block can outrank this one. Polling survives that: this block
   * keeps growing until it is the longest.
   */
  it('finds a genuinely blocked session and names its actual blocker (A8)', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      const clients: pg.Client[] = [];
      try {
        const holder = new pg.Client({ connectionString: uri, application_name: 'blocked-holder' });
        holder.on('error', () => {});
        clients.push(holder);
        await holder.connect();
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(1)');
        const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const holderPid = rows[0]!.pid;

        const waiter = new pg.Client({ connectionString: uri, application_name: 'blocked-waiter' });
        waiter.on('error', () => {});
        clients.push(waiter);
        await waiter.connect();
        void waiter.query('BEGIN').then(() => waiter.query('SELECT pg_advisory_xact_lock(1)')).catch(() => {});

        let found: Extract<CheckResult<BlockedData>, { ok: true }> | undefined;
        for (let i = 0; i < 20 && !found; i += 1) {
          await new Promise((res) => setTimeout(res, 300));
          const attempt = await runCheck(ctx, blocked);
          if (!attempt.ok) throw new Error(attempt.message);
          if (attempt.data.suspectPid === holderPid) found = attempt;
        }

        expect(found, 'blocked should eventually report this fixture as the longest-blocked session').toBeDefined();
        expect(found!.data.count).toBeGreaterThan(0);
        expect(found!.data.suspectPid).toBe(holderPid);
        // `blocked` carries a verdict function, so this is never null in practice.
        expect(found!.verdict!.level).not.toBe('ok');

        /**
         * `waitstart` is briefly NULL for a wait that has only just begun,
         * but this fixture has waited at least one poll interval, so a null
         * here means the subquery is wrong. The strict inequality fails if
         * `longest_wait_secs` is ever aliased to the query-age expression.
         */
        expect(found!.data.longestWaitSecs).not.toBeNull();
        expect(found!.data.longestWaitSecs!).toBeGreaterThan(0);
        expect(found!.data.longestWaitSecs!).toBeLessThan(found!.data.longestQueryAgeSecs!);
      } finally {
        await Promise.all(clients.map((c) => c.end().catch(() => {})));
      }
    });
  }, 120_000);
});
