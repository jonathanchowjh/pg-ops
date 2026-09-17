import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { invalidConstraints } from '../src/checks/constraints.js';
import { withPostgres, seed } from './harness.js';

describe('invalidConstraints against a real server', () => {
  it('finds a NOT VALID check and a NOT VALID foreign key, and misses validated ones', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE parent (id int PRIMARY KEY)');
      await seed(pool, 'CREATE TABLE child (id int PRIMARY KEY, parent_id int, n int)');
      await seed(pool, 'ALTER TABLE child ADD CONSTRAINT child_n_positive CHECK (n > 0) NOT VALID');
      await seed(pool, 'ALTER TABLE child ADD CONSTRAINT child_fk FOREIGN KEY (parent_id) REFERENCES parent(id) NOT VALID');
      await seed(pool, 'ALTER TABLE child ADD CONSTRAINT child_n_small CHECK (n < 1000)');

      const result = await runCheck(ctx, invalidConstraints, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.constraints.map((c) => c.name);
      expect(names).toContain('child_n_positive');
      expect(names).toContain('child_fk');
      expect(names).not.toContain('child_n_small');
      expect(result.verdict?.level).toBe('warn');
      expect(result.data.constraints[0]!.definition).toContain('NOT VALID');
    });
  });

  it('reports the true count in the verdict when the list is capped', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (a int, b int, c int)');
      await seed(pool, 'ALTER TABLE t ADD CONSTRAINT c_a CHECK (a > 0) NOT VALID');
      await seed(pool, 'ALTER TABLE t ADD CONSTRAINT c_b CHECK (b > 0) NOT VALID');
      await seed(pool, 'ALTER TABLE t ADD CONSTRAINT c_c CHECK (c > 0) NOT VALID');

      const result = await runCheck(ctx, invalidConstraints, { limit: 1 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.constraints).toHaveLength(1);
      expect(result.data.total).toBe(3);
      expect(result.data.truncated).toBe(true);
      expect(result.verdict?.note).toContain('3');
    });
  });

  /**
   * The clause this check does NOT have, pinned so nobody adds it back.
   *
   * `AND c.contype IN ('c', 'f')` is the obvious filter and was in the plan.
   * PostgreSQL 18 catalogues NOT NULL as a constraint with `contype = 'n'`
   * and lets it be added `NOT VALID`, so that allowlist turns a half-built
   * NOT NULL into an empty panel. Verified by hand on 18.6 before this test
   * was written; the CI matrix runs 18, which is where the second half of
   * this assertion actually executes. Below 18 the syntax does not parse, so
   * the version gate is the test, not a convenience.
   */
  it('catches an unvalidated constraint whose contype is neither check nor foreign key', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (v int)');
      await seed(pool, 'ALTER TABLE t ADD CONSTRAINT t_v_pos CHECK (v > 0) NOT VALID');
      const catalogued = ctx.serverVersion >= 180000;
      if (catalogued) {
        await seed(pool, 'ALTER TABLE t ADD CONSTRAINT t_v_nn NOT NULL v NOT VALID');
      }

      const result = await runCheck(ctx, invalidConstraints, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.constraints.map((c) => c.name);
      expect(names).toContain('t_v_pos');
      if (catalogued) {
        expect(names).toContain('t_v_nn');
        expect(result.data.constraints.find((c) => c.name === 't_v_nn')!.definition)
          .toContain('NOT VALID');
      }
      expect(result.data.total).toBe(catalogued ? 2 : 1);
    });
  });

  /**
   * A constraint name is unique per TABLE, not per database, so the name
   * alone cannot identify a finding and cannot order one either. Both halves
   * matter: the page needs the qualified table to tell the two rows apart,
   * and the cap needs a deterministic order or `LIMIT 1` over a tie returns
   * whichever row the executor happened to produce first.
   */
  it('qualifies the table, and orders stably when two schemas share a constraint name', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE SCHEMA other');
      await seed(pool, 'CREATE TABLE public.child (n int)');
      await seed(pool, 'CREATE TABLE other.child (n int)');
      await seed(pool, 'ALTER TABLE public.child ADD CONSTRAINT child_n_positive CHECK (n > 0) NOT VALID');
      await seed(pool, 'ALTER TABLE other.child ADD CONSTRAINT child_n_positive CHECK (n > 0) NOT VALID');

      const all = await runCheck(ctx, invalidConstraints, {});
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.data.constraints.map((c) => c.table)).toEqual(['other.child', 'public.child']);

      const capped = await runCheck(ctx, invalidConstraints, { limit: 1 });
      expect(capped.ok).toBe(true);
      if (!capped.ok) return;
      expect(capped.data.constraints[0]!.table).toBe('other.child');
      expect(capped.data.total).toBe(2);
    });
  });

  /**
   * Another session's TEMP table is not this operator's problem.
   *
   * A temporary table lives in a `pg_temp_N` schema, but its `pg_class` and
   * `pg_constraint` rows are ordinary catalog rows visible to EVERY session
   * in the database — so without the schema filter a half-built constraint
   * on someone else's scratch table lands on the page, named for a schema
   * the reader cannot even reach. The client is held open across the check
   * because the temp schema is torn down when its session ends.
   */
  it('ignores an unvalidated constraint on another session\'s temporary table', async () => {
    await withPostgres(async (ctx, pool) => {
      const holder = await pool.connect();
      try {
        await holder.query('CREATE TEMP TABLE scratch (v int)');
        await holder.query('ALTER TABLE scratch ADD CONSTRAINT scratch_v_pos CHECK (v > 0) NOT VALID');

        // The row really is visible from outside that session; otherwise this
        // test would pass for the wrong reason.
        const { rows } = await pool.query<{ nspname: string }>(
          `SELECT n.nspname FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE c.conname = 'scratch_v_pos'`);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.nspname).toMatch(/^pg_temp/);

        const result = await runCheck(ctx, invalidConstraints, {});
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.constraints).toEqual([]);
        expect(result.data.total).toBe(0);
      } finally {
        holder.release();
      }
    });
  });

  it('is ok on a database with nothing unvalidated', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, invalidConstraints, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.verdict).toEqual({ level: 'ok' });
    });
  });
});
