import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { autovacuumDanger, vacuumProgress } from '../src/checks/maintenance.js';
import { withPostgres, seed } from './harness.js';

/**
 * Burn `n` transaction ids, each in its own transaction.
 *
 * A single `SELECT pg_current_xact_id() FROM generate_series(1, n)` consumes
 * exactly ONE xid — the whole statement is one transaction — which is how the
 * first draft of the TOAST fixture below ended up with a one-transaction gap
 * it was trying to make large. Separate round trips are the point.
 */
async function burnXids(pool: pg.Pool, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await pool.query('SELECT pg_current_xact_id()');
}

/**
 * A URI for a SIBLING database on the same cluster.
 *
 * `withPostgres` isolates by database, not by cluster, and hands out a pool
 * rather than a URI — the pool keeps the string it was built with, which is
 * the only place the per-test database name exists. Same trick as
 * `sequences.int.test.ts`'s `asRole`, one field over.
 */
function asDatabase(pool: pg.Pool, database: string): string {
  const base = (pool as unknown as { options: { connectionString?: string } })
    .options.connectionString;
  if (!base) throw new Error('harness pool was not built from a connection string');
  const uri = new URL(base);
  uri.pathname = `/${database}`;
  return uri.toString();
}

/** Poll until `sql` reports ready, or fail loudly rather than hang the suite. */
async function until(client: pg.Client, what: string, sql: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await client.query<{ ready: boolean }>(sql);
    if (rows[0]?.ready === true) return;
    if (Date.now() > deadline) throw new Error(`${what} not observed within 20s`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('maintenance against a real server', () => {
  /**
   * §6: pg_stat_progress_vacuum is empty unless a vacuum is running. Empty
   * must be `ok` with zero rows — NOT a failure. A regression to ok:false
   * would make the page say "we could not look" on every healthy database,
   * the inverse of the honesty rule.
   */
  it('reports no running vacuum as an empty list rather than a failure', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, vacuumProgress);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.vacuums).toEqual([]);
      expect(result.verdict).toBeNull();
    });
  });

  it('finds user tables and matviews, excluding catalog, toast and partitioned parents', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, `
        CREATE TABLE maint_fixture (id int PRIMARY KEY);
        CREATE TABLE part_parent (id int, d date) PARTITION BY RANGE (d);
        CREATE TABLE part_child PARTITION OF part_parent
          FOR VALUES FROM ('2020-01-01') TO ('2030-01-01');
        CREATE MATERIALIZED VIEW maint_mv AS SELECT 1 AS x;
      `);

      const result = await runCheck(ctx, autovacuumDanger, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.relations.map((t) => t.relation);
      expect(names).toContain('public.maint_fixture');
      // The partitioned PARENT has relfrozenxid 0 and would report
      // txnsRemaining 0 — a permanent false alarm at the top of the page.
      expect(names).not.toContain('public.part_parent');
      expect(names.some((n) => n.startsWith('pg_'))).toBe(false);
      // A real child partition has storage and does belong.
      expect(names).toContain('public.part_child');
      // A matview has storage too, and pgHero's own relkind = 'r' misses it.
      expect(names).toContain('public.maint_mv');
    });
  });

  /**
   * The one assertion that catches the constant this check is calibrated on.
   *
   * pgHero's `autovacuum_danger` counts down from `autovacuum_freeze_max_age`
   * (200,000,000 by default) — a routine maintenance trigger, not the horizon.
   * `wraparound.ts`'s A1 note is the argument for not doing that. Against the
   * real 2^31-1 horizon a freshly created table has essentially all of it
   * left; against pgHero's constant it would read ~200,000,000, and this test
   * is what tells the two apart.
   */
  it('counts down from the 2^31 horizon, not from autovacuum_freeze_max_age', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id int PRIMARY KEY);');

      const result = await runCheck(ctx, autovacuumDanger, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.relations.find((x) => x.relation === 'public.t');
      expect(row).toBeDefined();
      expect(row!.xactAge).toBeLessThan(10_000);
      expect(row!.txnsRemaining).toBeGreaterThan(2_147_000_000);
      expect(row!.xactAge + row!.txnsRemaining).toBe(2_147_483_647);
    });
  });

  /**
   * A table's TOAST relation holds back an xid of its own, and pgHero reads
   * `GREATEST(age(c.relfrozenxid), age(t.relfrozenxid))` for exactly that
   * reason. `VACUUM (FREEZE, PROCESS_TOAST false)` — PG 14+, the CI floor —
   * freezes the heap and leaves the TOAST behind, which is the only way to
   * drive the two apart on demand. Read the heap alone and this table reports
   * age 0: fully frozen, nothing to do, while its TOAST is the oldest thing
   * in the database.
   */
  it('reads the TOAST relation age, not just the heap', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE toasty (id int PRIMARY KEY, blob text);');
      await seed(pool, "INSERT INTO toasty SELECT g, repeat('x', 10000) FROM generate_series(1, 50) g");
      await burnXids(pool, 20);
      await pool.query('VACUUM (FREEZE, PROCESS_TOAST false) toasty');

      const { rows } = await pool.query<{ heap: number; toast: number }>(`
        SELECT age(c.relfrozenxid) AS heap, age(t.relfrozenxid) AS toast
        FROM pg_class c JOIN pg_class t ON t.oid = c.reltoastrelid
        WHERE c.oid = 'public.toasty'::regclass`);
      const { heap, toast } = rows[0]!;
      // Guard the fixture itself: if the freeze did not diverge the two, the
      // assertion below would pass against a heap-only query.
      expect(toast).toBeGreaterThan(heap);

      const result = await runCheck(ctx, autovacuumDanger, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.relations.find((x) => x.relation === 'public.toasty');
      expect(row).toBeDefined();
      expect(row!.xactAge).toBe(toast);
    });
  });

  /**
   * `pg_stat_progress_vacuum` is CLUSTER-wide, and every other check in this
   * package is database-scoped by construction. Without
   * `datname = current_database()` a vacuum running in a neighbouring
   * database renders on this database's page, naming a relation that does not
   * exist here.
   *
   * The filter survived mutation until this test existed, because a test that
   * only ever looks at an idle cluster cannot tell a filter from its absence.
   * Reaching it needs a vacuum that is genuinely running somewhere else while
   * we look: `vacuum_cost_delay = 100` with `vacuum_cost_limit = 1` throttles
   * a manual VACUUM to roughly ten pages a second, which turns a 20 MB table
   * into minutes of observable work.
   */
  it('shows only this database\'s vacuums, though the view is cluster-wide', async () => {
    await withPostgres(async (ctx, pool) => {
      const neighbour = `t_nb_${Math.random().toString(36).slice(2, 10)}`;
      await pool.query(`CREATE DATABASE ${neighbour}`);
      const vacuumer = new pg.Client({ connectionString: asDatabase(pool, neighbour) });
      let running: Promise<unknown> = Promise.resolve();
      try {
        await vacuumer.connect();
        await vacuumer.query('CREATE TABLE slowvac (id int, pad text)');
        await vacuumer.query(
          "INSERT INTO slowvac SELECT g, repeat('y', 500) FROM generate_series(1, 40000) g");
        await vacuumer.query('DELETE FROM slowvac WHERE id % 2 = 0');
        await vacuumer.query('SET vacuum_cost_delay = 100');
        await vacuumer.query('SET vacuum_cost_limit = 1');
        running = vacuumer.query('VACUUM slowvac').catch(() => undefined);

        // Guard the fixture: without a vacuum visible from HERE, the
        // assertion below would pass against no filter at all.
        const observer = await pool.connect();
        try {
          await until(observer as unknown as pg.Client, "the neighbour's vacuum",
            'SELECT count(*) > 0 AS ready FROM pg_stat_progress_vacuum');

          const result = await runCheck(ctx, vacuumProgress);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.data.vacuums).toEqual([]);
        } finally {
          observer.release();
        }
      } finally {
        await pool.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
          [neighbour]).catch(() => undefined);
        await running;
        await vacuumer.end().catch(() => undefined);
        await pool.query(`DROP DATABASE IF EXISTS ${neighbour}`);
      }
    });
  });

  /**
   * The cap must drop the relations that are keeping up, not the ones that
   * are behind — so the ORDER BY direction is part of what the cap means.
   * Each table is created in its own transaction with xids burned between,
   * so the three ages are strictly ordered rather than tied on one xid.
   */
  it('caps to the oldest relations and reports the true total behind the cap', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE cap_a (id int)');
      await burnXids(pool, 5);
      await seed(pool, 'CREATE TABLE cap_b (id int)');
      await burnXids(pool, 5);
      await seed(pool, 'CREATE TABLE cap_c (id int)');

      const result = await runCheck(ctx, autovacuumDanger, { limit: 2 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.relations.map((r) => r.relation))
        .toEqual(['public.cap_a', 'public.cap_b']);
      expect(result.data.total).toBe(3);
      expect(result.data.truncated).toBe(true);
    });
  });

  it('reports transaction age for one relation', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE a (v int)');
      await seed(pool, 'CREATE TABLE b (v int)');

      const out = await runCheck(ctx, autovacuumDanger, { relation: 'public.a' });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.data.relations.map((r) => r.relation)).toEqual(['public.a']);
      expect(out.data.total).toBe(1);
    });
  });
});
