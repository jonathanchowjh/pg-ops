import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { killBackend, killLongRunning } from '../src/actions.js';
import { defaultAuditPath } from '../src/audit.js';
import { withPostgres } from './harness.js';

/**
 * Every test below performs a real kill, and `killBackend` always audits.
 * Without `PGOPS_AUDIT_LOG` those records would land in the developer's own
 * `~/.pgops/audit.log`, indistinguishable from genuine kills. This asserts the
 * resolved path, and lives here so it runs under the same environment as the
 * kills.
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
        // A thrown assertion must not leak a connection into the container
        // the rest of the serial integration run shares.
        await victim.end().catch(() => {});
      }
    });
  }, 120_000);

  it('refuses a session of another database, and it lives', async () => {
    await withPostgres(async (ctx, pool) => {
      const url = new URL((pool as unknown as { options: { connectionString: string } }).options.connectionString);
      url.pathname = '/postgres';
      const elsewhere = new pg.Client({ connectionString: url.toString(), application_name: 'elsewhere' });
      elsewhere.on('error', () => {});
      try {
        await elsewhere.connect();
        const { rows } = await elsewhere.query<{ pid: number; bs: string }>(
          'SELECT pg_backend_pid() AS pid, backend_start::text AS bs FROM pg_stat_activity WHERE pid = pg_backend_pid()',
        );
        const out = await killBackend(ctx, { pid: rows[0]!.pid, backendStart: rows[0]!.bs }, { subcommand: 'sessions', reason: 'test' });
        expect(out).toBe('session-changed');
        expect((await elsewhere.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one).toBe(1);
      } finally {
        await elsewhere.end().catch(() => {});
      }
    });
  }, 120_000);

  it("refuses one of pgops's own connections, and it lives", async () => {
    await withPostgres(async (ctx, pool) => {
      const own = new pg.Client({ connectionString: (pool as unknown as { options: { connectionString: string } }).options.connectionString, application_name: 'pgops-store' });
      own.on('error', () => {});
      try {
        await own.connect();
        const { rows } = await own.query<{ pid: number; bs: string }>(
          'SELECT pg_backend_pid() AS pid, backend_start::text AS bs FROM pg_stat_activity WHERE pid = pg_backend_pid()',
        );
        const out = await killBackend(ctx, { pid: rows[0]!.pid, backendStart: rows[0]!.bs }, { subcommand: 'sessions', reason: 'test' });
        expect(out).toBe('session-changed');
        expect((await own.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one).toBe(1);
      } finally {
        await own.end().catch(() => {});
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
   * `pg_blocking_pids()` can name an autovacuum worker as the blocker, and the
   * check keeps reporting it, so the guard belongs at the terminate. Dropping
   * `backend_type = 'client backend'` from the guard would terminate this
   * backend and fail the second assertion.
   *
   * Every default cluster runs at least one non-client backend, so this does
   * not depend on a specific one being present.
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

      // The guard blocked the signal: the backend is still present, unchanged.
      const after = await ctx.target.query<{ backend_start: string }>(
        'SELECT backend_start::text AS backend_start FROM pg_stat_activity WHERE pid = $1',
        [target.pid],
      );
      expect(after.rows[0]?.backend_start).toBe(target.backend_start);
    });
  }, 120_000);
});

/**
 * A victim is a dedicated pg.Client, never a pooled connection: terminating a
 * client the pool still believes it owns leaves the pool handing out a dead
 * socket.
 */
describe('killLongRunning', () => {
  const victim = async (pool: unknown, name: string) => {
    const uri = (pool as { options: { connectionString: string } }).options.connectionString;
    const client = new pg.Client({ connectionString: uri, application_name: name });
    client.on('error', () => {});
    await client.connect();
    const { rows } = await client.query<{ pid: number; bs: string }>(
      'SELECT pg_backend_pid() AS pid, backend_start::text AS bs'
      + ' FROM pg_stat_activity WHERE pid = pg_backend_pid()');
    const row = rows[0];
    if (!row) throw new Error('expected the victim backend to see its own row');
    return { client, target: { pid: row.pid, backendStart: row.bs } };
  };

  it('kills every target and reports each one separately', async () => {
    await withPostgres(async (ctx, pool) => {
      const a = await victim(pool, 'bulk-a');
      const b = await victim(pool, 'bulk-b');
      try {
        const results = await killLongRunning(ctx, [a.target, b.target],
          { subcommand: 'test', reason: 'both of them' });

        expect(results.map((r) => r.outcome)).toEqual(['terminated', 'terminated']);
        // Per-target pids, in the order asked, so the operator can tell which
        // session was which.
        expect(results.map((r) => r.pid)).toEqual([a.target.pid, b.target.pid]);
      } finally {
        await a.client.end().catch(() => {});
        await b.client.end().catch(() => {});
      }
    });
  }, 120_000);

  /** Every target keeps its own guard: a stale identity is refused on its own row while its neighbours proceed. */
  it('refuses a target whose identity no longer matches, without touching the others', async () => {
    await withPostgres(async (ctx, pool) => {
      const live = await victim(pool, 'bulk-live');
      try {
        const stale = { pid: live.target.pid, backendStart: '2000-01-01 00:00:00+00' };

        const results = await killLongRunning(ctx, [stale, live.target],
          { subcommand: 'test', reason: 'one stale, one real' });

        expect(results[0]!.outcome).toBe('session-changed');
        expect(results[1]!.outcome).toBe('terminated');
      } finally {
        await live.client.end().catch(() => {});
      }
    });
  }, 120_000);

  it('returns no results for no targets, rather than failing', async () => {
    await withPostgres(async (ctx) => {
      expect(await killLongRunning(ctx, [], { subcommand: 'test', reason: 'none' }))
        .toEqual([]);
    });
  }, 120_000);

  /**
   * killBackend rethrows on a database error. A bulk kill that let that escape
   * would abandon every remaining target and leave the operator unable to say
   * which sessions had been touched. The seam is a ctx whose target.query
   * rejects.
   */
  it('records a failure on its own row and keeps going', async () => {
    await withPostgres(async (ctx) => {
      const failing = {
        ...ctx,
        target: {
          ...ctx.target,
          query: async () => { throw new Error('permission denied for function pg_terminate_backend'); },
        },
      } as unknown as typeof ctx;

      const results = await killLongRunning(failing,
        [{ pid: 1, backendStart: null }, { pid: 2, backendStart: null }],
        { subcommand: 'test', reason: 'both will fail' });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.pid)).toEqual([1, 2]);
      for (const r of results) {
        expect(r.error).toMatch(/permission denied/);
        // `gone` because nothing was observed to die; `error` is what stops
        // that reading as "it had already finished".
        expect(r.outcome).toBe('gone');
      }
    });
  }, 120_000);
});
