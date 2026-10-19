import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { databaseActivity, counterRates } from '../src/checks/database-activity.js';
import { awaitPublished, withPostgres } from './harness.js';

describe('databaseActivity', () => {
  it('reads this database\'s counters and they move with work', async () => {
    await withPostgres(async (ctx, pool) => {
      // On Postgres 14 the statistics collector creates a database's entry
      // when its first message arrives, a moment after the database exists.
      // Read before that, `stats_reset` is null; read after, it is the
      // entry's creation time, and `counterRates` rightly calls that a
      // reset. Wait for the entry.
      await awaitPublished(
        pool,
        'the database\'s statistics entry',
        'SELECT (xact_commit > 0)::boolean AS ready FROM pg_stat_database WHERE datname = current_database()',
      );
      const a = await runCheck(ctx, databaseActivity);
      if (!a.ok) throw new Error(a.message);
      await pool.query('CREATE TABLE da_t (id int)');
      for (let i = 0; i < 20; i++) await pool.query('INSERT INTO da_t VALUES ($1)', [i]);
      await pool.query('BEGIN'); await pool.query('SELECT 1'); await pool.query('ROLLBACK');
      // Poll rather than sleep: PG15+ flushes a backend's stats to shared
      // memory at transaction end, no more often than PGSTAT_MIN_INTERVAL
      // (1s), so a fixed sleep races that interval.
      await awaitPublished(
        pool,
        'databaseActivity counters after INSERTs',
        'SELECT (tup_inserted >= $1)::boolean AS ready FROM pg_stat_database WHERE datname = current_database()',
        [a.data.tupInserted + 20],
      );
      const b = await runCheck(ctx, databaseActivity);
      if (!b.ok) throw new Error(b.message);
      const r = counterRates(a.data, b.data, (b.measuredAt - a.measuredAt) / 1000);
      expect(r).not.toBeNull();
      expect(r!.commitsPerSec).toBeGreaterThan(0);
      expect(b.data.tupInserted - a.data.tupInserted).toBeGreaterThanOrEqual(20);
    });
  }, 120_000);
});
