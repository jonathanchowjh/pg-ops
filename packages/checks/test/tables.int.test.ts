import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { tableCaching, tableHitRate, tableStats, unusedTables } from '../src/checks/tables.js';
import { withPostgres, seed, awaitPublished } from './harness.js';

describe('tables against a real server', () => {
  it('reads a null table hit rate on a database with no heap I/O', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, tableHitRate);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rate).toBeNull();
      expect(result.verdict).toEqual({ level: 'ok' });
    });
  });

  it('reads a real table hit rate once there has been heap I/O', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO t SELECT g, g FROM generate_series(1, 2000) g');
      await seed(pool, 'SELECT count(*) FROM t');
      await awaitPublished(pool, 'heap I/O',
        'SELECT coalesce(sum(heap_blks_hit + heap_blks_read), 0) > 0 AS ready'
        + ' FROM pg_statio_user_tables');

      const result = await runCheck(ctx, tableHitRate);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rate).not.toBeNull();
      expect(result.data.rate!).toBeGreaterThan(0);
      expect(result.data.rate!).toBeLessThanOrEqual(100);
    });
  });

  /**
   * pgHero renders a table that has done no heap I/O as `0` cached
   * (`CASE WHEN heap_blks_hit + heap_blks_read = 0 THEN 0`). pgops does not:
   * 0% is a measurement, "we have not read this table yet" is the absence of
   * one, and collapsing them puts a fake worst-case reading at the top of a
   * page sorted by how bad the reading is. Same divergence `indexCaching`
   * already carries.
   */
  it('leaves a table with no heap I/O at a null hit rate, not zero', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE untouched (v int)');

      const result = await runCheck(ctx, tableCaching, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.tables.find((t) => t.table.endsWith('.untouched'));
      expect(row).toBeDefined();
      expect(row!.hitRate).toBeNull();
    });
  });

  /**
   * The measurement the plan called "the seq_scan trap", pinned because it is
   * the reason #35 CANNOT be reformulated on seq_scan: CREATE INDEX scans the
   * heap and charges it to seq_scan, so a table acquires seq_scan = 1 before
   * anything queries it. Verified on 17.11; a table populated first reports
   * seq_tup_read equal to its row count.
   */
  it('records that CREATE INDEX itself increments seq_scan', async () => {
    await withPostgres(async (_ctx, pool) => {
      await seed(pool, 'CREATE TABLE with_pk (id int PRIMARY KEY)');
      await seed(pool, 'CREATE TABLE no_pk (v int)');
      await awaitPublished(pool, 'seq_scan for with_pk',
        "SELECT seq_scan > 0 AS ready FROM pg_stat_user_tables WHERE relname = 'with_pk'");

      const { rows } = await pool.query<{ relname: string; seq_scan: string }>(
        `SELECT relname, seq_scan::text AS seq_scan FROM pg_stat_user_tables
          WHERE relname IN ('with_pk','no_pk') ORDER BY relname`);
      const byName = Object.fromEntries(rows.map((r) => [r.relname, Number(r.seq_scan)]));

      expect(byName.no_pk).toBe(0);
      expect(byName.with_pk).toBeGreaterThan(0);
    });
  });

  /**
   * pgHero's filter is `idx_scan = 0`, and `idx_scan` is NULL — not 0 — for a
   * table that has no indexes at all. Verified identical on 14.24 and 18.6.
   * So a table with no index is NOT an unused table here: the question this
   * check asks is "are this table's indexes being used?", and that question
   * has no answer for a table with none. #28 missing_indexes is the check
   * that covers the other case.
   *
   * The plan asserted the opposite — that `no_pk` appears — which is neither
   * pgHero's behaviour nor a coherent reading of the title.
   */
  it('lists a table whose indexes go unused, and not one that has no indexes', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE unused_idx (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO unused_idx SELECT g, g FROM generate_series(1, 50) g');
      await seed(pool, 'CREATE TABLE no_idx (v int)');
      await seed(pool, 'INSERT INTO no_idx SELECT g FROM generate_series(1, 50) g');
      await seed(pool, 'ANALYZE');

      const result = await runCheck(ctx, unusedTables, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.tables.map((t) => t.table);
      expect(names).toContain('public.unused_idx');
      expect(names).not.toContain('public.no_idx');
    });
  });

  it('drops a table from the unused list once one of its indexes is scanned', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE scanned (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO scanned SELECT g, g FROM generate_series(1, 500) g');
      await seed(pool, 'ANALYZE scanned');
      for (let i = 1; i <= 20; i += 1) await pool.query('SELECT v FROM scanned WHERE id = $1', [i]);
      await awaitPublished(pool, 'index scans on scanned',
        "SELECT idx_scan > 0 AS ready FROM pg_stat_user_tables WHERE relname = 'scanned'");

      const result = await runCheck(ctx, unusedTables, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.tables.map((t) => t.table)).not.toContain('public.scanned');
    });
  });

  it('reports a freshly vacuumed table as vacuumed and never analyzed', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE v (id int PRIMARY KEY)');
      await pool.query('VACUUM v');
      await awaitPublished(pool, 'last_vacuum for v',
        "SELECT last_vacuum IS NOT NULL AS ready FROM pg_stat_user_tables WHERE relname = 'v'");

      const result = await runCheck(ctx, tableStats, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.tables.find((t) => t.table === 'public.v');
      expect(row).toBeDefined();
      expect(row!.lastVacuum).not.toBeNull();
      expect(row!.lastAnalyze).toBeNull();
      expect(row!.lastAutovacuum).toBeNull();
    });
  });

  it('reports live and dead tuple counts, with dead rising after deletes', async () => {
    await withPostgres(async (ctx, pool) => {
      // autovacuum off, so the assertion below can be exact: 1400 changes is
      // past the default autoanalyze threshold (50 + 0.1 * 1000), and a
      // daemon run between the DELETE and the check would reset n_dead_tup to
      // zero and make this test fail roughly one time in however often the
      // naptime lines up.
      await seed(pool, 'CREATE TABLE d (id int PRIMARY KEY, v int) WITH (autovacuum_enabled = false)');
      await seed(pool, 'INSERT INTO d SELECT g, g FROM generate_series(1, 1000) g');
      await seed(pool, 'DELETE FROM d WHERE id <= 400');
      // The ANALYZE must come AFTER the INSERT/DELETE deltas have been
      // published, not before. pgstat applies a transaction's tuple counts as
      // DELTAS while ANALYZE writes an ABSOLUTE estimate, so an ANALYZE that
      // lands first is immediately added to by the +600 net still pending in
      // the backends — this assertion read 1200 live rows, not 600, until the
      // two were ordered.
      await awaitPublished(pool, 'insert/delete deltas on d',
        "SELECT n_live_tup = 600 AND n_dead_tup = 400 AS ready"
        + " FROM pg_stat_user_tables WHERE relname = 'd'");
      await seed(pool, 'ANALYZE d');
      await awaitPublished(pool, 'last_analyze on d',
        "SELECT last_analyze IS NOT NULL AS ready FROM pg_stat_user_tables WHERE relname = 'd'");

      const result = await runCheck(ctx, tableStats, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.tables.find((t) => t.table === 'public.d')!;
      expect(row.liveRows).toBe(600);
      expect(row.deadRows).toBe(400);
      expect(row.lastAnalyze).not.toBeNull();
    });
  });

  it('reports the true total when a list is capped', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE a (v int)');
      await seed(pool, 'CREATE TABLE b (v int)');
      await seed(pool, 'CREATE TABLE c (v int)');

      const result = await runCheck(ctx, tableStats, { limit: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.tables).toHaveLength(1);
      expect(result.data.total).toBe(3);
      expect(result.data.truncated).toBe(true);
    });
  });

  /**
   * `pg_stat_user_tables` does NOT exclude temp schemas, whatever its name
   * suggests. Its definition is `schemaname <> ALL (ARRAY['pg_catalog',
   * 'information_schema']) AND schemaname !~ '^pg_toast'` — so another
   * session's `CREATE TEMP TABLE` shows up as `pg_temp_29.tmp_probe` on every
   * connection, and every check in this file needs the shared schema filter
   * on top of the view. The client is held open because the temp schema goes
   * away with its session; the statements are separate because two in one
   * `query` call would be one uncommitted transaction and invisible anyway.
   */
  it('ignores another session\'s temporary tables in all three list checks', async () => {
    await withPostgres(async (ctx, pool) => {
      const holder = await pool.connect();
      try {
        await holder.query('CREATE TEMP TABLE tmp_probe (v int)');
        await holder.query('INSERT INTO tmp_probe SELECT g FROM generate_series(1, 10) g');

        const { rows } = await pool.query<{ schemaname: string }>(
          "SELECT schemaname FROM pg_stat_user_tables WHERE relname = 'tmp_probe'");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.schemaname).toMatch(/^pg_temp/);

        const results = [
          await runCheck(ctx, tableCaching, {}),
          await runCheck(ctx, unusedTables, {}),
          await runCheck(ctx, tableStats, {}),
        ];
        for (const result of results) {
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.data.tables.map((t) => t.table)).not.toContain('tmp_probe');
          expect(result.data.tables.some((t) => t.table.startsWith('pg_temp'))).toBe(false);
        }
      } finally {
        holder.release();
      }
    });
  });

  it('reports no verdict at all on the three list checks', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (v int)');
      const results = [
        await runCheck(ctx, tableCaching, {}),
        await runCheck(ctx, unusedTables, {}),
        await runCheck(ctx, tableStats, {}),
      ];
      for (const result of results) {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.verdict).toBeNull();
      }
    });
  });
});
