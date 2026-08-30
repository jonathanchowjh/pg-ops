import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { killBackend } from '../src/actions/kill.js';
import { defaultAuditPath } from '../src/actions/audit.js';
import { withPostgres } from './harness.js';

/**
 * I4. Every test below performs a real kill, and `killBackend` always
 * audits. Before `vitest.config.ts` set `PGOPS_AUDIT_LOG` for this project,
 * those records went to `~/.pgops/audit.log` — the developer's own file,
 * which audit.ts's header calls "the mitigation for the malicious operator
 * threat". A record written from here is byte-for-byte what a genuine kill
 * writes: real pid, real backend_start, real `user@host`, `result:
 * "terminated"`. Anyone auditing that file after an incident would be
 * reading fabricated entries alongside real ones.
 *
 * This asserts the RESOLVED path, not merely that the env var is set, and
 * it lives in this file rather than in a config test because it must run
 * under the same environment the kills do.
 */
describe('the integration suite\'s audit destination (I4)', () => {
  it('never resolves into the real home directory', () => {
    const path = resolve(defaultAuditPath());
    expect(process.env.PGOPS_AUDIT_LOG, 'vitest.config.ts must set this for the integration project').toBeTruthy();
    expect(path.startsWith(resolve(homedir()) + '/'), `audit records would land in ${path}`).toBe(false);
  });
});

describe('killBackend', () => {
  it('terminates a session whose identity still matches', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      const victim = new pg.Client({ connectionString: uri, application_name: 'victim' });
      victim.on('error', () => {});
      try {
        await victim.connect();
        const { rows } = await victim.query<{ pid: number; bs: string }>(
          'SELECT pg_backend_pid() AS pid, backend_start::text AS bs FROM pg_stat_activity WHERE pid = pg_backend_pid()',
        );
        const row = rows[0];
        if (!row) throw new Error('expected the victim backend to see its own pg_stat_activity row');
        const out = await killBackend(ctx,
          { pid: row.pid, backendStart: row.bs },
          { subcommand: 'sessions', reason: 'test' });
        expect(out).toBe('terminated');
      } finally {
        // Fixture hygiene: the victim client is acquired and torn down
        // entirely within this try/finally, independent of whatever the
        // assertions above did or didn't do — a thrown assertion must not
        // leak a connection into the container the rest of the serial
        // integration run shares (this file's own note on "must not break
        // your own teardown", and the plan's repeated fixture-leak defect).
        await victim.end().catch(() => {});
      }
    });
  }, 120_000);

  it('refuses when the pid has been reused by a different session', async () => {
    await withPostgres(async (ctx, pool) => {
      const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const row = rows[0];
      if (!row) throw new Error('expected the pool to see its own backend pid');
      const out = await killBackend(ctx,
        { pid: row.pid, backendStart: '1999-01-01T00:00:00Z' },
        { subcommand: 'sessions', reason: 'test' });
      expect(out).toBe('session-changed');
    });
  }, 120_000);

  it('reports gone for a pid that is not present', async () => {
    await withPostgres(async (ctx) => {
      const out = await killBackend(ctx,
        { pid: 999_999, backendStart: '2026-01-01T00:00:00Z' },
        { subcommand: 'sessions', reason: 'test' });
      expect(out).toBe('gone');
    });
  }, 120_000);

  /**
   * Controller Ruling 38: `blocked`'s `suspectPid` comes from
   * `pg_blocking_pids()`, which returns whoever holds the lock — autovacuum
   * workers included — and the check deliberately keeps reporting that (an
   * operator needs to SEE that autovacuum is the blocker). The guard belongs
   * here, at the point of the terminate, not at the check.
   *
   * This proves two things a string-matching test on the SQL text cannot:
   * (1) killBackend genuinely refuses a non-client backend even when its
   * `backend_start` identity is a perfect match, and (2) the guard actually
   * prevented the signal — not just that the RETURN VALUE happened to read
   * 'session-changed'. A regression that dropped `backend_type = 'client
   * backend'` from the CASE guard (leaving only the backend_start check)
   * would terminate this backend and fail the second assertion; a regression
   * that returned 'session-changed' unconditionally would fail the first two
   * tests above instead. Together they pin the guard to the one place
   * Ruling 38 requires it: inside the single guarded statement.
   *
   * Every default Postgres cluster runs at least one non-client backend
   * continuously (autovacuum launcher, checkpointer, background writer,
   * walwriter) — this does not depend on a specific one being present.
   */
  it('refuses to terminate a non-client backend even when its identity matches (Ruling 38)', async () => {
    await withPostgres(async (ctx) => {
      const { rows } = await ctx.target.query<{ pid: number; backend_start: string; backend_type: string }>(
        `SELECT pid, backend_start::text AS backend_start, backend_type
         FROM pg_stat_activity WHERE backend_type <> 'client backend' LIMIT 1`,
      );
      const target = rows[0];
      if (!target) {
        throw new Error('expected at least one non-client backend (autovacuum launcher, checkpointer, ...) '
          + 'to be running against a default Postgres cluster');
      }

      const out = await killBackend(ctx,
        { pid: target.pid, backendStart: target.backend_start },
        { subcommand: 'sessions', reason: 'test' });

      expect(out).toBe('session-changed');

      // Prove the guard actually blocked the signal, not just that the
      // label reads right: the backend must still be present, unchanged.
      const after = await ctx.target.query<{ backend_start: string }>(
        'SELECT backend_start::text AS backend_start FROM pg_stat_activity WHERE pid = $1',
        [target.pid],
      );
      expect(after.rows[0]?.backend_start).toBe(target.backend_start);
    });
  }, 120_000);
});
