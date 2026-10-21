import { describe, expect, it } from 'vitest';
import {
  queryStats,
  type QueryStatRow,
  type QueryStatsOpts,
} from '../src/checks/query-stats.js';

const row = (o: Partial<QueryStatRow>): QueryStatRow => ({
  queryid: '1', query: 'select 1', calls: '10',
  total_ms: 100, mean_ms: 10, stddev_ms: 1,
  rows: '10', shared_blks_hit: '90', shared_blks_read: '10',
  total_shapes: 1, own_shapes: 0, stats_reset: null, requested_sort: 'total', all_ms: 400,
  ...o,
});

describe('queryStats.map', () => {
  it('carries every shape\'s time, for a share', () => {
    expect(queryStats.map([row({ total_ms: 100, all_ms: 400 })]).allMs).toBe(400);
    expect(queryStats.map([]).allMs).toBe(0);
  });

  it('converts bigint counters (calls, rows, shared_blks_*) from text to number', () => {
    const d = queryStats.map([row({ calls: '10', rows: '10', shared_blks_hit: '90', shared_blks_read: '10' })]);
    expect(d.rows[0]).toEqual({
      queryid: '1', query: 'select 1', calls: 10,
      totalMs: 100, meanMs: 10, stddevMs: 1,
      rows: 10, cacheHitPct: 90, redacted: false,
    });
  });

  it('does not lose precision on a call count too large for int4', () => {
    const d = queryStats.map([row({ calls: '9876543210' })]); // > 2^31, < 2^53
    expect(d.rows[0]!.calls).toBe(9876543210);
  });

  it('keeps float8 time metrics as numbers without a text round trip', () => {
    const d = queryStats.map([row({ total_ms: 1234.5, mean_ms: 12.345, stddev_ms: 0.5 })]);
    expect(d.rows[0]).toMatchObject({ totalMs: 1234.5, meanMs: 12.345, stddevMs: 0.5 });
  });

  it('keeps queryid as a string identifier, never converted to a number', () => {
    // A real queryid can exceed Number.MAX_SAFE_INTEGER.
    const d = queryStats.map([row({ queryid: '9223372036854775807' })]);
    expect(d.rows[0]!.queryid).toBe('9223372036854775807');
  });

  it('reports cacheHitPct as null, not 0 or NaN, when a shape has never touched the buffer cache', () => {
    const d = queryStats.map([row({ shared_blks_hit: '0', shared_blks_read: '0' })]);
    expect(d.rows[0]!.cacheHitPct).toBeNull();
  });

  it('reports cacheHitPct as 100 when every block access was a cache hit', () => {
    const d = queryStats.map([row({ shared_blks_hit: '500', shared_blks_read: '0' })]);
    expect(d.rows[0]!.cacheHitPct).toBe(100);
  });

  it('reports cacheHitPct as 0 when every block access missed the cache', () => {
    const d = queryStats.map([row({ shared_blks_hit: '0', shared_blks_read: '500' })]);
    expect(d.rows[0]!.cacheHitPct).toBe(0);
  });

  // Postgres redacts a foreign row's `queryid`/`query` but keeps every cost
  // column. `redacted` is true when either signal is present, in case a
  // future version stops nulling one of them.
  it('flags a row redacted when queryid is nulled, even if query text looks normal', () => {
    const d = queryStats.map([row({ queryid: null, query: 'select 1' })]);
    expect(d.rows[0]!.redacted).toBe(true);
  });

  it('flags a row redacted when query reads the Postgres-supplied privilege marker', () => {
    const d = queryStats.map([row({ queryid: '1', query: '<insufficient privilege>' })]);
    expect(d.rows[0]!.redacted).toBe(true);
  });

  it('does not flag an ordinary, fully-visible row as redacted', () => {
    const d = queryStats.map([row({ queryid: '1', query: 'select 1' })]);
    expect(d.rows[0]!.redacted).toBe(false);
  });

  it('keeps cost columns intact on a redacted row rather than nulling them too', () => {
    const d = queryStats.map([row({
      queryid: null, query: '<insufficient privilege>',
      calls: '500', total_ms: 9999, mean_ms: 20, shared_blks_hit: '400', shared_blks_read: '100',
    })]);
    const r = d.rows[0]!;
    expect(r.redacted).toBe(true);
    expect(r.calls).toBe(500);
    expect(r.totalMs).toBe(9999);
    expect(r.meanMs).toBe(20);
    expect(r.cacheHitPct).toBe(80);
  });

  // `map` has no access to `Opts`, so `sort` is read back from the
  // `requested_sort` column. A hardcoded `sort: 'total'` passes every
  // SQL-ordering assertion in query-stats.int.test.ts while mislabelling the
  // column header.
  it.each(['total', 'mean', 'calls', 'cache'] as const)(
    'echoes back the requested sort key %s, not a constant',
    (sort) => {
      const d = queryStats.map([row({ requested_sort: sort })]);
      expect(d.sort).toBe(sort);
    },
  );

  it('falls back to "total" for an unrecognized requested_sort rather than trusting an untyped string', () => {
    const d = queryStats.map([row({ requested_sort: 'bogus' })]);
    expect(d.sort).toBe('total');
  });

  it('reports totalShapes and statsResetAt from the (repeated, per-row) columns', () => {
    const d = queryStats.map([
      row({ total_shapes: 42, stats_reset: '2026-08-01T00:00:00Z' }),
      row({ total_shapes: 42, stats_reset: '2026-08-01T00:00:00Z' }),
    ]);
    expect(d.totalShapes).toBe(42);
    expect(d.statsResetAt).toBe('2026-08-01T00:00:00Z');
  });

  it('defaults totalShapes to 0, statsResetAt to null, and sort to "total" on an empty result', () => {
    const d = queryStats.map([]);
    expect(d).toEqual({ rows: [], totalShapes: 0, ownShapes: 0, allMs: 0, statsResetAt: null, sort: 'total' });
  });

  it('carries the count of the console\'s own shapes', () => {
    const d = queryStats.map([{ queryid: '1', query: 'SELECT 1', calls: '1', total_ms: 1, mean_ms: 1, stddev_ms: 0,
      rows: '1', shared_blks_hit: '0', shared_blks_read: '0', total_shapes: 5, own_shapes: 3, stats_reset: null, requested_sort: 'total', all_ms: 1 }]);
    expect(d.ownShapes).toBe(3);
  });
});

describe('queryStats.sql — hiding the console\'s own shapes', () => {
  it('keeps a row whose text is null when hiding the console\'s shapes', () => {
    const { text } = (queryStats.sql as (o: QueryStatsOpts) => { text: string })({ sort: 'total' });
    expect(text).toContain('v.query IS NULL OR');
  });
});

describe('queryStats shape', () => {
  it('requires the extension and the PG14 floor', () => {
    expect(queryStats.requires).toContainEqual({ kind: 'extension', name: 'pg_stat_statements' });
    expect(queryStats.requires).toContainEqual({ kind: 'version', min: 140000 });
  });

  it('has no verdict/thresholds — a listing check, same as sessions.ts\'s own `sessions`', () => {
    expect(queryStats.thresholds).toBeUndefined();
  });
});

