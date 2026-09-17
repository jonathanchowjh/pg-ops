import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { indexBloat } from '../src/checks/index-bloat.js';
import { withPostgres, seed } from './harness.js';

describe('indexBloat against a real server', () => {
  /**
   * §6 asks for a smoke test: that the transcribed estimator parses and
   * returns the expected shape. It deliberately does NOT assert a bloat
   * figure — the estimate is approximate by construction, and pinning a
   * number would fail on every Postgres bump for no diagnostic gain.
   */
  it('parses and returns an empty list below the 100 MB floor', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO t SELECT g, g FROM generate_series(1, 5000) g');
      await seed(pool, 'ANALYZE t');

      const result = await runCheck(ctx, indexBloat, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Array.isArray(result.data.indexes)).toBe(true);
      expect(typeof result.data.total).toBe('number');
      // Nothing here is within four orders of magnitude of 100 MB of WASTED
      // space, so an empty list is what proves the floor is applied at all.
      expect(result.data.indexes).toEqual([]);
      expect(result.data.total).toBe(0);
      expect(result.verdict).toBeNull();
    });
  });

  /**
   * The floor lowered to zero, which is the only way to see the estimator
   * actually produce rows without building a genuinely 100 MB-bloated index.
   * This is what exercises the five CTEs, the pg_stats join and the mapping —
   * the test above only proves the SQL parses.
   */
  it('returns real rows, with both byte figures and a definition, once the floor is lowered', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO t SELECT g, g FROM generate_series(1, 5000) g');
      await seed(pool, 'CREATE INDEX ix_v ON t (v)');
      await seed(pool, 'ANALYZE t');

      const result = await runCheck(ctx, indexBloat, { minBytes: 0 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.indexes.find((i) => i.name === 'public.ix_v');
      expect(row).toBeDefined();
      expect(row!.table).toBe('public.t');
      expect(Number.isFinite(row!.bloatBytes)).toBe(true);
      expect(row!.bloatBytes).toBeGreaterThanOrEqual(0);
      expect(row!.indexBytes).toBeGreaterThan(0);
      expect(row!.definition).toContain('CREATE INDEX');
      expect(row!.primary).toBe(false);
    });
  });

  it('marks a primary key index as primary', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO t SELECT g, g FROM generate_series(1, 5000) g');
      await seed(pool, 'ANALYZE t');

      const result = await runCheck(ctx, indexBloat, { minBytes: 0 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const pk = result.data.indexes.find((i) => i.name === 'public.t_pkey');
      expect(pk).toBeDefined();
      expect(pk!.primary).toBe(true);
    });
  });

  it('applies the floor, so raising it past every index empties the list', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO t SELECT g, g FROM generate_series(1, 5000) g');
      await seed(pool, 'CREATE INDEX ix_v ON t (v)');
      await seed(pool, 'ANALYZE t');

      const open = await runCheck(ctx, indexBloat, { minBytes: 0 });
      expect(open.ok).toBe(true);
      if (!open.ok) return;
      expect(open.data.total).toBeGreaterThan(0);

      const closed = await runCheck(ctx, indexBloat, { minBytes: 100 * 1024 * 1024 });
      expect(closed.ok).toBe(true);
      if (!closed.ok) return;
      expect(closed.data.total).toBe(0);
    });
  });

  it('reports the true total when the list is capped', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id int PRIMARY KEY, a int, b int)');
      await seed(pool, 'INSERT INTO t SELECT g, g, g FROM generate_series(1, 5000) g');
      await seed(pool, 'CREATE INDEX ix_a ON t (a)');
      await seed(pool, 'CREATE INDEX ix_b ON t (b)');
      await seed(pool, 'ANALYZE t');

      const all = await runCheck(ctx, indexBloat, { minBytes: 0 });
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.data.total).toBeGreaterThanOrEqual(3);

      const capped = await runCheck(ctx, indexBloat, { minBytes: 0, limit: 1 });
      expect(capped.ok).toBe(true);
      if (!capped.ok) return;
      expect(capped.data.indexes).toHaveLength(1);
      expect(capped.data.total).toBe(all.data.total);
      expect(capped.data.truncated).toBe(true);
    });
  });

  /**
   * A table that has never been analysed has no `pg_stats` rows, so its
   * indexes drop out of the estimator's join entirely. That is an ABSENCE,
   * not a zero — the check cannot estimate bloat it has no statistics for,
   * and reporting such an index at 0 wasted bytes would be a measurement
   * nobody took.
   */
  it('omits an index on a never-analysed table rather than reporting it as unbloated', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE analysed (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO analysed SELECT g, g FROM generate_series(1, 5000) g');
      await seed(pool, 'ANALYZE analysed');
      await seed(pool, 'CREATE TABLE untouched (id int PRIMARY KEY, v int) WITH (autovacuum_enabled = false)');
      await seed(pool, 'INSERT INTO untouched SELECT g, g FROM generate_series(1, 5000) g');

      const result = await runCheck(ctx, indexBloat, { minBytes: 0 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.indexes.map((i) => i.name);
      expect(names).toContain('public.analysed_pkey');
      expect(names).not.toContain('public.untouched_pkey');
    });
  });
});
