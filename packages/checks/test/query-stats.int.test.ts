import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { queryStats } from '../src/checks/query-stats.js';
import { withPostgres } from './harness.js';

describe('queryStats', () => {
  it('sorts in SQL by the key it was asked for (A4)', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE TABLE t (id int)');
      for (let i = 0; i < 5; i++) await pool.query('INSERT INTO t VALUES ($1)', [i]);
      await pool.query('SELECT pg_sleep(0.2)');

      const byMean = await runCheck(ctx, queryStats, { sort: 'mean', limit: 20 });
      if (!byMean.ok) throw new Error(byMean.message);
      const means = byMean.data.rows.map((r) => r.meanMs);
      expect([...means].sort((a, b) => b - a)).toEqual(means);
      // The header this data feeds must claim the sort that was actually
      // applied, not a constant — see the map-level A4 test in
      // query-stats.test.ts for the case a Postgres round trip can't cover
      // (an empty result has no row to echo `requested_sort` back on).
      expect(byMean.data.sort).toBe('mean');

      // 'total' is otherwise only exercised by the truncation test below,
      // which never checks order — this is the one direct ordering proof
      // for it, same as every other key in the closed ORDER record gets.
      const byTotal = await runCheck(ctx, queryStats, { sort: 'total', limit: 20 });
      if (!byTotal.ok) throw new Error(byTotal.message);
      const totals = byTotal.data.rows.map((r) => r.totalMs);
      expect([...totals].sort((a, b) => b - a)).toEqual(totals);
      expect(byTotal.data.sort).toBe('total');
    });
  }, 120_000);

  // A4, every remaining key: 'total' and 'mean' are proven above/below by
  // distinct assertions; 'calls' and 'cache' get their own proof here so a
  // regression that hardcodes (or drops) any one ORDER BY branch — including
  // the 'cache' key the shipped defect named but the brief's own draft SQL
  // omitted — still fails a test, not just a code review.
  it('sorts by calls and by cache hit rate too, in SQL (A4)', async () => {
    await withPostgres(async (ctx, pool) => {
      // Distinct call counts across distinct shapes: three different
      // one-column literals so each becomes its own pg_stat_statements
      // entry, called a different number of times.
      for (let i = 0; i < 1; i++) await pool.query('SELECT 101');
      for (let i = 0; i < 3; i++) await pool.query('SELECT 102');
      for (let i = 0; i < 7; i++) await pool.query('SELECT 103');

      const byCalls = await runCheck(ctx, queryStats, { sort: 'calls', limit: 50 });
      if (!byCalls.ok) throw new Error(byCalls.message);
      const calls = byCalls.data.rows.map((r) => r.calls);
      expect([...calls].sort((a, b) => b - a)).toEqual(calls);
      expect(byCalls.data.sort).toBe('calls');

      const byCache = await runCheck(ctx, queryStats, { sort: 'cache', limit: 50 });
      if (!byCache.ok) throw new Error(byCache.message);
      // Ascending by cache hit rate (worst cache behaviour first) with
      // no-I/O shapes (null) sorted last, regardless of direction.
      const withData = byCache.data.rows.filter((r) => r.cacheHitPct != null);
      const pcts = withData.map((r) => r.cacheHitPct as number);
      expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
      const lastDataIdx = byCache.data.rows.length - byCache.data.rows.filter((r) => r.cacheHitPct == null).length;
      expect(byCache.data.rows.slice(lastDataIdx).every((r) => r.cacheHitPct == null)).toBe(true);
      expect(byCache.data.sort).toBe('cache');
    });
  }, 120_000);

  /**
   * Fix round 1 made `totalShapes >= rows.length` strict, because equal
   * counts satisfied `>=` and the assertion used to pass without ever
   * exercising truncation. M4 (final review) found the replacement fixture
   * was still not doing what its comment claimed: `SELECT 201..205` are not
   * "five distinct one-literal shapes" — pg_stat_statements NORMALISES
   * integer literals, so all five collapse into ONE row, `SELECT $1`, with
   * `calls = 5`. The margin that made the assertion pass came from
   * elsewhere: cluster-wide noise (CREATE DATABASE, testcontainers' probe,
   * every sibling integration file's statements). I2 has now scoped this
   * check to the current database and removed exactly that noise, so the
   * fixture has to earn its own margin.
   *
   * Varying ARITY is what normalisation preserves: `SELECT 1` and
   * `SELECT 1, 2` are `SELECT $1` and `SELECT $1, $2`, genuinely different
   * rows. The first assertion checks that directly, so a future edit that
   * goes back to varying literal VALUES fails here rather than silently
   * shrinking the margin to zero again.
   *
   * SHAPES is deliberately above LIMIT, and the margin is the fixture's own:
   * verified non-vacuous by lowering SHAPES below LIMIT, which makes
   * `totalShapes > rows.length` fail (see the fix report).
   */
  it('reports how many shapes it did not return (A4, M4)', async () => {
    const SHAPES = 6;
    const LIMIT = 5;
    await withPostgres(async (ctx, pool) => {
      for (let n = 1; n <= SHAPES; n += 1) {
        await pool.query(`SELECT ${Array.from({ length: n }, (_, i) => i + 1).join(', ')}`);
      }

      const all = await runCheck(ctx, queryStats, { sort: 'calls', limit: 500 });
      if (!all.ok) throw new Error(all.message);
      // One entry per distinct arity among the normalised `SELECT $1[, $n]`
      // rows — i.e. the fixture's own shapes, and nothing the harness's own
      // two statements (CREATE EXTENSION, SELECT current_setting($1) AS v)
      // could contribute.
      const arities = new Set(
        all.data.rows
          .filter((r) => r.query != null && /^SELECT\s+\$1(\s*,\s*\$\d+)*\s*$/.test(r.query))
          .map((r) => (r.query!.match(/\$\d+/g) ?? []).length),
      );
      expect(arities.size, 'the fixture must create genuinely distinct normalised shapes').toBe(SHAPES);

      const r = await runCheck(ctx, queryStats, { sort: 'total', limit: LIMIT });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.rows.length).toBe(LIMIT);
      expect(r.data.totalShapes).toBeGreaterThan(r.data.rows.length);
    });
  }, 120_000);

  /**
   * I2. `pg_stat_statements` is cluster-wide: before the `dbid` predicate,
   * a connection to `app_prod` ranked `app_staging`'s statements alongside
   * its own, and `QueryStatRow` carries no column an operator could use to
   * tell which database a row came from. This runs a marker statement in a
   * DIFFERENT database on the same container and asserts it does not appear.
   *
   * The marker is a column ALIAS, not a literal: pg_stat_statements
   * normalises `SELECT 'marker'` to `SELECT $1`, so a literal marker would
   * be invisible in the stored query text whether the scoping worked or not
   * — the test would pass for the wrong reason. Aliases survive
   * normalisation. The local half of the assertion is what proves the
   * foreign half is about SCOPE rather than about markers being unfindable.
   */
  it('ranks only the current database\'s statements (I2)', async () => {
    await withPostgres(async (ctx, pool) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const foreignMarker = `i2_foreign_${suffix}`;
      const localMarker = `i2_local_${suffix}`;

      // The container's own default database — a genuinely different one
      // from the per-test database `withPostgres` created.
      const other = new pg.Client({ connectionString: inject('pgConnectionUri') });
      try {
        await other.connect();
        await other.query(`SELECT 1 AS ${foreignMarker}`);
      } finally {
        await other.end().catch(() => {});
      }
      await pool.query(`SELECT 1 AS ${localMarker}`);

      const r = await runCheck(ctx, queryStats, { sort: 'calls', limit: 500 });
      if (!r.ok) throw new Error(r.message);
      const queries = r.data.rows.map((row) => row.query ?? '');
      expect(queries.some((q) => q.includes(localMarker)), 'the local statement must be ranked').toBe(true);
      expect(queries.some((q) => q.includes(foreignMarker)), 'another database\'s statement must not be').toBe(false);
    });
  }, 120_000);

  it('counts only top-level statements (A5)', async () => {
    await withPostgres(async (_ctx) => {
      const text = typeof queryStats.sql === 'string'
        ? queryStats.sql : queryStats.sql({ sort: 'total', limit: 1 }).text;
      expect(text).toContain('toplevel');
    });
  }, 120_000);

  // A5, behaviourally: proves the filter changes the answer, not just that
  // the SQL text mentions the column. With pg_stat_statements.track = 'all',
  // a PL/pgSQL function's body statements (the PERFORMs below) become their
  // own, non-toplevel, pg_stat_statements rows. Without `WHERE toplevel`,
  // this check's `totalShapes` — and its candidate pool for LIMIT/ORDER BY —
  // would include them, letting a function compete against its own internals
  // for the top slot, exactly as the defect describes.
  it('does not let a function\'s own body statements inflate totalShapes (A5)', async () => {
    await withPostgres(async (ctx, pool) => {
      // `SET pg_stat_statements.track` is session-scoped. `pool` hands out
      // one of up to four pooled connections per `.query()` call, so
      // setting it via `pool.query(...)` and then calling the function via
      // another `pool.query(...)` can silently land on two DIFFERENT
      // backends — the SET never in effect for the call it was meant to
      // cover. A single checked-out client keeps every statement on the
      // same backend.
      const client = await pool.connect();
      try {
        await client.query("SET pg_stat_statements.track = 'all'");
        await client.query(`
          CREATE OR REPLACE FUNCTION t_nested_a5() RETURNS void AS $$
          BEGIN
            PERFORM 1001 + 1;
          END;
          $$ LANGUAGE plpgsql;
        `);
        await client.query('SELECT t_nested_a5()');
      } finally {
        client.release();
      }

      // Fixture sanity: `track = 'all'` really did record the function
      // body's `PERFORM` (normalized to `SELECT $1 + $2`) as its own,
      // non-toplevel pg_stat_statements row — proof the fixture exercises
      // the exact shape A5 is about, not just that some row is non-toplevel.
      // Every count query below (including this one) becomes a new
      // pg_stat_statements row itself the moment it finishes, one step
      // AFTER the count it just returned — so counts taken at different
      // points in this test are never safe to compare for exact equality,
      // only for the presence/absence of one specific known shape.
      const nested = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_stat_statements WHERE NOT toplevel AND query = 'SELECT $1 + $2'",
      );
      expect(Number(nested.rows[0]!.n)).toBeGreaterThan(0);

      const r = await runCheck(ctx, queryStats, { sort: 'calls', limit: 200 });
      if (!r.ok) throw new Error(r.message);
      // The defect: without `WHERE toplevel`, this exact non-toplevel shape
      // would be a candidate for LIMIT/ORDER BY and could appear here,
      // competing against `t_nested_a5()`'s own toplevel call for a slot.
      expect(r.data.rows.some((row) => row.query === 'SELECT $1 + $2')).toBe(false);
      // totalShapes — the universe LIMIT drew from — is the toplevel-only
      // count as of (at latest) queryStats' own scan, which can only be
      // less than or equal to a toplevel recount taken strictly afterward.
      const toplevelNow = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM pg_stat_statements WHERE toplevel',
      );
      expect(r.data.totalShapes).toBeLessThanOrEqual(Number(toplevelNow.rows[0]!.n));
      expect(r.data.totalShapes).toBeGreaterThan(0);
    });
  }, 120_000);

  it('names the extension as the remedy when it is absent', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('DROP EXTENSION pg_stat_statements');
      const r = await runCheck(ctx, queryStats, { sort: 'total', limit: 5 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('missing-extension');
        expect(r.remedy).toBe('CREATE EXTENSION pg_stat_statements;');
      }
    });
  }, 120_000);

  // Fix round 1: the primary finding. Verified empirically against a live
  // PostgreSQL 17.11 that Postgres redacts a foreign row's queryid/query
  // rather than dropping it — this is the same proof reproduced against
  // this suite's own container. `q_monitor` below has neither ownership of
  // `q_owner`'s statement nor `pg_read_all_stats`: under the deleted
  // privilege-filter clause, `q_owner`'s row would have silently vanished
  // from `q_monitor`'s result (indistinguishable from "no such query
  // exists"). It must not vanish now.
  it('surfaces a row it cannot identify rather than dropping it (fix round 1)', async () => {
    await withPostgres(async (ctx, pool) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const owner = `q_owner_${suffix}`;
      const monitor = `q_monitor_${suffix}`;
      await pool.query(`CREATE ROLE ${owner} LOGIN PASSWORD 'owner_pw'`);
      // No GRANT of pg_read_all_stats, and no ownership relationship to
      // `owner` — the exact role shape this check exists to serve: a
      // monitoring/ops role distinct from the application roles.
      await pool.query(`CREATE ROLE ${monitor} LOGIN PASSWORD 'monitor_pw'`);

      // `pool.options.connectionString` is typed `string | undefined` (PoolConfig
      // leaves it optional even though this harness always sets it) — the same
      // widening blocked.int.test.ts/locks.int.test.ts already use for `pool.options`
      // narrows it to the `string` it genuinely is here.
      const baseUri = new URL(
        (pool as unknown as { options: { connectionString: string } }).options.connectionString,
      );

      try {
        const ownerUri = new URL(baseUri);
        ownerUri.username = owner;
        ownerUri.password = 'owner_pw';
        const ownerClient = new pg.Client({ connectionString: ownerUri.toString() });
        await ownerClient.connect();
        try {
          await ownerClient.query('SELECT 777888999 AS fix_round_1_marker');
        } finally {
          await ownerClient.end();
        }

        const monitorUri = new URL(baseUri);
        monitorUri.username = monitor;
        monitorUri.password = 'monitor_pw';
        const monitorPool = new pg.Pool({ connectionString: monitorUri.toString(), max: 1 });
        try {
          const monitorCtx = { target: monitorPool, serverVersion: ctx.serverVersion };
          const r = await runCheck(monitorCtx, queryStats, { sort: 'calls', limit: 200 });
          if (!r.ok) throw new Error(r.message);

          // The old, deleted clause would have filtered `owner`'s row out
          // of `visible` entirely before `monitor` ever saw it. Now it must
          // be present, with its identity redacted but its cost intact —
          // exactly what a live PG17.11 query returned when the reviewer
          // ran this scenario by hand.
          const foreign = r.data.rows.filter((row) => row.redacted);
          expect(foreign.length).toBeGreaterThan(0);
          for (const row of foreign) {
            expect(row.queryid).toBeNull();
            expect(row.query).toBe('<insufficient privilege>');
            // The row survived: cost figures are real numbers, not zeroed
            // out alongside the identity.
            expect(row.calls).toBeGreaterThan(0);
            expect(Number.isFinite(row.totalMs)).toBe(true);
          }
        } finally {
          await monitorPool.end();
        }
      } finally {
        // Roles are cluster-wide, not scoped to withPostgres's per-test
        // database — must be dropped explicitly or a later run in the same
        // container collides on CREATE ROLE.
        await pool.query(`DROP ROLE ${owner}`);
        await pool.query(`DROP ROLE ${monitor}`);
      }
    });
  }, 120_000);

  it('carries the last stats_reset time when readable', async () => {
    await withPostgres(async (ctx, pool) => {
      // pg_stat_statements_reset() clears counters — a reset, not DDL/DML
      // (the task's own carve-out), acceptable in a test fixture.
      await pool.query('SELECT pg_stat_statements_reset()');
      await pool.query('SELECT 424242');

      const r = await runCheck(ctx, queryStats, { sort: 'total', limit: 5 });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.statsResetAt).not.toBeNull();
      // The reset just ran; the reported timestamp should parse as recent.
      const resetAt = new Date(r.data.statsResetAt as string).getTime();
      expect(Date.now() - resetAt).toBeLessThan(60_000);
    });
  }, 120_000);
});
