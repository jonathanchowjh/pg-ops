import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeTables } from '../src/actions/analyze.js';
import { defaultAuditPath } from '../src/actions/audit.js';
import { withPostgres } from './harness.js';

describe('analyzeTables', () => {
  it('analyzes the tables it found and reports each one', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE TABLE IF NOT EXISTS analyze_me (a int)');
      await pool.query('INSERT INTO analyze_me SELECT generate_series(1, 100)');

      const results = await analyzeTables(ctx, { subcommand: 'test', reason: 'freshening' },
        { limit: 200 });

      const mine = results.find((r) => r.relation.includes('analyze_me'));
      expect(mine).toBeDefined();
      expect(mine!.ok).toBe(true);

      // The observable effect, not merely the return value.
      const { rows } = await pool.query<{ t: Date | null }>(
        `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'analyze_me'`);
      expect(rows[0]!.t).not.toBeNull();
    });
  }, 120_000);

  /**
   * The identifier never passes through an escaping function because it never
   * comes from a caller — the catalog emits it already quoted. A schema and a
   * table named to break a naive interpolation prove the mechanism rather
   * than the intent.
   */
  it('handles identifiers that would break string interpolation', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE SCHEMA IF NOT EXISTS "we;ird"');
      await pool.query('CREATE TABLE IF NOT EXISTS "we;ird"."tab""le" (a int)');

      const results = await analyzeTables(ctx, { subcommand: 'test', reason: 'hostile names' },
        { limit: 500 });

      const mine = results.find((r) => r.relation.includes('tab'));
      expect(mine).toBeDefined();
      expect(mine!.ok).toBe(true);
      expect(mine!.error).toBeUndefined();
    });
  }, 120_000);

  /**
   * §5.1's spirit applied to a write: a request handler must not issue one
   * statement per relation in an unbounded catalog.
   */
  it('stops at the cap the caller set', async () => {
    await withPostgres(async (ctx, pool) => {
      for (let i = 0; i < 5; i += 1) {
        await pool.query(`CREATE TABLE IF NOT EXISTS capped_${i} (a int)`);
      }
      const results = await analyzeTables(ctx,
        { subcommand: 'test', reason: 'capped' }, { limit: 2 });
      expect(results).toHaveLength(2);
    });
  }, 120_000);

  /**
   * Another session's temp tables are NOT in scope, and pgHero's version has
   * this hole: `analyze_tables` rejects only information_schema and
   * pg_catalog, which lets every pg_temp_N schema through. visibleSchemas()
   * exists in this repo because that was found once already, verified on
   * 17.11 — an unrelated session's CREATE TEMP TABLE reads back as
   * pg_temp_29.tmp_probe from elsewhere.
   */
  it('never reaches into a temp schema', async () => {
    await withPostgres(async (ctx, pool) => {
      // A temp table on a connection we hold open, so it is live and visible
      // in pg_class to other sessions while the assertion runs.
      const holder = await pool.connect();
      try {
        await holder.query('CREATE TEMP TABLE tmp_probe (a int)');
        const { rows } = await holder.query<{ schema: string }>(
          `SELECT n.nspname AS schema FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = 'tmp_probe'`);
        expect(rows[0]!.schema).toMatch(/^pg_temp/);

        const results = await analyzeTables(ctx,
          { subcommand: 'test', reason: 'temp scope' }, { limit: 500 });

        expect(results.some((r) => r.relation.includes('tmp_probe'))).toBe(false);
        expect(results.some((r) => r.relation.includes('pg_temp'))).toBe(false);
      } finally {
        holder.release();
      }
    });
  }, 120_000);

  /**
   * One table failing does not abandon the rest, and the failure is reported
   * on its own row rather than thrown. Staged with an ACCESS EXCLUSIVE lock,
   * which is the realistic cause: ANALYZE needs a share-update-exclusive lock
   * and cannot get one.
   *
   * `lockTimeoutMs` is lowered to keep the suite quick. The PRODUCTION
   * default stays at pgHero's 5s — a test is not a reason to make an operator
   * wait less for a lock.
   */
  it('records a failure on its own row and keeps going', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE TABLE IF NOT EXISTS blocked_tbl (a int)');
      await pool.query('CREATE TABLE IF NOT EXISTS fine_tbl (a int)');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE blocked_tbl IN ACCESS EXCLUSIVE MODE');

        const results = await analyzeTables(ctx,
          { subcommand: 'test', reason: 'one blocked' },
          { limit: 500, lockTimeoutMs: 300 });

        const blocked = results.find((r) => r.relation.includes('blocked_tbl'));
        const fine = results.find((r) => r.relation.includes('fine_tbl'));
        expect(blocked).toBeDefined();
        expect(fine).toBeDefined();
        expect(blocked!.ok).toBe(false);
        expect(blocked!.error).toBeTruthy();
        // The point of the test: the neighbour still succeeded. Until the
        // failed transaction is unwound, every later statement on that
        // connection fails with "current transaction is aborted".
        expect(fine!.ok).toBe(true);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });
  }, 120_000);
});

describe('analyzeTables audits', () => {
  const lastAnalyze = (): Record<string, unknown> | undefined => {
    const lines = readFileSync(defaultAuditPath(), 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const rec = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (rec.action === 'analyze') return rec;
    }
    return undefined;
  };

  it('names the relations it touched and the reason it was asked to', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE TABLE IF NOT EXISTS audited_tbl (a int)');

      await analyzeTables(ctx, { subcommand: 'web/cleanup', reason: 'before a release' },
        { limit: 200 });

      const rec = lastAnalyze()!;
      expect(rec).toMatchObject({
        action: 'analyze', subcommand: 'web/cleanup', reason: 'before a release',
      });
      // The relations, not just a count: an audit record of a bulk write that
      // does not say what it wrote to cannot answer the question it exists for.
      expect((rec.target as { relations: string[] }).relations)
        .toContain('public.audited_tbl');
      expect(String(rec.result)).toMatch(/^ok: /);
    });
  }, 120_000);

  /**
   * A partial batch is neither `ok` nor an error, and recording it as either
   * would be wrong: `ok` hides that something did not get analyzed, and
   * `error` implies nothing did.
   */
  it('records a partial batch as partial', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE TABLE IF NOT EXISTS partial_blocked (a int)');
      await pool.query('CREATE TABLE IF NOT EXISTS partial_fine (a int)');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE partial_blocked IN ACCESS EXCLUSIVE MODE');

        await analyzeTables(ctx, { subcommand: 'test', reason: 'partial' },
          { limit: 200, lockTimeoutMs: 300 });

        expect(String(lastAnalyze()!.result)).toMatch(/^partial: \d+ ok, \d+ failed$/);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });
  }, 120_000);
});
