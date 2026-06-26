import { describe, expect, it } from 'vitest';
import type { QueryStat } from './query.js';
import { cycleSort, prepareRows } from './stats.js';

/** Build a QueryStat with sensible defaults; override what the test cares about. */
function stat(over: Partial<QueryStat> = {}): QueryStat {
  return {
    queryid: '1',
    query: 'SELECT 1',
    calls: 1,
    totalMs: 100,
    meanMs: 100,
    stddevMs: 0,
    rows: 1,
    sharedBlksHit: 90,
    sharedBlksRead: 10,
    ...over,
  };
}

describe('prepareRows — sorting', () => {
  it('sorts by total time descending by default', () => {
    const rows = prepareRows(
      [stat({ queryid: 'a', totalMs: 50 }), stat({ queryid: 'b', totalMs: 300 }), stat({ queryid: 'c', totalMs: 100 })],
      { sort: 'total' },
    );
    expect(rows.map((r) => r.queryid)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by mean time descending', () => {
    const rows = prepareRows(
      [stat({ queryid: 'a', meanMs: 5 }), stat({ queryid: 'b', meanMs: 80 }), stat({ queryid: 'c', meanMs: 20 })],
      { sort: 'mean' },
    );
    expect(rows.map((r) => r.queryid)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by call count descending', () => {
    const rows = prepareRows(
      [stat({ queryid: 'a', calls: 10 }), stat({ queryid: 'b', calls: 999 }), stat({ queryid: 'c', calls: 50 })],
      { sort: 'calls' },
    );
    expect(rows.map((r) => r.queryid)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by cache hit ascending — worst (coldest) cache first', () => {
    const rows = prepareRows(
      [
        stat({ queryid: 'hot', sharedBlksHit: 99, sharedBlksRead: 1 }), //  99%
        stat({ queryid: 'cold', sharedBlksHit: 10, sharedBlksRead: 90 }), // 10%
        stat({ queryid: 'warm', sharedBlksHit: 50, sharedBlksRead: 50 }), // 50%
      ],
      { sort: 'cache' },
    );
    expect(rows.map((r) => r.queryid)).toEqual(['cold', 'warm', 'hot']);
  });

  it('puts rows with no cache data (null) last when sorting by cache', () => {
    const rows = prepareRows(
      [
        stat({ queryid: 'none', sharedBlksHit: 0, sharedBlksRead: 0 }), // null
        stat({ queryid: 'cold', sharedBlksHit: 10, sharedBlksRead: 90 }), // 10%
      ],
      { sort: 'cache' },
    );
    expect(rows.map((r) => r.queryid)).toEqual(['cold', 'none']);
  });
});

describe('prepareRows — derived cache hit %', () => {
  it('computes cache hit percentage from shared block hits and reads', () => {
    const [row] = prepareRows([stat({ sharedBlksHit: 90, sharedBlksRead: 10 })], { sort: 'total' });
    expect(row?.cacheHitPct).toBeCloseTo(90);
  });

  it('is null when there were no block accesses at all', () => {
    const [row] = prepareRows([stat({ sharedBlksHit: 0, sharedBlksRead: 0 })], { sort: 'total' });
    expect(row?.cacheHitPct).toBeNull();
  });
});

describe('prepareRows — filtering', () => {
  it('keeps only rows whose query contains the filter, case-insensitively', () => {
    const rows = prepareRows(
      [
        stat({ queryid: 'a', query: 'SELECT * FROM users' }),
        stat({ queryid: 'b', query: 'UPDATE orders SET x = 1' }),
        stat({ queryid: 'c', query: 'INSERT INTO USERS VALUES (1)' }),
      ],
      { sort: 'total', filter: 'users' },
    );
    expect(rows.map((r) => r.queryid).sort()).toEqual(['a', 'c']);
  });

  it('returns everything when the filter is empty', () => {
    const rows = prepareRows([stat({ queryid: 'a' }), stat({ queryid: 'b' })], { sort: 'total', filter: '' });
    expect(rows).toHaveLength(2);
  });
});

describe('cycleSort', () => {
  it('cycles total → mean → calls → cache → total', () => {
    expect(cycleSort('total')).toBe('mean');
    expect(cycleSort('mean')).toBe('calls');
    expect(cycleSort('calls')).toBe('cache');
    expect(cycleSort('cache')).toBe('total');
  });
});
