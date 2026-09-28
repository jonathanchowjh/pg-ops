import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { tableList } from '../src/checks/table-list.js';
import { withPostgres, seed, awaitPublished } from './harness.js';

describe('tableList against a real server', () => {
  it('lists the largest table first and reports the true total', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE small_a (v int)');
      await seed(pool, 'CREATE TABLE small_b (v int)');
      await seed(pool, 'CREATE TABLE large (v text)');
      await seed(pool, "INSERT INTO large SELECT repeat('x', 200) FROM generate_series(1, 20000)");
      await seed(pool, 'ANALYZE');

      const all = await runCheck(ctx, tableList, {});
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.data.total).toBe(3);
      expect(all.data.truncated).toBe(false);
      expect(all.data.tables[0]!.name).toBe('public.large');

      const capped = await runCheck(ctx, tableList, { limit: 1 });
      expect(capped.ok).toBe(true);
      if (!capped.ok) return;
      expect(capped.data.tables).toHaveLength(1);
      expect(capped.data.total).toBe(3);
      expect(capped.data.truncated).toBe(true);
    });
  });

  /**
   * THE POINT OF THE WHOLE CHECK. A sort must re-rank the population, not the
   * page. If sorting happened after the cap this passes only by luck: ask for
   * one row by size and one row by name, and a cap-then-sort implementation
   * returns the same table twice.
   */
  it('sorts the whole population, not the capped page', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE zzz_big (v text)');
      await seed(pool, "INSERT INTO zzz_big SELECT repeat('x', 200) FROM generate_series(1, 20000)");
      await seed(pool, 'CREATE TABLE aaa_small (v int)');
      await seed(pool, 'ANALYZE');

      const bySize = await runCheck(ctx, tableList, { limit: 1, sort: 'size' });
      const byName = await runCheck(ctx, tableList, { limit: 1, sort: 'name' });
      expect(bySize.ok && byName.ok).toBe(true);
      if (!bySize.ok || !byName.ok) return;
      expect(bySize.data.tables[0]!.name).toBe('public.zzz_big');
      expect(byName.data.tables[0]!.name).toBe('public.aaa_small');
    });
  });

  /**
   * §5.2: the Table page asks about one relation, and the answer must not
   * depend on where that relation fell in a ranking. `limit: 1` with a sort
   * that puts the wanted table last is the shape of the bug — a filter
   * applied after the cap returns nothing here.
   */
  it('finds a relation the cap would have excluded', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE zzz_big (v text)');
      await seed(pool, "INSERT INTO zzz_big SELECT repeat('x', 200) FROM generate_series(1, 20000)");
      await seed(pool, 'CREATE TABLE aaa_small (v int)');
      await seed(pool, 'ANALYZE');

      const one = await runCheck(ctx, tableList, { limit: 1, sort: 'size', relation: 'public.aaa_small' });
      expect(one.ok).toBe(true);
      if (!one.ok) return;
      expect(one.data.tables).toHaveLength(1);
      expect(one.data.tables[0]!.name).toBe('public.aaa_small');
      expect(one.data.total).toBe(1);
      expect(one.data.truncated).toBe(false);
    });
  });

  it('answers with nothing, not an error, for a relation that does not exist', async () => {
    await withPostgres(async (ctx) => {
      const none = await runCheck(ctx, tableList, { relation: 'public.no_such_table' });
      expect(none.ok).toBe(true);
      if (!none.ok) return;
      expect(none.data.tables).toEqual([]);
      expect(none.data.total).toBe(0);
    });
  });

  it('counts matches, not the whole database, when searching', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE orders (v int)');
      await seed(pool, 'CREATE TABLE order_items (v int)');
      await seed(pool, 'CREATE TABLE customers (v int)');

      const found = await runCheck(ctx, tableList, { search: 'ORDER' });
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.data.total).toBe(2);
      expect(found.data.tables.map((t) => t.name).sort())
        .toEqual(['public.order_items', 'public.orders']);
    });
  });

  it('keeps a table with no recorded heap I/O, with a null hit rate', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE untouched (v int)');
      const out = await runCheck(ctx, tableList, { relation: 'public.untouched' });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.data.tables).toHaveLength(1);
      expect(out.data.tables[0]!.hitRate).toBeNull();
    });
  });

  /**
   * The four sort keys `boundaries.test.ts` cannot reach, because the
   * `ORDER BY` here is assembled at runtime from `ORDER[o.sort]` rather than
   * written as literal source text — see the docblock above `ORDER` in
   * table-list.ts. `size` and `name` already had coverage above; this is the
   * rest, one `withPostgres` block per the review's suggested shape.
   *
   * `cache` is the one that actually matters: it is the only clause touching
   * the LEFT-JOINed `io` CTE and the only `/ nullif(` division, and its NULLS
   * LAST placement carries a claim — an unmeasured table (no heap I/O at
   * all) must not rank as the worst cache hit rate in the database. Inverting
   * NULLS LAST to NULLS FIRST would put `c_no_io` first instead of last, so
   * this is the assertion that actually pins the direction rather than merely
   * exercising the clause.
   *
   * WAITING FOR THE STATISTICS IS NOT DECORATION. Verified empirically
   * against this harness: `pg_stat_user_tables` and `pg_statio_user_tables`
   * are backed by counters each backend accumulates LOCALLY and flushes to
   * shared memory no more than once every ~500ms — so a fast sequence of
   * `INSERT`/`DELETE`/`SELECT` calls made well inside that window (exactly
   * what this test does) leaves every counter reading zero, with no error and
   * no warning, silently proving nothing. `ANALYZE` and `VACUUM` force their
   * OWN narrow slice of that flush, which is why `n_live_tup` and
   * `last_vacuum` read correctly without help; `heap_blks_hit` is in neither
   * slice.
   *
   * This waited by calling `pg_stat_force_next_flush()`, which is the direct
   * way to do it and does not exist before Postgres 15. The gate's default is
   * one version and its matrix is opt-in, so this passed on 17 and failed
   * every 14 leg with `function pg_stat_force_next_flush() does not exist` —
   * 14 being the floor this project declares and tests. `awaitPublished`
   * polls instead, which is correct on every supported version, and its
   * docblock in harness.ts records why it is shared rather than local.
   *
   * The poll asks for every fact the four assertions below rest on, not just
   * the heap I/O, so no assertion can read a counter that has not landed yet.
   * `c_no_io` is created AFTER it returns and is touched by nothing
   * thereafter, which is what keeps its cache hit rate genuinely null — the
   * poll reads only the statistics views, never the tables themselves.
   */
  it('sorts correctly on dead, rows, vacuum and cache, all four untested by size/name above', async () => {
    await withPostgres(async (ctx, pool) => {
      // a_many_dead: some live rows, MANY dead rows (delete without vacuum),
      // and heap I/O from the SELECT below — measured, not null, cache hit.
      await seed(pool, 'CREATE TABLE a_many_dead (v int)');
      await seed(pool, 'INSERT INTO a_many_dead SELECT generate_series(1, 200)');
      await seed(pool, 'DELETE FROM a_many_dead WHERE v <= 150');
      await seed(pool, 'SELECT count(*) FROM a_many_dead');

      // b_many_rows: far more live rows than any other table here, and
      // explicitly VACUUMed so it carries a real, non-null last_vacuum — and
      // also read, so it is a SECOND measured (non-null) cache hit rate.
      await seed(pool, 'CREATE TABLE b_many_rows (v int)');
      await seed(pool, 'INSERT INTO b_many_rows SELECT generate_series(1, 5000)');
      await seed(pool, 'VACUUM b_many_rows');
      await seed(pool, 'SELECT count(*) FROM b_many_rows');

      // Wait for the statistics described above, once, after every table
      // above has done everything it is going to do.
      await awaitPublished(
        pool,
        'dead rows, live rows, last_vacuum and heap I/O for a_many_dead and b_many_rows',
        `SELECT coalesce(
                  (SELECT s.n_dead_tup > 0
                          AND coalesce(io.heap_blks_hit, 0) + coalesce(io.heap_blks_read, 0) > 0
                     FROM pg_stat_user_tables s
                     JOIN pg_statio_user_tables io USING (relid)
                    WHERE s.relname = 'a_many_dead'),
                  false)
                AND coalesce(
                  (SELECT s.n_live_tup > 0
                          AND s.last_vacuum IS NOT NULL
                          AND coalesce(io.heap_blks_hit, 0) + coalesce(io.heap_blks_read, 0) > 0
                     FROM pg_stat_user_tables s
                     JOIN pg_statio_user_tables io USING (relid)
                    WHERE s.relname = 'b_many_rows'),
                  false) AS ready`,
      );

      // c_no_io: created and never read or written again — no heap I/O
      // recorded at all, so its cache hit rate is null. Never vacuumed
      // either, so its last_vacuum is null too. Created AFTER the flush
      // above, and touched by nothing after that point, so it never enters
      // the forced flush at all — the same reasoning the "keeps a table
      // with no recorded heap I/O" test above already relies on, just made
      // explicit here since this test forces flushes for its siblings.
      await seed(pool, 'CREATE TABLE c_no_io (v int)');

      const dead = await runCheck(ctx, tableList, { sort: 'dead' });
      expect(dead.ok).toBe(true);
      if (!dead.ok) return;
      expect(dead.data.tables[0]!.name).toBe('public.a_many_dead');

      const rows = await runCheck(ctx, tableList, { sort: 'rows' });
      expect(rows.ok).toBe(true);
      if (!rows.ok) return;
      expect(rows.data.tables[0]!.name).toBe('public.b_many_rows');

      // NULLS FIRST: a_many_dead and c_no_io both have a null last_vacuum;
      // b_many_rows has a real one and must NOT be first. The tie among the
      // two nulls breaks on name, so 'a_many_dead' (< 'c_no_io') wins it —
      // asserted precisely rather than just "not b_many_rows" so a broken
      // NULLS placement that happened to still exclude b_many_rows would not
      // pass by accident.
      const vacuum = await runCheck(ctx, tableList, { sort: 'vacuum' });
      expect(vacuum.ok).toBe(true);
      if (!vacuum.ok) return;
      expect(vacuum.data.tables[0]!.name).toBe('public.a_many_dead');

      // NULLS LAST: c_no_io is the ONLY one of the three with no heap I/O
      // recorded, so it is the only null cache hit rate here. THE ASSERTION
      // THAT MATTERS — a null hit rate must not rank as the worst (first)
      // row under "worst cache hit first".
      const cache = await runCheck(ctx, tableList, { sort: 'cache' });
      expect(cache.ok).toBe(true);
      if (!cache.ok) return;
      expect(cache.data.tables[0]!.name).not.toBe('public.c_no_io');
      expect(cache.data.tables.at(-1)!.name).toBe('public.c_no_io');
    });
  });

  /**
   * The case a real search box hits first: underscores are common in table
   * names, and `_` is an ILIKE wildcard ("any one character") unless escaped.
   * Unescaped, searching `order_item` would also match `orderxitem`, which is
   * not what an operator typing that name meant.
   */
  it('treats an underscore in the search term as literal, not as an ILIKE wildcard', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE order_item (v int)');
      await seed(pool, 'CREATE TABLE orderxitem (v int)');

      const found = await runCheck(ctx, tableList, { search: 'order_item' });
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.data.tables.map((t) => t.name)).toEqual(['public.order_item']);
      expect(found.data.total).toBe(1);
    });
  });

  /**
   * `pg_stat_user_tables` has a row per `relkind IN ('r','t','m','p')`, not
   * per ordinary table — a materialized view is in there too. A page called
   * Tables must not present one as a table, and (the sharper failure) must
   * not report a fabricated size for it either: an earlier draft LEFT JOINed
   * a `relkind = 'r'`-filtered size CTE back onto the spine by name and
   * `coalesce`d the miss to 0, which is a real, unmeasured size folded into
   * a fake-looking zero — indistinguishable from a genuinely empty table,
   * and it would have sorted to the bottom of the default ranking where
   * nobody would question it.
   */
  it('does not present a materialized view as a table', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE base (v int)');
      await seed(pool, 'INSERT INTO base VALUES (1)');
      await seed(pool, 'CREATE MATERIALIZED VIEW base_mv AS SELECT * FROM base');
      const out = await runCheck(ctx, tableList, {});
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const names = out.data.tables.map((t) => t.name);
      expect(names).toContain('public.base');
      expect(names).not.toContain('public.base_mv');
    });
  });
});

