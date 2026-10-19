import { describe, expect, it } from 'vitest';
import { runTool } from '../src/run.js';
import { TOOLS } from '../src/registry.js';
import { adviseOn } from '../src/tools/advice.js';
import type { PlanNode } from '../src/tools/explain.js';
import { withPostgres } from './harness.js';

const SETUP = `
  CREATE TABLE orders (id bigserial PRIMARY KEY, status text, customer_id int, email text);
  INSERT INTO orders (status, customer_id, email)
    SELECT (ARRAY['new','paid','shipped','void'])[1 + g % 4], g % 5000, 'u' || g || '@x'
    FROM generate_series(1, 100000) g;
  CREATE TABLE customers (id int PRIMARY KEY, region text);
  INSERT INTO customers SELECT g, 'r' || (g % 20) FROM generate_series(1, 5000) g;
  CREATE TABLE tiny (id int, v text);
  INSERT INTO tiny SELECT g, 'x' FROM generate_series(1, 10) g;
  ANALYZE;`;

const seqScan = (schema: string, filter: string): PlanNode => ({
  'Node Type': 'Seq Scan', 'Relation Name': 'orders', Schema: schema, Alias: 'orders', Filter: filter,
});

describe('the explain tool (#57, #64)', () => {
  it('returns the plan and suggests the index a slow lookup needs', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      const r = await runTool(ctx, TOOLS.explain, { sql: "SELECT * FROM orders WHERE customer_id = 42 AND status = 'paid'" });
      if (!r.ok) throw new Error(r.message);
      expect(r.verdict).toBeNull();
      expect(JSON.stringify(r.data.plan)).toContain('Seq Scan');
      expect(r.data.advice).toEqual([expect.objectContaining({
        table: 'orders', found: true, suggestion: expect.objectContaining({ columns: ['customer_id'] }),
      })]);
    });
  }, 120_000);

  it('advises on each side of a join — pgHero answers "JOIN not supported yet"', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      const r = await runTool(ctx, TOOLS.explain, {
        sql: "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.region = 'r3' AND o.status = 'new'",
      });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.advice.map((a) => a.table).sort()).toEqual(['customers', 'orders']);
    });
  }, 120_000);

  it('plans a normalized shape and still advises', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      const r = await runTool(ctx, TOOLS.explain, { sql: 'SELECT * FROM orders WHERE customer_id = $1' });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.parameters).toBe(1);
      expect(r.data.advice[0]?.suggestion?.columns).toEqual(['customer_id']);
    });
  }, 120_000);

  it('offers no advice once an index already serves the statement', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      await pool.query('CREATE INDEX ON orders (customer_id)');
      await pool.query('ANALYZE orders');
      const r = await runTool(ctx, TOOLS.explain, { sql: 'SELECT * FROM orders WHERE customer_id = 42' });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.advice).toEqual([]);
    });
  }, 120_000);

  it('explains a small table instead of suggesting', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      const r = await runTool(ctx, TOOLS.explain, { sql: "SELECT * FROM tiny WHERE v = 'x'" });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.advice[0]).toMatchObject({ found: false, explanation: 'No index needed if less than 500 rows' });
    });
  }, 120_000);

  it('turns a planning error into a failed result', async () => {
    await withPostgres(async (ctx) => {
      const r = await runTool(ctx, TOOLS.explain, { sql: 'SELECT * FROM nope' });
      expect(r).toMatchObject({ ok: false, reason: 'error', message: expect.stringContaining('nope') });
    });
  }, 120_000);

  it('refuses an empty statement without connecting', async () => {
    const ctx = { target: { connect: () => { throw new Error('connected'); } } as never, serverVersion: 170000 };
    expect(await runTool(ctx, TOOLS.explain, { sql: '  ' })).toMatchObject({ ok: false, message: expect.stringMatching(/empty/) });
  });
});

describe('adviseOn', () => {
  it('reads the opclass the per-column indexdef omits, and never covers with a partial index', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await pool.query('CREATE INDEX orders_email_trgm ON orders USING gist (email gist_trgm_ops)');
      await pool.query("CREATE INDEX orders_status_partial ON orders (status) WHERE status = 'void'");
      const advice = await adviseOn(ctx, [
        seqScan('public', "(orders.email ~~ '%x%'::text)"),
        seqScan('public', "(orders.status = 'new'::text)"),
      ]);
      const like = advice[0]![0];
      const eq = advice[1]![0];
      expect(like).toMatchObject({ found: true, coveredBy: 'orders_email_trgm' });
      expect(eq).toMatchObject({ found: true });
      expect(eq!.coveredBy).toBeUndefined();
    });
  }, 120_000);

  it('never covers with an invalid index', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      await pool.query('CREATE INDEX orders_status_idx ON orders (status)');
      await pool.query("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'orders_status_idx'::regclass");
      const eq = (await adviseOn(ctx, [seqScan('public', "(orders.status = 'new'::text)")]))[0]![0];
      expect(eq!.coveredBy).toBeUndefined();
    });
  }, 120_000);

  it('keeps two schemas apart', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      // `other.orders` holds rows and stats too, so a lookup that ignored the
      // schema would find something for it rather than nothing.
      await pool.query(`CREATE SCHEMA other;
        CREATE TABLE other.orders (status text);
        INSERT INTO other.orders SELECT 'x' FROM generate_series(1, 700);
        ANALYZE other.orders;`);
      const advice = await adviseOn(ctx, [
        seqScan('public', "(orders.status = 'x'::text)"), seqScan('other', "(orders.status = 'x'::text)"),
      ]);
      const pub = advice[0]![0];
      const oth = advice[1]![0];
      expect(pub!.rows).toBe(100_000);
      expect(oth!.rows).toBe(700);
    });
  }, 120_000);

  it('reads a parent table\'s own statistics, not its inheritance tree\'s', async () => {
    await withPostgres(async (ctx, pool) => {
      // The parent holds 1,000 rows over 2 statuses; its child 50,000 over
      // 5,000. ANALYZE on a parent writes both an inherited=false row (the
      // parent alone — what a Seq Scan on it reads) and an inherited=true row
      // (the whole tree) per column.
      await pool.query(`CREATE TABLE parent (status text);
        CREATE TABLE child () INHERITS (parent);
        INSERT INTO parent SELECT 's' || (g % 2) FROM generate_series(1, 1000) g;
        INSERT INTO child SELECT 'c' || (g % 5000) FROM generate_series(1, 50000) g;
        ANALYZE parent; ANALYZE child;`);
      const plan: PlanNode = { 'Node Type': 'Seq Scan', 'Relation Name': 'parent', Schema: 'public', Alias: 'parent',
        Filter: "(parent.status = 'x'::text)" };
      const got = (await adviseOn(ctx, [plan]))[0]![0]!;
      expect(got.rowEstimates).toEqual({ 'status (=)': 500 });
    });
  }, 120_000);

  it('reads nothing when no plan scans a relation', async () => {
    const ctx = { target: { query: () => { throw new Error('queried'); } } as never, serverVersion: 170000 };
    await expect(adviseOn(ctx, [{ 'Node Type': 'Result' }])).resolves.toEqual([[]]);
  });
});
