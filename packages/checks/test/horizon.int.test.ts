import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { horizon } from '../src/checks/horizon.js';
import { withPostgres } from './harness.js';

describe('horizon', () => {
  it('names a backend holding an open snapshot, and does not judge a young one', async () => {
    await withPostgres(async (ctx, pool) => {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await holder.query('SELECT 1');   // takes the snapshot
        const res = await runCheck(ctx, horizon);
        if (!res.ok) throw new Error(res.message);
        const b = res.data.holders.find((h) => h.kind === 'backend');
        expect(b).toBeDefined();
        expect(b!.ageSecs).not.toBeNull();
        // A snapshot one second old on an idle test database pins almost nothing,
        // so `ok` here is the verdict being right, not absent.
        expect(res.data.truncated).toBe(false);
        expect(res.verdict).toEqual({ level: 'ok' });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });
  }, 120_000);

  it('does not name a snapshot held in another database, which cannot hold this one back', async () => {
    await withPostgres(async (ctx, pool) => {
      const url = new URL((pool as unknown as { options: { connectionString: string } }).options.connectionString);
      url.pathname = '/postgres';
      const elsewhere = new pg.Client({ connectionString: url.toString() });
      elsewhere.on('error', () => {});
      try {
        await elsewhere.connect();
        await elsewhere.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await elsewhere.query('SELECT 1');
        const { rows } = await elsewhere.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const res = await runCheck(ctx, horizon);
        if (!res.ok) throw new Error(res.message);
        expect(res.data.holders.map((h) => h.who)).not.toContain(String(rows[0]!.pid));
      } finally {
        await elsewhere.end().catch(() => {});
      }
    });
  }, 120_000);

  /**
   * Locks a measured Postgres behaviour. A role with neither superuser,
   * `pg_read_all_stats` nor membership in the holder's role still sees the
   * holder's `backend_xmin`. It does not see `xact_start`, `state` or
   * `query`, which feed only `ageSecs` and `detail`. So the restriction
   * degrades the display, not the verdict: `xminAge` is intact.
   */
  it('sees a foreign backend_xmin without pg_read_all_stats, though it loses the foreign query text', async () => {
    await withPostgres(async (ctx, pool) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const holderRole = `h_horizon_${suffix}`;
      const restrictedRole = `r_horizon_${suffix}`;
      await pool.query(`CREATE ROLE ${holderRole} LOGIN PASSWORD 'holder_pw'`);
      // No pg_read_all_stats and no membership in holderRole: a monitoring
      // role distinct from the application role it watches.
      await pool.query(`CREATE ROLE ${restrictedRole} LOGIN PASSWORD 'restricted_pw'`);

      const baseUri = new URL(
        (pool as unknown as { options: { connectionString: string } }).options.connectionString,
      );

      let holderClient: pg.Client | undefined;
      try {
        const holderUri = new URL(baseUri);
        holderUri.username = holderRole;
        holderUri.password = 'holder_pw';
        holderClient = new pg.Client({ connectionString: holderUri.toString() });
        await holderClient.connect();
        await holderClient.query("SET application_name = 'horizon_test_holder'");
        await holderClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await holderClient.query('SELECT 1'); // takes the snapshot, sets backend_xmin

        const restrictedUri = new URL(baseUri);
        restrictedUri.username = restrictedRole;
        restrictedUri.password = 'restricted_pw';
        const restrictedPool = new pg.Pool({ connectionString: restrictedUri.toString(), max: 1 });
        try {
          const restrictedCtx = { target: restrictedPool, serverVersion: ctx.serverVersion };
          const res = await runCheck(restrictedCtx, horizon);
          if (!res.ok) throw new Error(res.message);

          const seen = res.data.holders.find((h) => h.detail.includes('horizon_test_holder'));
          // If this starts failing, the check can render a false `ok` for
          // this role; the fix is a `requires: [{kind:'role', ...}]`
          // decision, not loosening this assertion.
          expect(seen).toBeDefined();
          expect(seen!.xminAge).toBeGreaterThanOrEqual(0);
        } finally {
          await restrictedPool.end();
        }
      } finally {
        if (holderClient) {
          await holderClient.query('ROLLBACK').catch(() => {});
          await holderClient.end().catch(() => {});
        }
        // Roles are cluster-wide — a bare DROP ROLE fails on the objects
        // these roles connected under.
        await pool.query(`REVOKE ALL ON SCHEMA public FROM ${holderRole}`).catch(() => {});
        await pool.query(`REVOKE ALL ON SCHEMA public FROM ${restrictedRole}`).catch(() => {});
        await pool.query(`DROP OWNED BY ${holderRole}`).catch(() => {});
        await pool.query(`DROP OWNED BY ${restrictedRole}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${holderRole}`);
        await pool.query(`DROP ROLE IF EXISTS ${restrictedRole}`);
      }
    });
  }, 120_000);

  /**
   * One page render fires about six checks in parallel on separate pool
   * connections, so while any one runs the others are open backends. Without
   * the filter the page names one of pgops's own as pinning the horizon.
   */
  it('does not count the console itself among xmin holders', async () => {
    await withPostgres(async (ctx, pool) => {
      const other = await pool.connect();
      try {
        // Both connections share an application_name, as pgops's parallel
        // checks do.
        await ctx.target.query(`SET application_name = 'pgops'`);
        await other.query(`SET application_name = 'pgops'`);
        await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await other.query('SELECT 1'); // takes the snapshot, sets backend_xmin
        const res = await runCheck(ctx, horizon);
        if (!res.ok) throw new Error(res.message);
        expect(res.data.holders.some((h) => h.detail.startsWith('pgops '))).toBe(false);
      } finally {
        await other.query('ROLLBACK').catch(() => {});
        await other.query(`SET application_name = ''`).catch(() => {});
        other.release();
      }
    });
  }, 120_000);

  /** The guard: an unnamed checking connection must not filter the world away. */
  it('still counts everyone else when it has no name of its own', async () => {
    await withPostgres(async (ctx, pool) => {
      const other = await pool.connect();
      try {
        await ctx.target.query(`SET application_name = ''`);
        await other.query(`SET application_name = 'someone-else'`);
        await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await other.query('SELECT 1');
        const res = await runCheck(ctx, horizon);
        if (!res.ok) throw new Error(res.message);
        expect(res.data.holders.some((h) => h.detail.startsWith('someone-else'))).toBe(true);
      } finally {
        await other.query('ROLLBACK').catch(() => {});
        other.release();
      }
    });
  }, 120_000);
});
