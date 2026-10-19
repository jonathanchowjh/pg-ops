import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { activity } from '../src/checks/activity.js';
import { withPostgres } from './harness.js';

describe('activity', () => {
  /**
   * One page render fires about six checks in parallel on separate pool
   * connections, so while any one runs the others are active client backends.
   * Without the filter the panel names pgops's own queries as the busiest shape.
   */
  it('does not count the console itself among active backends', async () => {
    await withPostgres(async (ctx, pool) => {
      const other = await pool.connect();
      try {
        // Both connections share an application_name, as pgops's parallel
        // checks do. Set explicitly so the test does not depend on how the
        // harness configures its pool.
        await ctx.target.query(`SET application_name = 'pgops'`);
        await other.query(`SET application_name = 'pgops'`);
        const sleeping = other.query(`SELECT pg_sleep(2), 1 AS own_probe`);
        await new Promise((r) => setTimeout(r, 300));
        const res = await runCheck(ctx, activity);
        await sleeping;
        if (!res.ok) throw new Error(res.message);
        expect(res.data.shapes.some((s) => s.statement?.includes('own_probe'))).toBe(false);
      } finally {
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
        const sleeping = other.query(`SELECT pg_sleep(2), 1 AS other_probe`);
        await new Promise((r) => setTimeout(r, 300));
        const res = await runCheck(ctx, activity);
        await sleeping;
        if (!res.ok) throw new Error(res.message);
        expect(res.data.active).toBeGreaterThan(0);
        expect(res.data.shapes.some((s) => s.statement?.includes('other_probe'))).toBe(true);
      } finally {
        other.release();
      }
    });
  }, 120_000);

  /**
   * A role without `pg_read_all_stats` gets NULL `state` for a foreign
   * backend, so the `state = 'active'` filter drops it. `restricted` is what
   * stops "could not look" rendering as "nothing is running".
   *
   * Same fixture as horizon.int.test.ts: a monitoring role with no membership
   * in the role it watches, not a superuser, no `pg_read_all_stats`.
   */
  it('MEASURED: restricted is true, and a foreign active backend is invisible, for a role without pg_read_all_stats', async () => {
    await withPostgres(async (ctx, pool) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const holderRole = `h_activity_${suffix}`;
      const restrictedRole = `r_activity_${suffix}`;
      await pool.query(`CREATE ROLE ${holderRole} LOGIN PASSWORD 'holder_pw'`);
      await pool.query(`CREATE ROLE ${restrictedRole} LOGIN PASSWORD 'restricted_pw'`);

      const baseUri = new URL(
        (pool as unknown as { options: { connectionString: string } }).options.connectionString,
      );

      let holderClient: pg.Client | undefined;
      let restrictedPool: pg.Pool | undefined;
      try {
        const holderUri = new URL(baseUri);
        holderUri.username = holderRole;
        holderUri.password = 'holder_pw';
        holderClient = new pg.Client({ connectionString: holderUri.toString() });
        await holderClient.connect();
        await holderClient.query("SET application_name = 'activity_test_holder'");
        // Long enough to still be `active` when the restricted check runs.
        const sleeping = holderClient.query('SELECT pg_sleep(2), 1 AS activity_restricted_probe');
        await new Promise((r) => setTimeout(r, 300));

        const restrictedUri = new URL(baseUri);
        restrictedUri.username = restrictedRole;
        restrictedUri.password = 'restricted_pw';
        restrictedPool = new pg.Pool({ connectionString: restrictedUri.toString(), max: 1 });
        const restrictedCtx = { target: restrictedPool, serverVersion: ctx.serverVersion };
        const res = await runCheck(restrictedCtx, activity);
        await sleeping;
        if (!res.ok) throw new Error(res.message);

        // This role's `pg_has_role(..., 'USAGE')` reads false, so the panel
        // must show the caveat rather than "Nothing is executing right now."
        expect(res.data.restricted).toBe(true);
        // The holder's backend has NULL `state` to this role, so it is
        // counted in neither `active` nor any shape bucket.
        expect(res.data.active).toBe(0);
        expect(res.data.shapes.some((s) => s.statement?.includes('activity_restricted_probe'))).toBe(false);
      } finally {
        if (holderClient) {
          await holderClient.end().catch(() => {});
        }
        if (restrictedPool) {
          await restrictedPool.end().catch(() => {});
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

  it('counts a sleeping backend as active and names its shape', async () => {
    await withPostgres(async (ctx, pool) => {
      const sleeper = pool.query('SELECT pg_sleep(3) AS activity_probe');
      await new Promise((r) => setTimeout(r, 500));
      const res = await runCheck(ctx, activity);
      await sleeper;
      if (!res.ok) throw new Error(res.message);
      expect(res.data.active).toBeGreaterThanOrEqual(1);
      expect(res.data.shapes.some((s) => s.statement?.includes('activity_probe'))).toBe(true);
      // pg_sleep waits on a Timeout event: the bucket exists and is not 'running'.
      expect(res.data.waits.some((w) => w.type === 'Timeout')).toBe(true);

      // `active`, waits and shapes are separate SQL branches, so each equality
      // claims they describe one instant — the reason the CTE is MATERIALIZED.
      expect(res.data.waits.reduce((n, w) => n + w.sessions, 0)).toBe(res.data.active);
      expect(res.data.shapes.reduce((n, s) => n + s.sessions, 0)).toBe(res.data.active);
      expect(res.data.waitsTruncated).toBe(false);
      expect(res.data.shapesTruncated).toBe(false);
    });
  }, 120_000);
});
