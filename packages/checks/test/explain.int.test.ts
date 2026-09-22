import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { checkStatement, planStatements, MAX_STATEMENT_LENGTH } from '../src/tools/explain.js';
import { withPostgres } from './harness.js';

const SETUP = `
  CREATE TABLE orders (id bigserial PRIMARY KEY, status text, customer_id int, email text);
  INSERT INTO orders (status, customer_id, email)
    SELECT (ARRAY['new','paid','shipped','void'])[1 + g % 4], g % 5000, 'u' || g || '@x'
    FROM generate_series(1, 20000) g;
  ANALYZE orders;`;

describe('planStatements', () => {
  it('plans a literal statement and names the schema', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      const [p] = await planStatements(ctx, ["SELECT * FROM orders WHERE status = 'paid'"]);
      if (!p!.ok) throw new Error(p!.message);
      expect(p!.plan).toMatchObject({ 'Node Type': 'Seq Scan', 'Relation Name': 'orders', Schema: 'public' });
      expect(p!.parameters).toBe(0);
    });
  }, 120_000);

  it('plans a normalized statement generically, on every supported version', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      const [p] = await planStatements(ctx, ['SELECT * FROM orders WHERE status = $1 AND customer_id = $2']);
      if (!p!.ok) throw new Error(p!.message);
      expect(p!.parameters).toBe(2);
      // A custom plan with NULLs bound folds to `One-Time Filter: false` —
      // Verified fact 2 in the P6 plan. A generic plan keeps the placeholders.
      expect(JSON.stringify(p!.plan)).toContain('$1');
      expect(JSON.stringify(p!.plan)).not.toContain('One-Time Filter');
    });
  }, 120_000);

  it('refuses a second statement, and the second statement never runs', async () => {
    await withPostgres(async (ctx, pool) => {
      const [p] = await planStatements(ctx, ['SELECT 1; CREATE TABLE evil (a int)']);
      expect(p).toMatchObject({ ok: false, code: '42601' });
      const { rows } = await pool.query("SELECT to_regclass('evil') AS r");
      expect(rows[0].r).toBeNull();
    });
  }, 120_000);

  it('plans a write without performing it', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      const [p] = await planStatements(ctx, ["INSERT INTO orders (status) VALUES ('x')"]);
      expect(p).toMatchObject({ ok: true, plan: { 'Node Type': 'ModifyTable' } });
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM orders WHERE status = 'x'");
      expect(rows[0].n).toBe(0);
    });
  }, 120_000);

  it('refuses a utility statement', async () => {
    await withPostgres(async (ctx) => {
      const [p] = await planStatements(ctx, ['VACUUM']);
      expect(p).toMatchObject({ ok: false, code: '42601' });
    });
  }, 120_000);

  it('passes structural errors through and withholds the rest', async () => {
    await withPostgres(async (ctx) => {
      const [missing, leaky] = await planStatements(ctx, ['SELECT * FROM nope', "SELECT '42x'::int"]);
      expect(missing).toMatchObject({ ok: false, code: '42P01', message: expect.stringContaining('nope') });
      // 22P02's message echoes the value it choked on — the data-extraction
      // route pgHero's generic "Error explaining query" exists to close.
      expect(leaky).toEqual({
        ok: false, code: '22P02', message: 'Postgres could not plan this statement (SQLSTATE 22P02).',
      });
    });
  }, 120_000);

  it('keeps planning after one statement fails', async () => {
    await withPostgres(async (ctx) => {
      const r = await planStatements(ctx, ['SELECT * FROM nope', 'SELECT 1']);
      expect(r.map((p) => p.ok)).toEqual([false, true]);
    });
  }, 120_000);

  /**
   * PREPARE takes an AccessShareLock on every relation it names, so a
   * migration holding ACCESS EXCLUSIVE makes it wait. Under statement_timeout
   * alone that wait was 10s — per shape, so the suggestions page took minutes
   * whenever a busy table was being altered. Measured before the fix.
   */
  it('gives up quickly on a locked table, and says why', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE orders IN ACCESS EXCLUSIVE MODE');
        const started = Date.now();
        const [locked, free] = await planStatements(ctx, ['SELECT * FROM orders', 'SELECT 1']);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(locked).toMatchObject({ ok: false, code: '55P03', message: expect.stringContaining('lock timeout') });
        expect(free!.ok).toBe(true);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });
  }, 120_000);

  /**
   * EXPLAIN checks SELECT on every table it names, though it reads no rows —
   * so the README's least-privilege role (pg_read_all_stats) is refused on
   * every application table. Postgres's message names the table but not the
   * fix, and the operator is looking at a planning tool, not a permissions one.
   */
  it('says which privilege planning needs when the role lacks it', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query(SETUP);
      const monitor = `ex_monitor_${Math.random().toString(36).slice(2, 10)}`;
      await pool.query(`CREATE ROLE ${monitor} LOGIN PASSWORD 'monitor_pw' IN ROLE pg_read_all_stats`);
      const uri = new URL((ctx.target as pg.Pool).options.connectionString!);
      uri.username = monitor;
      uri.password = 'monitor_pw';
      const monitorPool = new pg.Pool({ connectionString: uri.toString(), max: 1 });
      try {
        const [p] = await planStatements({ ...ctx, target: monitorPool }, ['SELECT * FROM orders WHERE email = $1']);
        expect(p).toMatchObject({ ok: false, code: '42501' });
        const message = (p as { message: string }).message;
        expect(message).toContain('permission denied for table orders');
        expect(message).toContain('the pgops role needs SELECT on those tables');
      } finally {
        await monitorPool.end();
        await pool.query(`DROP ROLE ${monitor}`);
      }
    });
  }, 120_000);

  it('destroys the connection it planned on, prepared statements and all', async () => {
    await withPostgres(async (ctx) => {
      // max: 1, so the next query either reuses the planning connection (and
      // sees its prepared statements) or gets a fresh one (and sees none).
      const one = new pg.Pool({ connectionString: (ctx.target as pg.Pool).options.connectionString, max: 1 });
      try {
        await planStatements({ ...ctx, target: one }, ['SELECT 1']);
        const { rows } = await one.query('SELECT count(*)::int AS n FROM pg_prepared_statements');
        expect(rows[0].n).toBe(0);
      } finally {
        await one.end();
      }
    });
  }, 120_000);

  /**
   * A fake client that records every query and fails at PREPARE — past BEGIN,
   * inside the per-statement try, which is the only place the rethrow guard
   * lives. (A fake that failed at BEGIN never reached it; that mutation
   * survived.)
   */
  function recordingClient(prepare: () => Promise<never> | Promise<unknown>) {
    const sent: unknown[] = [];
    let released: unknown = 'not released';
    const client = {
      on: () => {}, removeListener: () => {},
      release: (err?: unknown) => { released = err; },
      query: async (q: unknown) => {
        sent.push(q);
        if (typeof q === 'object') return prepare();
        if (typeof q === 'string' && q.startsWith('SELECT cardinality')) return { rows: [{ n: 0 }] };
        if (typeof q === 'string' && q.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result' } }] }] };
        return { rows: [] };
      },
    };
    return { sent, released: () => released, ctx: { target: { connect: async () => client } as never, serverVersion: 170000 } };
  }

  it('rejects the batch when the failure is not a Postgres error, and destroys the connection', async () => {
    const r = recordingClient(async () => { throw new Error('Connection terminated unexpectedly'); });
    await expect(planStatements(r.ctx, ['SELECT 1'])).rejects.toThrow('Connection terminated');
    expect(r.released()).toBeInstanceOf(Error);
  });

  /**
   * READ ONLY is defence in depth: nothing here executes the statement, so no
   * real-database test can observe the difference, and deleting it passed the
   * whole suite. A redundant layer has to be tested directly, not through the
   * layer that makes it redundant — so this reads the transcript.
   */
  it('sends every statement inside a read-only transaction it always rolls back', async () => {
    const r = recordingClient(async () => ({ rows: [] }));
    await planStatements(r.ctx, ['SELECT 1', 'SELECT 2']);
    const strings = r.sent.filter((q): q is string => typeof q === 'string');
    expect(strings.filter((q) => q === 'BEGIN READ ONLY')).toHaveLength(2);
    expect(strings.filter((q) => q === 'ROLLBACK')).toHaveLength(2);
    expect(strings.some((q) => /^(BEGIN|START)(?! READ ONLY)/.test(q) || q === 'COMMIT')).toBe(false);
    expect(r.sent.filter((q) => typeof q === 'object')).toEqual([
      expect.objectContaining({ name: 'pgops_prepare_0' }), expect.objectContaining({ name: 'pgops_prepare_1' }),
    ]);
    expect(r.released()).toBeInstanceOf(Error);
  });

  it('opens no connection for an empty batch', async () => {
    const ctx = { target: { connect: () => { throw new Error('connected'); } } as never, serverVersion: 170000 };
    await expect(planStatements(ctx, [])).resolves.toEqual([]);
  });
});

describe('checkStatement', () => {
  it('trims, and refuses empty or oversized input', () => {
    expect(checkStatement('  SELECT 1  ')).toBe('SELECT 1');
    expect(() => checkStatement('   ')).toThrow(/empty/);
    expect(() => checkStatement('x'.repeat(MAX_STATEMENT_LENGTH + 1))).toThrow(/limit/);
  });
});
