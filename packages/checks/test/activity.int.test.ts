import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { activity } from '../src/checks/activity.js';
import { withPostgres } from './harness.js';

describe('activity', () => {
  /**
   * STEP 3B — MEASURED, NOT ASSUMED. See horizon.int.test.ts's version of
   * this pair and the task report for the reproduction: driving the console
   * at 390px against a live database showed this panel naming pgops's own
   * connection-sources query as its own busiest active statement shape,
   * because one page render fires about six checks in parallel on separate
   * pool connections — at the instant any one runs, the other five are
   * themselves active client backends. No mocked fixture can catch this: it
   * only exists when a real page render races real pool queries.
   */
  it('does not count the console itself among active backends', async () => {
    await withPostgres(async (ctx, pool) => {
      const other = await pool.connect();
      try {
        // Both connections wear the same application_name, which is what
        // pgops's own parallel check traffic looks like: six checks, six
        // connections, one page render. Set explicitly rather than read from
        // the environment so the test does not depend on how the harness
        // happens to configure its pool.
        await ctx.target.query(`SET application_name = 'pgops-probe'`);
        await other.query(`SET application_name = 'pgops-probe'`);
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
   * FIX 1 — THE DEFECT THIS BRANCH WAS HELD FOR. MEASURED, NOT ASSUMED.
   *
   * horizon.int.test.ts:44 already measured that a role without
   * `pg_read_all_stats` gets NULL `state` for a foreign backend. This check's
   * `act` CTE filters `WHERE state = 'active'`, and `NULL = 'active'` is
   * NULL, not true, so a foreign active backend should disappear from this
   * check's count entirely for such a role — the exact "we could not look"
   * rendering as "we looked and it is fine" the branch was held over.
   *
   * A role with no membership relationship to the holder role, matching
   * horizon's fixture exactly: a monitoring role distinct from the
   * application role it watches, not a superuser and not granted
   * `pg_read_all_stats`.
   */
  it('MEASURED: restricted is true, and a foreign active backend is invisible, for a role without pg_read_all_stats', async () => {
    await withPostgres(async (ctx, pool) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const holderRole = `h_activity_${suffix}`;
      const restrictedRole = `r_activity_${suffix}`;
      await pool.query(`CREATE ROLE ${holderRole} LOGIN PASSWORD 'holder_pw'`);
      // No GRANT of pg_read_all_stats and no membership relationship to
      // holderRole — see horizon.int.test.ts's identical fixture shape.
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
        // A long-running statement so it is still `active` when the
        // restricted role's check runs its snapshot.
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

        // MEASURED: this role's own `pg_has_role(..., 'USAGE')` reads false,
        // so `restricted` is true — the panel must show the caveat rather
        // than "Nothing is executing right now."
        expect(res.data.restricted).toBe(true);
        // MEASURED: the holder's backend has NULL `state` to this role (the
        // horizon.int.test.ts finding), so `act`'s `state = 'active'` filter
        // drops it — it is counted in NEITHER `active` NOR any shape bucket.
        // This is the ambiguous zero Fix 1 exists to stop mislabelling: the
        // check cannot see this backend at all, not "it saw nothing running".
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

      // NOT `waits.reduce() === active` as the first draft had it: `map` defined
      // `active` AS that reduction, so the assertion compared a value with
      // itself and could not fail. All three are separate SQL branches now, so
      // each equality is a real claim that they describe one instant — which is
      // the whole reason the CTE is MATERIALIZED, and was untested.
      expect(res.data.waits.reduce((n, w) => n + w.sessions, 0)).toBe(res.data.active);
      expect(res.data.shapes.reduce((n, s) => n + s.sessions, 0)).toBe(res.data.active);
      expect(res.data.waitsTruncated).toBe(false);
      expect(res.data.shapesTruncated).toBe(false);
    });
  }, 120_000);
});
