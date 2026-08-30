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
      expect(r.verdict.level).toBe('ok');
    });
  }, 120_000);

  it('calls pg_blocking_pids once per backend, not twice', () => {
    const text = typeof blocked.sql === 'string' ? blocked.sql : blocked.sql(undefined as never).text;
    expect(text.match(/pg_blocking_pids/g) ?? []).toHaveLength(1);
  });

  /**
   * The quiet-database test above proves the SQL parses and returns a
   * shape; it cannot distinguish a working check from one that
   * unconditionally returns `{ count: 0, longestQueryAgeSecs: null,
   * suspectPid: null }` — returning zero is exactly how this check fails.
   * This fixture makes a genuine block: `holder` takes an advisory
   * transaction lock and keeps it open; `waiter` then blocks trying to
   * take the same one. Same shape as locks.int.test.ts's own `holder`
   * fixture, including its cleanup discipline: each client is pushed to
   * `clients` at the moment it is created, before `connect()`/`BEGIN`/the
   * lock query — any of which can throw — so a failure partway through
   * still gets that client torn down instead of leaking an open
   * transaction that would hang the harness's `DROP DATABASE`.
   *
   * `blocked`'s SQL aggregates across the WHOLE server, by design — it
   * reports the single LONGEST-blocked session, not a per-database list
   * (see BlockedData's own doc comment). The one Postgres container
   * `global-setup.ts` starts is shared by every integration file in this
   * `vitest run`, and Vitest runs test files concurrently by default, so a
   * short-lived blocking fixture in a sibling file (e.g. locks.int.test.ts)
   * can transiently outrank this one and get reported as `suspectPid`
   * instead. Polling instead of sampling once survives that: this
   * fixture's own block keeps growing for as long as `holder`'s
   * transaction stays open, so it eventually becomes the longest-blocked
   * session server-wide once any such short-lived contender releases.
   * Against a check that always reported zero, the loop would exhaust and
   * `found` would stay `undefined` — the assertion below is what would fail.
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
        expect(found!.verdict.level).not.toBe('ok');
      } finally {
        await Promise.all(clients.map((c) => c.end().catch(() => {})));
      }
    });
  }, 120_000);
});
