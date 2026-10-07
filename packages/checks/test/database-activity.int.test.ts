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
      // reset. Whether the first reading beat the collector was a race this
      // test lost four runs in four on 2026-10-07, on a commit that had
      // passed the full matrix that morning. Wait for the entry.
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
      // Brief defect, found running this test for real: a bare
      // `setTimeout(1_000)` here is exactly the trap harness.ts's own
      // `awaitPublished` docblock describes — PG15+ only flushes a
      // backend's local stats to shared memory at transaction end, no more
      // often than PGSTAT_MIN_INTERVAL (1s), so a fixed one-second sleep
      // raced that interval and lost on PG 17 in this environment
      // (xact_commit and tup_inserted read back byte-identical to `a` even
      // after 3s, confirmed by hand with a throwaway debug test before
      // writing this comment). Polling for the actual counter to move,
      // the way every other integration test in this package already does,
      // is the fix — not a longer fixed sleep, which only narrows the race.
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
