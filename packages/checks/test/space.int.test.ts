import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { databaseSize, relationSizes, tableSizes } from '../src/checks/space.js';
import { withPostgres, seed } from './harness.js';

describe('space against a real server', () => {
  it('reads a database size larger than zero', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, databaseSize);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.sizeBytes).toBeGreaterThan(0);
      expect(result.verdict).toBeNull();
    });
  });

  /**
   * The double-count, as a falsifiable test. `pg_total_relation_size` on a
   * table already includes its indexes and its TOAST; if #38 uses it per row
   * while also listing those indexes as rows of their own, the list sums to
   * more than the database that contains it. Measured during review at
   * 76,693,504 bytes against a 56,481,459-byte database.
   */
  it('does not sum to more than the database it describes', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE big_t (a int, b int, c text)');
      await seed(pool, "INSERT INTO big_t SELECT g, g, repeat('x', 100) FROM generate_series(1, 60000) g");
      await seed(pool, 'CREATE INDEX ix_a ON big_t (a)');
      await seed(pool, 'CREATE INDEX ix_b ON big_t (b)');

      const rels = await runCheck(ctx, relationSizes, { limit: 1000 });
      const db = await runCheck(ctx, databaseSize);

      expect(rels.ok && db.ok).toBe(true);
      if (!rels.ok || !db.ok) return;
      const sum = rels.data.relations.reduce((n, r) => n + r.sizeBytes, 0);
      expect(sum).toBeLessThanOrEqual(db.data.sizeBytes!);
      // And it must not be trivially small either, or the assertion above
      // would pass on an empty list.
      expect(sum).toBeGreaterThan(1_000_000);
    });
  });

  /**
   * The two size functions are NOT interchangeable, and this is the test that
   * says so. pgHero uses `pg_table_size` for #38 (per-relation, indexes
   * listed separately) and `pg_total_relation_size` for #39 (the number an
   * operator means by "how big is this table"), so the same table must read
   * LARGER through tableSizes than through relationSizes once it has indexes.
   */
  it('reports a table as bigger through tableSizes than relationSizes, because indexes count once', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE sized (a int, b int)');
      await seed(pool, 'INSERT INTO sized SELECT g, g FROM generate_series(1, 50000) g');
      await seed(pool, 'CREATE INDEX ix_sized_a ON sized (a)');

      const rels = await runCheck(ctx, relationSizes, { limit: 1000 });
      const tables = await runCheck(ctx, tableSizes, { limit: 1000 });

      expect(rels.ok && tables.ok).toBe(true);
      if (!rels.ok || !tables.ok) return;
      const asRelation = rels.data.relations.find((r) => r.name === 'public.sized')!;
      const asTable = tables.data.relations.find((r) => r.name === 'public.sized')!;
      expect(asRelation.sizeBytes).toBeGreaterThan(0);
      expect(asTable.sizeBytes).toBeGreaterThan(asRelation.sizeBytes);
      // The index is a row of its own in #38 and no row at all in #39.
      expect(rels.data.relations.some((r) => r.name === 'public.ix_sized_a')).toBe(true);
      expect(tables.data.relations.some((r) => r.name === 'public.ix_sized_a')).toBe(false);
    });
  });

  it('finds a table it was just given, schema-qualified, and excludes catalogs', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE space_fixture (id int PRIMARY KEY)');

      const result = await runCheck(ctx, tableSizes, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.relations.map((r) => r.name);
      expect(names).toContain('public.space_fixture');
      expect(names.some((n) => n.startsWith('pg_'))).toBe(false);
      expect(names.some((n) => n.startsWith('information_schema.'))).toBe(false);
    });
  });

  it("excludes another session's temporary tables", async () => {
    await withPostgres(async (ctx, pool) => {
      // A temp table lands in a pg_temp_N schema, which an exact-match NOT IN
      // list does not exclude — and its pg_class row is visible to every
      // session in the database, not just the one that made it.
      const holder = await pool.connect();
      try {
        await holder.query('CREATE TEMP TABLE tmp_leak (id int)');

        const result = await runCheck(ctx, relationSizes, { limit: 1000 });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.relations.some((r) => r.name.includes('tmp_leak'))).toBe(false);
      } finally {
        holder.release();
      }
    });
  });

  /**
   * The premise of the `size_num IS NOT NULL` guard, which cannot be tested
   * through the check itself: it fires only for a relation dropped between
   * the catalog scan and the size call, and that race cannot be staged.
   *
   * What CAN be pinned is why the guard is written as a filter rather than a
   * try/catch — these functions return NULL for an oid that no longer exists
   * rather than raising. If this ever starts raising, the guard stops working
   * and the check begins failing outright instead of skipping a row.
   */
  it('returns null, not an error, for a relation that no longer exists', async () => {
    await withPostgres(async (_ctx, pool) => {
      const { rows } = await pool.query<{ t: string | null; r: string | null }>(
        `SELECT pg_table_size(999999999::oid)::text AS t,
                pg_total_relation_size(999999999::oid)::text AS r`);
      expect(rows[0]!.t).toBeNull();
      expect(rows[0]!.r).toBeNull();
    });
  });

  it('labels a relation by kind, so an index is distinguishable from a table', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE kinds (a int)');
      await seed(pool, 'CREATE INDEX ix_kinds ON kinds (a)');
      await seed(pool, 'CREATE MATERIALIZED VIEW mv_kinds AS SELECT * FROM kinds');

      const result = await runCheck(ctx, relationSizes, { limit: 1000 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const byName = Object.fromEntries(result.data.relations.map((r) => [r.name, r.type]));
      expect(byName['public.kinds']).toBe('table');
      expect(byName['public.ix_kinds']).toBe('index');
      expect(byName['public.mv_kinds']).toBe('matview');
    });
  });

  it('reports the true total when a list is capped, largest first', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE small_a (v int)');
      await seed(pool, 'CREATE TABLE small_b (v int)');
      await seed(pool, 'CREATE TABLE large (v text)');
      await seed(pool, "INSERT INTO large SELECT repeat('x', 200) FROM generate_series(1, 20000)");

      const all = await runCheck(ctx, tableSizes, {});
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.data.total).toBe(3);
      expect(all.data.truncated).toBe(false);

      const capped = await runCheck(ctx, tableSizes, { limit: 1 });
      expect(capped.ok).toBe(true);
      if (!capped.ok) return;
      expect(capped.data.relations).toHaveLength(1);
      expect(capped.data.total).toBe(3);
      expect(capped.data.truncated).toBe(true);
      // The cap must drop the SMALL ones — a size list that truncates the
      // largest relation has hidden the only row anyone opened it for.
      expect(capped.data.relations[0]!.name).toBe('public.large');
    });
  });
});
