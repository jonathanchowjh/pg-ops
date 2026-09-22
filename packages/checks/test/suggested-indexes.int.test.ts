import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runTool } from '../src/run.js';
import { TOOLS } from '../src/registry.js';
import { withPostgres } from './harness.js';

const SETUP = `
  CREATE TABLE orders (id bigserial PRIMARY KEY, status text, customer_id int);
  INSERT INTO orders (status, customer_id)
    SELECT (ARRAY['new','paid','shipped','void'])[1 + g % 4], g % 5000 FROM generate_series(1, 100000) g;
  ANALYZE orders;`;

describe('suggestedIndexes (#58, #63)', () => {
  it('plans the busiest shapes and groups them by the index they want', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      for (let i = 0; i < 3; i++) await pool.query('SELECT * FROM orders WHERE customer_id = $1', [i]);
      const r = await runTool(ctx, TOOLS.suggestedIndexes, { minMeanMs: 0, minCalls: 1 });
      if (!r.ok) throw new Error(r.message);
      expect(r.verdict).toBeNull();
      const idx = r.data.indexes.find((i) => i.columns.join() === 'customer_id');
      expect(idx?.queries.map((q) => q.query)).toEqual([expect.stringContaining('customer_id = $1')]);
      expect(idx?.statement).toBe('CREATE INDEX CONCURRENTLY ON "public"."orders" ("customer_id")');
      const shape = r.data.byQuery.find((q) => q.query.includes('customer_id = $1'));
      expect(shape).toMatchObject({ calls: 3, advice: [expect.objectContaining({ found: true })] });
    });
  }, 120_000);

  it('applies pgHero thresholds by default — 20 ms and 50 calls', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      await pool.query('SELECT * FROM orders WHERE customer_id = $1', [1]);
      const r = await runTool(ctx, TOOLS.suggestedIndexes, {});
      if (!r.ok) throw new Error(r.message);
      expect(r.data.byQuery.find((q) => q.query.includes('customer_id = $1'))).toBeUndefined();
      expect(r.data.examined).toBeGreaterThan(0);
    });
  }, 120_000);

  // The default-threshold test above cannot see the calls filter: its shape
  // also misses the 20 ms mean, so either filter alone excludes it.
  it('excludes a shape on calls alone', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      await pool.query('SELECT * FROM orders WHERE customer_id = $1', [1]);
      for (let i = 0; i < 2; i++) await pool.query('SELECT * FROM orders WHERE status = $1', ['x']);
      const r = await runTool(ctx, TOOLS.suggestedIndexes, { minMeanMs: 0, minCalls: 2 });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.byQuery.some((q) => q.query.includes('customer_id = $1'))).toBe(false);
      expect(r.data.byQuery.some((q) => q.query.includes('status = $1'))).toBe(true);
    });
  }, 120_000);

  // Every other test connects as a superuser, for whom nothing is redacted.
  // A monitoring role without pg_read_all_stats sees other roles' shapes as
  // `<insufficient privilege>` — cost intact, text gone — and there is no
  // statement there to plan.
  it('skips shapes Postgres redacted from this role', async () => {
    await withPostgres(async (ctx, pool) => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const owner = `si_owner_${suffix}`;
      const monitor = `si_monitor_${suffix}`;
      await pool.query(`CREATE ROLE ${owner} LOGIN PASSWORD 'owner_pw'`);
      await pool.query(`CREATE ROLE ${monitor} LOGIN PASSWORD 'monitor_pw'`);
      const base = new URL((pool as unknown as { options: { connectionString: string } }).options.connectionString);
      try {
        const as = (user: string, password: string) => {
          const uri = new URL(base);
          uri.username = user;
          uri.password = password;
          return uri.toString();
        };
        const ownerClient = new pg.Client({ connectionString: as(owner, 'owner_pw') });
        await ownerClient.connect();
        try {
          await ownerClient.query('SELECT 424242 AS si_marker');
        } finally {
          await ownerClient.end();
        }
        const monitorPool = new pg.Pool({ connectionString: as(monitor, 'monitor_pw'), max: 1 });
        try {
          const r = await runTool({ target: monitorPool, serverVersion: ctx.serverVersion },
            TOOLS.suggestedIndexes, { minMeanMs: 0, minCalls: 1 });
          if (!r.ok) throw new Error(r.message);
          expect(r.data.examined).toBeGreaterThan(0);
          expect(r.data.byQuery.some((q) => q.query === '<insufficient privilege>')).toBe(false);
        } finally {
          await monitorPool.end();
        }
      } finally {
        await pool.query(`DROP ROLE ${owner}`);
        await pool.query(`DROP ROLE ${monitor}`);
      }
    });
  }, 120_000);

  it('records a shape that cannot be planned instead of failing the page', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      await pool.query("SET application_name = 'pgops-test'");
      await pool.query('SELECT * FROM orders WHERE customer_id = $1', [1]);
      const r = await runTool(ctx, TOOLS.suggestedIndexes, { minMeanMs: 0, minCalls: 1 });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.byQuery.find((q) => q.query.startsWith('SET'))).toMatchObject({ error: expect.any(String), advice: [] });
      // …and the shapes after it still carry their own advice, not a neighbour's.
      expect(r.data.byQuery.find((q) => q.query.includes('customer_id = $1'))?.advice[0])
        .toMatchObject({ table: 'orders', found: true });
    });
  }, 120_000);

  it('names the missing extension and the statement that installs it', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('DROP EXTENSION pg_stat_statements');
      const r = await runTool(ctx, TOOLS.suggestedIndexes, {});
      expect(r).toMatchObject({ ok: false, reason: 'missing-extension', remedy: 'CREATE EXTENSION pg_stat_statements;' });
    });
  }, 120_000);
});
