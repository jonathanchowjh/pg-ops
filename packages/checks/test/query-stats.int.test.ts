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
      // The header must claim the sort that was actually applied.
      expect(byMean.data.sort).toBe('mean');

      const byTotal = await runCheck(ctx, queryStats, { sort: 'total', limit: 20 });
      if (!byTotal.ok) throw new Error(byTotal.message);
      const totals = byTotal.data.rows.map((r) => r.totalMs);
      expect([...totals].sort((a, b) => b - a)).toEqual(totals);
      expect(byTotal.data.sort).toBe('total');
    });
  }, 120_000);

  // Every sort key gets its own ordering assertion, so hardcoding or
  // dropping any one ORDER BY branch fails a test.
  it('sorts by calls and by cache hit rate too, in SQL (A4)', async () => {
    await withPostgres(async (ctx, pool) => {
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
      // Ascending by cache hit rate (worst first), no-I/O shapes (null) last.
      const withData = byCache.data.rows.filter((r) => r.cacheHitPct != null);
      const pcts = withData.map((r) => r.cacheHitPct as number);
      expect([...pcts].sort((a, b) => a - b)).toEqual(pcts);
      const lastDataIdx = byCache.data.rows.length - byCache.data.rows.filter((r) => r.cacheHitPct == null).length;
      expect(byCache.data.rows.slice(lastDataIdx).every((r) => r.cacheHitPct == null)).toBe(true);
      expect(byCache.data.sort).toBe('cache');
    });
  }, 120_000);

  /**
   * pg_stat_statements normalises integer literals, so `SELECT 201` and
   * `SELECT 202` are one row, `SELECT $1`. Arity survives normalisation:
   * `SELECT 1` and `SELECT 1, 2` are different rows. The first assertion
   * checks that the fixture really made SHAPES distinct shapes, and SHAPES is
   * above LIMIT so the truncation margin is the fixture's own.
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
      // rows; the harness's own statements cannot match the pattern.
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
   * `pg_stat_statements` is cluster-wide; without the `dbid` predicate
   * another database's statements are ranked alongside this one's.
   *
   * The marker is a column alias because a literal is normalised to `$1` and
   * would be invisible in the stored text either way. The local half of the
   * assertion proves the marker is findable at all.
   */
  it('ranks only the current database\'s statements (I2)', async () => {
    await withPostgres(async (ctx, pool) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const foreignMarker = `i2_foreign_${suffix}`;
      const localMarker = `i2_local_${suffix}`;

      // The container's default database, not the per-test one.
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

  // With pg_stat_statements.track = 'all', a PL/pgSQL function's body
  // statements become their own non-toplevel rows. Without `WHERE toplevel`
  // they would enter `totalShapes` and compete with the function's own call.
  it('does not let a function\'s own body statements inflate totalShapes (A5)', async () => {
    await withPostgres(async (ctx, pool) => {
      // `SET pg_stat_statements.track` is session-scoped, and two
      // `pool.query()` calls can land on different backends. A checked-out
      // client keeps every statement on the same one.
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

      // Guard the fixture: the function body's `PERFORM` (normalised to
      // `SELECT $1 + $2`) was recorded as a non-toplevel row.
      // Every count query here becomes a pg_stat_statements row itself once
      // it finishes, so counts taken at different points cannot be compared
      // for exact equality.
      const nested = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_stat_statements WHERE NOT toplevel AND query = 'SELECT $1 + $2'",
      );
      expect(Number(nested.rows[0]!.n)).toBeGreaterThan(0);

      const r = await runCheck(ctx, queryStats, { sort: 'calls', limit: 200 });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.rows.some((row) => row.query === 'SELECT $1 + $2')).toBe(false);
      // totalShapes is the toplevel-only count as of the check's own scan,
      // so it can only be <= a toplevel recount taken afterward.
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

  // Postgres redacts a foreign row's queryid/query rather than dropping it.
  // `q_monitor` neither owns `q_owner`'s statement nor has
  // `pg_read_all_stats`; the row must still appear, not silently vanish.
  it('surfaces a row it cannot identify rather than dropping it (fix round 1)', async () => {
    await withPostgres(async (ctx, pool) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const owner = `q_owner_${suffix}`;
      const monitor = `q_monitor_${suffix}`;
      await pool.query(`CREATE ROLE ${owner} LOGIN PASSWORD 'owner_pw'`);
      // A monitoring role distinct from the application roles: no
      // pg_read_all_stats, no ownership relationship to `owner`.
      await pool.query(`CREATE ROLE ${monitor} LOGIN PASSWORD 'monitor_pw'`);

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

          // `owner`'s row is present, identity redacted, cost intact.
          const foreign = r.data.rows.filter((row) => row.redacted);
          expect(foreign.length).toBeGreaterThan(0);
          for (const row of foreign) {
            expect(row.queryid).toBeNull();
            expect(row.query).toBe('<insufficient privilege>');
            expect(row.calls).toBeGreaterThan(0);
            expect(Number.isFinite(row.totalMs)).toBe(true);
          }
        } finally {
          await monitorPool.end();
        }
      } finally {
        // Roles are cluster-wide, so the per-test database teardown does not
        // drop them.
        await pool.query(`DROP ROLE ${owner}`);
        await pool.query(`DROP ROLE ${monitor}`);
      }
    });
  }, 120_000);

  it('carries the last stats_reset time when readable', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('SELECT pg_stat_statements_reset()');
      await pool.query('SELECT 424242');

      const r = await runCheck(ctx, queryStats, { sort: 'total', limit: 5 });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.statsResetAt).not.toBeNull();
      const resetAt = new Date(r.data.statsResetAt as string).getTime();
      expect(Date.now() - resetAt).toBeLessThan(60_000);
    });
  }, 120_000);

  it('hides the console\'s own shapes by default, counts them, and shows them on request', async () => {
    await withPostgres(async (ctx, pool) => {
      // Distinct arity, not just a distinct alias: queryid jumbling ignores
      // aliases, so `SELECT 42 AS marked` and `SELECT 43 AS unmarked` would
      // collapse into one row keeping whichever text ran first.
      // The marker is spelled out rather than built with `ownSql` so this
      // test states the wire format independently of production. It trails
      // because PostgreSQL 18 excludes a leading comment from the text
      // pg_stat_statements stores (14, 16 and 17 keep it).
      await pool.query('SELECT 42 AS marked\n/* pgops */');
      await pool.query('SELECT 43, 44 AS unmarked');

      const hidden = await runCheck(ctx, queryStats, { sort: 'calls', limit: 500 });
      if (!hidden.ok) throw new Error(hidden.message);
      expect(hidden.data.rows.some((r) => r.query?.endsWith('/* pgops */'))).toBe(false);
      expect(hidden.data.rows.some((r) => r.query?.includes('unmarked'))).toBe(true);
      expect(hidden.data.ownShapes).toBeGreaterThan(0);

      const shown = await runCheck(ctx, queryStats, { sort: 'calls', limit: 500, showOurs: true });
      if (!shown.ok) throw new Error(shown.message);
      expect(shown.data.rows.some((r) => r.query?.endsWith('/* pgops */'))).toBe(true);
      // Not strict equality: `hidden`'s own statement is recorded only once
      // it finishes, so `shown` may see one more shape than `hidden` counted.
      expect(shown.data.totalShapes).toBeGreaterThanOrEqual(hidden.data.totalShapes);
    });
  }, 120_000);
  it('sums every shape\'s time, and can be asked about one shape', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE TABLE t (id int)');
      for (let i = 0; i < 3; i++) await pool.query('INSERT INTO t VALUES ($1)', [i]);
      await pool.query('SELECT count(*) FROM t');
      const all = await runCheck(ctx, queryStats, { sort: 'total', limit: 50, showOurs: true });
      if (!all.ok) throw new Error(all.message);
      expect(all.data.allMs).toBeGreaterThanOrEqual(all.data.rows.reduce((a, r) => a + r.totalMs, 0) - 0.001);
      const insert = all.data.rows.find((r) => r.query?.startsWith('INSERT INTO t'))!;
      const one = await runCheck(ctx, queryStats, { sort: 'total', queryid: insert.queryid! });
      if (!one.ok) throw new Error(one.message);
      expect(one.data.rows.map((r) => r.queryid)).toEqual([insert.queryid]);
      // The sum is still every shape's, not the one asked about.
      expect(one.data.allMs).toBeGreaterThan(one.data.rows[0]!.totalMs);
    });
  }, 120_000);
});
