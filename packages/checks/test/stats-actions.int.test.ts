import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resetQueryStats, resetStats } from '../src/actions/stats.js';
import { defaultAuditPath } from '../src/actions/audit.js';
import { withPostgres } from './harness.js';

describe('resetQueryStats', () => {
  it('clears this database’s statements', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      for (let i = 0; i < 5; i += 1) await pool.query(`SELECT ${i} AS distinct_shape`);
      const mine = async (): Promise<number> => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_statements
            WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`);
        return Number(rows[0]!.n);
      };
      const before = await mine();
      expect(before).toBeGreaterThan(0);

      await resetQueryStats(ctx, { subcommand: 'test', reason: 'clearing' });

      // Not zero: the reset and the counting query are statements too, so
      // compare against the pre-reset count.
      expect(await mine()).toBeLessThan(before);
    });
  }, 120_000);

  /**
   * pg_stat_statements is shared across the cluster and the zero-argument
   * reset wipes all of it. A reset for one database must leave another
   * database's statements standing.
   */
  it('resets only the database it was asked for', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      const others = async (): Promise<number> => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_statements
            WHERE dbid <> (SELECT oid FROM pg_database WHERE datname = current_database())`);
        return Number(rows[0]!.n);
      };
      const before = await others();
      // Guard the fixture: with no sibling-database statements the assertion
      // below is vacuous.
      expect(before, 'no sibling-database statements to protect — fixture is vacuous')
        .toBeGreaterThan(0);

      await resetQueryStats(ctx, { subcommand: 'test', reason: 'scoped' });

      expect(await others()).toBe(before);
    });
  }, 120_000);
});

describe('resetStats', () => {
  it('advances the database’s stats_reset time', async () => {
    await withPostgres(async (ctx, pool) => {
      const resetAt = async (): Promise<Date | null> => {
        const { rows } = await pool.query<{ t: Date | null }>(
          `SELECT pg_stat_get_db_stat_reset_time(oid) AS t
             FROM pg_database WHERE datname = current_database()`);
        return rows[0]!.t;
      };
      const before = await resetAt();

      await resetStats(ctx, { subcommand: 'test', reason: 'clearing' });

      // Bounded poll, not a single read: before PG 15 pg_stat_reset() sends a
      // message to a separate collector process, so an immediate read can
      // still see the pre-reset snapshot. A reset that never lands still
      // fails here.
      let after = before;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        after = await resetAt();
        if ((after?.getTime() ?? 0) > (before?.getTime() ?? 0)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(after).not.toBeNull();
      expect(after!.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
    });
  }, 120_000);
});

describe('the reset actions audit', () => {
  const lastRecord = (action: string): Record<string, unknown> | undefined => {
    const lines = readFileSync(defaultAuditPath(), 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const rec = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (rec.action === action) return rec;
    }
    return undefined;
  };

  it('records the reason and the result on success', async () => {
    await withPostgres(async (ctx) => {
      await resetStats(ctx, { subcommand: 'web/queries', reason: 'why it happened' });
      expect(lastRecord('reset-stats')).toMatchObject({
        action: 'reset-stats', subcommand: 'web/queries',
        reason: 'why it happened', result: 'ok',
      });
    });
  }, 120_000);

  /** An action that audited only on success would leave no trace of the database refusing. */
  it('records a failure too, rather than only the successes', async () => {
    await withPostgres(async (ctx) => {
      const failing = {
        ...ctx,
        target: {
          ...ctx.target,
          query: async () => { throw new Error('permission denied for function pg_stat_reset'); },
        },
      } as unknown as typeof ctx;

      await expect(resetStats(failing, { subcommand: 'test', reason: 'will fail' }))
        .rejects.toThrow(/permission denied/);

      const rec = lastRecord('reset-stats')!;
      expect(rec.reason).toBe('will fail');
      expect(String(rec.result)).toMatch(/^error: /);
    });
  }, 120_000);
});
