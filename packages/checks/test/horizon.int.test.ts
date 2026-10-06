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
        // so `ok` here is the verdict being RIGHT, not the verdict being absent.
        expect(res.data.truncated).toBe(false);
        expect(res.verdict).toEqual({ level: 'ok' });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });
  }, 120_000);

  /**
   * STEP 3B — MEASURED, NOT ASSUMED.
   *
   * `pg_stat_activity` hides some columns of another role's backend from a
   * role lacking `pg_read_all_stats` — `query` and `query_id` are the
   * documented ones. Whether `backend_xmin` is ALSO one of them decides
   * whether this check can render `ok` on a database where a real holder is
   * invisible to it, which is exactly the Stage 1 Sessions defect in a new
   * place: "we could not fully look" rendering as "it is fine".
   *
   * MEASURED against a real PostgreSQL 17 container (see this task's report
   * for the manual reproduction this test formalises): a role with neither
   * superuser, `pg_read_all_stats`, nor any relation to the holder role
   * still sees the holder's `backend_xmin` and can compute `age(backend_xmin)`
   * from it. What that role does NOT see is `xact_start`, `state` and `query`
   * for the foreign backend — they come back NULL / `<insufficient
   * privilege>`. Those three feed only `ageSecs` and `detail` (informational
   * — the verdict is documented above to never depend on them), so the
   * restriction degrades the DISPLAY, not the JUDGMENT: `xminAge` is intact,
   * and the verdict this check computes from it is the correct one, not a
   * false `ok`.
   *
   * This is therefore kept as a REGRESSION LOCK on that measurement, not a
   * requirement this check declares — see the task-3 report for the finding
   * stated as a decision point rather than something patched into this file.
   */
  it('sees a foreign backend_xmin without pg_read_all_stats, though it loses the foreign query text', async () => {
    await withPostgres(async (ctx, pool) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const holderRole = `h_horizon_${suffix}`;
      const restrictedRole = `r_horizon_${suffix}`;
      await pool.query(`CREATE ROLE ${holderRole} LOGIN PASSWORD 'holder_pw'`);
      // No GRANT of pg_read_all_stats and no membership relationship to
      // holderRole — the exact shape of an ops/monitoring role distinct from
      // the application role it is watching.
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
          // MEASURED: backend_xmin (and therefore xminAge, the judged
          // quantity) is visible to the restricted role. If this ever starts
          // failing, that is the Stage-1-shaped defect the brief warned
          // about, and the fix belongs in a `requires: [{kind:'role', ...}]`
          // decision, not in loosening this assertion.
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
        // Roles are cluster-wide, not scoped to withPostgres's per-test
        // database — must be torn down explicitly, and a bare DROP ROLE
        // fails on the objects these roles have connected under.
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
   * STEP 3B — MEASURED, NOT ASSUMED. Driving the console at 390px against a
   * live database showed the Cleanup page's Oldest snapshot table naming one
   * of pgops's own backends as the thing pinning the xmin horizon: one page
   * render fires about six checks in parallel on separate pool connections,
   * so at the instant any one runs, the other five are themselves open
   * backends. See activity.int.test.ts's version of this pair for the fuller
   * explanation — the cause and the fix are shared between the two checks.
   */
  it('does not count the console itself among xmin holders', async () => {
    await withPostgres(async (ctx, pool) => {
      const other = await pool.connect();
      try {
        // Both connections wear the same application_name, which is what
        // pgops's own parallel check traffic looks like: six checks, six
        // connections, one page render.
        await ctx.target.query(`SET application_name = 'pgops-probe'`);
        await other.query(`SET application_name = 'pgops-probe'`);
        await other.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await other.query('SELECT 1'); // takes the snapshot, sets backend_xmin
        const res = await runCheck(ctx, horizon);
        if (!res.ok) throw new Error(res.message);
        expect(res.data.holders.some((h) => h.detail.startsWith('pgops-probe'))).toBe(false);
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
