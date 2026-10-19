import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeTables } from '../src/actions/analyze.js';
import { defaultAuditPath } from '../src/actions/audit.js';
import { awaitPublished, withPostgres } from './harness.js';

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

  /** The identifier is never escaped here: the catalog emits it already quoted. */
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

  /** A request handler must not issue one statement per relation in an unbounded catalog. */
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

  it('analyzes one table when it is named, and nothing when the name is no table', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE TABLE one_of_two (a int)');
      await pool.query('CREATE TABLE two_of_two (a int)');
      const results = await analyzeTables(ctx, { subcommand: 'test', reason: 'one table' }, { relation: 'public.one_of_two' });
      expect(results).toEqual([{ relation: 'public.one_of_two', ok: true }]);
      // Statistics are published a moment after the statement, on 14 most of all.
      await awaitPublished(pool, 'the analyze of one_of_two',
        "SELECT last_analyze IS NOT NULL AS ready FROM pg_stat_user_tables WHERE relname = 'one_of_two'");
      const { rows } = await pool.query<{ relname: string }>(
        'SELECT relname FROM pg_stat_user_tables WHERE last_analyze IS NOT NULL ORDER BY relname');
      expect(rows.map((r) => r.relname)).toEqual(['one_of_two']);
      expect(await analyzeTables(ctx, { subcommand: 'test', reason: 'no table' }, { relation: 'public.nope' })).toEqual([]);
    });
  }, 120_000);

  /**
   * Another session's temp tables are not in scope. Rejecting only
   * information_schema and pg_catalog lets every pg_temp_N schema through: an
   * unrelated session's temp table reads back as pg_temp_29.tmp_probe.
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
   * Staged with an ACCESS EXCLUSIVE lock, the realistic cause: ANALYZE needs
   * a share-update-exclusive lock and cannot get one. `lockTimeoutMs` is
   * lowered only to keep the suite quick; the production default stays 5s.
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
        // Until the failed transaction is unwound, every later statement on
        // that connection fails with "current transaction is aborted".
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
      // The relations, not just a count: the record must say what was written to.
      expect((rec.target as { relations: string[] }).relations)
        .toContain('public.audited_tbl');
      expect(String(rec.result)).toMatch(/^ok: /);
    });
  }, 120_000);

  /** `ok` would hide that something was not analyzed; `error` would imply nothing was. */
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

  /** Every statement Analyze sends, the ANALYZE included, carries the marker the ranking excludes. */
  it('leaves nothing unmarked in the statement ranking', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE TABLE marked_me (a int)');
      await pool.query('INSERT INTO marked_me SELECT generate_series(1, 10)');
      await pool.query('SELECT pg_stat_statements_reset()');
      const results = await analyzeTables(ctx, { subcommand: 'test', reason: 'marker' }, {});
      expect(results.every((r) => r.ok)).toBe(true);
      const { rows } = await pool.query<{ query: string }>(
        `SELECT query FROM pg_stat_statements
          WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND query ~* '^\\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL|ANALYZE)'
            AND query NOT LIKE '%/* pgops */'`,
      );
      expect(rows).toEqual([]);
    });
  });
});
