import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { indexFlags, indexes, tableFlags, tables } from '../src/checks/catalog.js';
import { runCheck } from '../src/run.js';
import { migrate } from '../src/store/migrate.js';
import { awaitPublished, seed, withPostgres } from './harness.js';

const SETUP = [
  'CREATE TABLE parents (id int PRIMARY KEY)',
  'CREATE TABLE orders (id bigserial PRIMARY KEY, parent_id int, status text, note text)',
  "INSERT INTO orders (parent_id, status) SELECT g, 'new' FROM generate_series(1, 500) g",
  'CREATE INDEX orders_status_a ON orders (status)',
  'CREATE INDEX orders_status_b ON orders (status)',
  'CREATE INDEX orders_status_note ON orders (status, note)',
  'ALTER TABLE orders ADD CONSTRAINT orders_parent_fk FOREIGN KEY (parent_id) REFERENCES parents (id) NOT VALID',
  'CREATE TABLE tuned (id int) WITH (autovacuum_vacuum_threshold = 10, autovacuum_vacuum_scale_factor = 0)',
  'CREATE TABLE events (id int, at date) PARTITION BY RANGE (at)',
  "CREATE TABLE events_2026 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
  'CREATE MATERIALIZED VIEW order_counts AS SELECT status, count(*) AS n FROM orders GROUP BY status',
  'CREATE TABLE "100%_done" (id int)',
];
const setup = async (pool: pg.Pool): Promise<void> => { for (const sql of SETUP) await seed(pool, sql); };

describe('tables', () => {
  it('reads every kind of table, with its sizes, its trigger and what a migration left behind', async () => {
    await withPostgres(async (ctx, pool) => {
      await setup(pool);
      const r = await runCheck(ctx, tables, {});
      if (!r.ok) throw new Error(r.message);
      const by = new Map(r.data.tables.map((t) => [t.name, t]));
      expect([...by].map(([n, t]) => [n, t.kind]).sort()).toEqual([
        ['public.100%_done', 'table'], ['public.events', 'partitioned'], ['public.events_2026', 'table'],
        ['public.order_counts', 'matview'], ['public.orders', 'table'], ['public.parents', 'table'], ['public.tuned', 'table'],
      ]);
      const orders = by.get('public.orders')!;
      expect(orders.indexes).toBe(4);
      expect(orders.unvalidated).toBe(1);
      expect(orders.sizeBytes).toBeGreaterThan(orders.heapBytes);
      expect(orders.indexBytes).toBeGreaterThan(0);
      expect(orders.xidAge).toBeGreaterThanOrEqual(0);
      expect(tableFlags(orders, r.data.freezeMaxAge)).toContain('not validated');
      // Its own storage parameters, not the server's 50 + 0.2 × rows.
      expect(by.get('public.tuned')!.vacuumTrigger).toBe(10);
      // 18 caps the trigger; a table's own cap stands in for the server's.
      if (ctx.serverVersion >= 180_000) {
        await pool.query('ALTER TABLE tuned SET (autovacuum_vacuum_threshold = 1000, autovacuum_vacuum_max_threshold = 5)');
        const capped = await runCheck(ctx, tables, {});
        if (!capped.ok) throw new Error(capped.message);
        expect(capped.data.tables.find((t) => t.name === 'public.tuned')!.vacuumTrigger).toBe(5);
      }
      // age(0) is 2147483647: a parent with no storage must not top every list.
      expect(by.get('public.events')!.xidAge).toBeNull();
      expect(r.data.freezeMaxAge).toBe(200_000_000);
    });
  }, 120_000);

  it('counts what was written, once the server has published it', async () => {
    await withPostgres(async (ctx, pool) => {
      await setup(pool);
      await awaitPublished(pool, 'the inserts into orders',
        "SELECT n_tup_ins >= 500 AS ready FROM pg_stat_user_tables WHERE relname = 'orders'");
      const r = await runCheck(ctx, tables, { relation: 'public.orders' });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.tables.map((t) => t.name)).toEqual(['public.orders']);
      expect(r.data.total).toBe(1);
      expect(r.data.tables[0]!.inserted).toBeGreaterThanOrEqual(500);
      expect(r.data.tables[0]!.lastVacuum).toBeNull();
    });
  }, 120_000);

  it('finds tables by a text taken literally', async () => {
    await withPostgres(async (ctx, pool) => {
      await setup(pool);
      const names = async (search: string) => {
        const r = await runCheck(ctx, tables, { search });
        if (!r.ok) throw new Error(r.message);
        return r.data.tables.map((t) => t.name).sort();
      };
      expect(await names('100%')).toEqual(['public.100%_done']);
      expect(await names('_')).toEqual(['public.100%_done', 'public.events_2026', 'public.order_counts']);
      expect(await names('ORDERS')).toEqual(['public.orders']);
    });
  }, 120_000);

  it('keeps the largest under a cap and says how many there are', async () => {
    await withPostgres(async (ctx, pool) => {
      await setup(pool);
      const r = await runCheck(ctx, tables, { limit: 1 });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.tables.map((t) => t.name)).toEqual(['public.orders']);
      expect(r.data).toMatchObject({ total: 7, truncated: true });
    });
  }, 120_000);

  it('leaves pgops\'s own schema out of both reads', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      const t = await runCheck(ctx, tables, {});
      const i = await runCheck(ctx, indexes, {});
      if (!t.ok || !i.ok) throw new Error('not read');
      expect(t.data.tables).toEqual([]);
      expect(i.data.indexes).toEqual([]);
    });
  }, 120_000);
});

describe('a table a migration holds', () => {
  /**
   * The size functions wait for AccessShareLock. Under the statement timeout
   * alone, one table held ACCESS EXCLUSIVE held every catalog read for ten
   * seconds; the read fails instead, and never by leaving the table out.
   */
  it('fails the read within the lock timeout, rather than waiting it out or dropping the row', async () => {
    await withPostgres(async (ctx, pool) => {
      await setup(pool);
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE orders IN ACCESS EXCLUSIVE MODE');
        const started = Date.now();
        const r = await runCheck(ctx, tables, {});
        expect(Date.now() - started).toBeLessThan(2_500);
        expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/lock timeout/) });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      // Released, the same read answers with the table in it.
      const after = await runCheck(ctx, tables, {});
      expect(after.ok && after.data.tables.some((t) => t.name === 'public.orders')).toBe(true);
    });
  }, 120_000);
});

describe('indexes', () => {
  it('names each index with its columns, and the one that already covers it', async () => {
    await withPostgres(async (ctx, pool) => {
      await setup(pool);
      // A unique build over duplicate values fails and leaves an invalid index behind.
      await pool.query('CREATE UNIQUE INDEX CONCURRENTLY orders_bad ON orders (status)').catch(() => {});
      const r = await runCheck(ctx, indexes, { relation: 'public.orders' });
      if (!r.ok) throw new Error(r.message);
      const by = new Map(r.data.indexes.map((i) => [i.name, i]));
      expect([...by.keys()].sort()).toEqual([
        'public.orders_bad', 'public.orders_pkey', 'public.orders_status_a', 'public.orders_status_b', 'public.orders_status_note',
      ]);
      expect(by.get('public.orders_status_note')).toMatchObject({ table: 'public.orders', columns: 'status, note', duplicateOf: null });
      // The identical pair is reported once, on the later one; the earlier is covered by the longer key.
      expect(by.get('public.orders_status_b')!.duplicateOf).toBe('public.orders_status_a');
      expect(by.get('public.orders_status_a')!.duplicateOf).toBe('public.orders_status_note');
      expect(by.get('public.orders_pkey')).toMatchObject({ unique: true, primary: true, valid: true, duplicateOf: null });
      // Invalid: it covers nothing, is not called a duplicate, and is not called unused.
      expect(by.get('public.orders_bad')).toMatchObject({ valid: false, duplicateOf: null });
      expect(indexFlags(by.get('public.orders_bad')!)).toEqual(['invalid']);
      expect(indexFlags(by.get('public.orders_status_note')!)).toEqual(['never used']);
      expect(r.data.total).toBe(5);
    });
  }, 120_000);

  it('counts a scan, once the server has published it', async () => {
    await withPostgres(async (ctx, pool) => {
      await setup(pool);
      // One round trip, so the setting and the scan share a connection. 500 rows could be read either way.
      await pool.query('SET enable_seqscan = off; SELECT id FROM orders WHERE id = 7');
      await awaitPublished(pool, 'the scan of orders_pkey',
        "SELECT idx_scan > 0 AS ready FROM pg_stat_user_indexes WHERE indexrelname = 'orders_pkey'");
      const r = await runCheck(ctx, indexes, {});
      if (!r.ok) throw new Error(r.message);
      expect(r.data.indexes.find((i) => i.name === 'public.orders_pkey')!.scans).toBeGreaterThan(0);
      // The matview and the other tables have none; the two primary keys and the three status indexes are five.
      expect(r.data.total).toBe(5);
    });
  }, 120_000);
});

/** Burn `n` transaction ids, each in its own transaction: one statement over a series burns one. */
async function burnXids(pool: pg.Pool, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await pool.query('SELECT pg_current_xact_id()');
}

describe('the edge cases the old checks paid for', () => {
  const DUPLICATES = [
    `CREATE TABLE w (
       c1 int, c2 int, c3 int, c4 int, c5 int,
       c6 int, c7 int, c8 int, c9 int, c10 int, c11 int,
       d text
     )`,
    'CREATE INDEX ix_c1      ON w (c1)',
    'CREATE INDEX ix_c1_copy ON w (c1)',
    'CREATE INDEX ix_c1_c2   ON w (c1, c2)',
    'CREATE INDEX ix_c11     ON w (c11)',
    'CREATE INDEX ix_hash_c1 ON w USING hash (c1)',
    'CREATE INDEX ix_d_pat   ON w (d text_pattern_ops)',
    'CREATE INDEX ix_d_c1    ON w (d, c1)',
    'CREATE INDEX ix_expr    ON w (lower(d))',
    'CREATE INDEX ix_expr2   ON w (upper(d), c1)',
    'CREATE INDEX ix_full_c3 ON w (c3)',
    'CREATE INDEX ix_part    ON w (c3, c4) WHERE c4 > 0',
    'CREATE UNIQUE INDEX ix_uniq_c5 ON w (c5)',
    'CREATE INDEX ix_c5_c6   ON w (c5, c6)',
    'CREATE UNIQUE INDEX ix_uniq_c7 ON w (c7)',
    'CREATE INDEX ix_plain_c7 ON w (c7)',
    'CREATE INDEX ix_c8_desc ON w (c8 DESC NULLS LAST)',
    'CREATE INDEX ix_c8_c9   ON w (c8, c9)',
    'CREATE INDEX ix_d_c     ON w (d COLLATE "C")',
  ];

  it('recommends a drop only where every clause of the comparison holds', async () => {
    await withPostgres(async (ctx, pool) => {
      for (const sql of DUPLICATES) await seed(pool, sql);
      const r = await runCheck(ctx, indexes, {});
      if (!r.ok) throw new Error(r.message);
      const pairs = r.data.indexes.filter((i) => i.duplicateOf !== null)
        .map((i) => `${i.name.split('.').pop()}<=${i.duplicateOf!.split('.').pop()}`).sort();
      // A genuine prefix duplicate, and an identical pair reported once and not in each direction.
      expect(pairs).toContain('ix_c1<=ix_c1_c2');
      expect(pairs.filter((p) => p.includes('ix_c1_copy'))).toEqual(['ix_c1_copy<=ix_c1']);
      // Column 1 is not a prefix of column 11; hash is not btree; text_pattern_ops is not the default class.
      expect(pairs).not.toContain('ix_c1<=ix_c11');
      expect(pairs.some((p) => p.includes('ix_hash_c1'))).toBe(false);
      expect(pairs).not.toContain('ix_d_pat<=ix_d_c1');
      // A partial index does not cover the rows it leaves out; two expression indexes share no column.
      expect(pairs).not.toContain('ix_full_c3<=ix_part');
      expect(pairs.some((p) => p.includes('ix_expr'))).toBe(false);
      // A unique index is never the one to drop, and can be the one that covers.
      expect(pairs.some((p) => p.startsWith('ix_uniq_c5<='))).toBe(false);
      expect(pairs).toContain('ix_plain_c7<=ix_uniq_c7');
      // An ordering or a collation the other index lacks is one the planner cannot get from it.
      expect(pairs.some((p) => p.startsWith('ix_c8_desc<='))).toBe(false);
      expect(pairs.some((p) => p.startsWith('ix_d_c<='))).toBe(false);
    });
  }, 120_000);

  it('never lists another session\'s temporary table, or its index', async () => {
    await withPostgres(async (ctx, pool) => {
      const holder = await pool.connect();
      try {
        await holder.query('CREATE TEMP TABLE tmp_probe (v int PRIMARY KEY)');
        const t = await runCheck(ctx, tables, {});
        const i = await runCheck(ctx, indexes, {});
        if (!t.ok || !i.ok) throw new Error('not read');
        expect(t.data.tables.map((x) => x.name)).toEqual([]);
        expect(i.data.indexes.map((x) => x.name)).toEqual([]);
      } finally {
        holder.release();
      }
    });
  }, 120_000);

  it('reads a table\'s transaction ID age from its TOAST relation when that is the older', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE toasty (id int PRIMARY KEY, blob text)');
      await seed(pool, "INSERT INTO toasty SELECT g, repeat('x', 10000) FROM generate_series(1, 50) g");
      await burnXids(pool, 20);
      await pool.query('VACUUM (FREEZE, PROCESS_TOAST false) toasty');
      const { rows } = await pool.query<{ heap: number; toast: number }>(`
        SELECT age(c.relfrozenxid) AS heap, age(t.relfrozenxid) AS toast
          FROM pg_class c JOIN pg_class t ON t.oid = c.reltoastrelid
         WHERE c.oid = 'public.toasty'::regclass`);
      // Guard the fixture: if the two ages did not diverge, a heap-only read would pass.
      expect(rows[0]!.toast).toBeGreaterThan(rows[0]!.heap);
      const r = await runCheck(ctx, tables, { relation: 'public.toasty' });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.tables[0]!.xidAge).toBe(rows[0]!.toast);
    });
  }, 120_000);
});
