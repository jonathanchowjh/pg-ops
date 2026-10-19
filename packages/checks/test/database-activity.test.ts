import { describe, expect, it } from 'vitest';
import { counterRates, databaseActivity, type DatabaseActivityData } from '../src/checks/database-activity.js';

const sample = (over: Partial<DatabaseActivityData> = {}): DatabaseActivityData => ({
  xactCommit: 1000, xactRollback: 10, deadlocks: 0, conflicts: 0, tempFiles: 0, tempBytes: 0,
  blksRead: 100, blksHit: 9900, tupReturned: 0, tupFetched: 0, tupInserted: 0, tupUpdated: 0, tupDeleted: 0,
  statsResetAt: null, sampledAt: '2026-01-01T00:00:00Z', ...over,
});

describe('counterRates', () => {
  it('differences two samples over the elapsed seconds', () => {
    const r = counterRates(sample(), sample({ xactCommit: 2500, xactRollback: 20, deadlocks: 1, tempBytes: 5_000_000, blksRead: 200, blksHit: 19_800 }), 5);
    expect(r).not.toBeNull();
    expect(r!.commitsPerSec).toBe(300);
    expect(r!.rollbacksPerSec).toBe(2);
    expect(r!.deadlocks).toBe(1);
    expect(r!.tempBytesPerSec).toBe(1_000_000);
    expect(r!.cacheHitPct).toBeCloseTo(99, 0);
  });

  it('is null across a counter reset', () => {
    expect(counterRates(sample({ xactCommit: 1000 }), sample({ xactCommit: 5 }), 5)).toBeNull();
  });

  it('is null when the server says the counters were reset, even though none went backwards', () => {
    // A freshly reset database whose new counters already climbed past the
    // totals they replaced: only `stats_reset` says it is a different series.
    const before = sample({ xactCommit: 5, statsResetAt: '2026-01-01T00:00:00Z' });
    const after = sample({ xactCommit: 100, statsResetAt: '2026-01-01T00:05:00Z' });
    expect(counterRates(before, after, 5)).toBeNull();
  });

  it('still differences two samples from the same unbroken series', () => {
    // An unchanged stats_reset must not be mistaken for a reset.
    const before = sample({ xactCommit: 1000, statsResetAt: '2026-01-01T00:00:00Z' });
    const after = sample({ xactCommit: 2500, statsResetAt: '2026-01-01T00:00:00Z' });
    expect(counterRates(before, after, 5)?.commitsPerSec).toBe(300);
  });

  it('is null over no time', () => {
    expect(counterRates(sample(), sample(), 0)).toBeNull();
  });

  it('has no cache hit rate when there was no block traffic', () => {
    const r = counterRates(sample(), sample({ xactCommit: 1001 }), 5);
    expect(r!.cacheHitPct).toBeNull();
  });
});

describe('databaseActivity.map', () => {
  it('parses bigint text into numbers', () => {
    const d = databaseActivity.map([{ xact_commit: '12', xact_rollback: '1', deadlocks: '0', conflicts: '0',
      temp_files: '0', temp_bytes: '0', blks_read: '5', blks_hit: '95', tup_returned: '1', tup_fetched: '1',
      tup_inserted: '1', tup_updated: '1', tup_deleted: '1', stats_reset: null,
      sampled_at: '2026-01-01 00:00:00+00' }]);
    expect(d.xactCommit).toBe(12);
    expect(d.statsResetAt).toBeNull();
    expect(d.sampledAt).toBe('2026-01-01 00:00:00+00');
  });
});
