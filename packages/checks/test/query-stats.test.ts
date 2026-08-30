import { describe, expect, it } from 'vitest';
import { queryStats, type QueryStatRow } from '../src/checks/query-stats.js';

const row = (o: Partial<QueryStatRow>): QueryStatRow => ({
  queryid: '1', query: 'select 1', calls: '10',
  total_ms: 100, mean_ms: 10, stddev_ms: 1,
  rows: '10', shared_blks_hit: '90', shared_blks_read: '10',
  total_shapes: 1, stats_reset: null, requested_sort: 'total',
  ...o,
});

describe('queryStats.map', () => {
  it('converts bigint counters (calls, rows, shared_blks_*) from text to number', () => {
    const d = queryStats.map([row({ calls: '10', rows: '10', shared_blks_hit: '90', shared_blks_read: '10' })]);
    expect(d.rows[0]).toEqual({
      queryid: '1', query: 'select 1', calls: 10,
      totalMs: 100, meanMs: 10, stddevMs: 1,
      rows: 10, cacheHitPct: 90, redacted: false,
    });
  });

  // Convention 1: this package's first genuinely bigint counters. A
  // realistic-but-large value, well past 2^31 (an int4 overflow line no
  // longer relevant here) but nowhere near 2^53 (the actual float64
  // precision line) — proves the conversion is deliberate arithmetic, not
  // an accidental int4-range assumption smuggled back in.
  it('does not lose precision on a call count too large for int4', () => {
    const d = queryStats.map([row({ calls: '9876543210' })]); // > 2^31, < 2^53
    expect(d.rows[0]!.calls).toBe(9876543210);
  });

  it('keeps float8 time metrics as numbers without a text round trip', () => {
    const d = queryStats.map([row({ total_ms: 1234.5, mean_ms: 12.345, stddev_ms: 0.5 })]);
    expect(d.rows[0]).toMatchObject({ totalMs: 1234.5, meanMs: 12.345, stddevMs: 0.5 });
  });

  it('keeps queryid as a string identifier, never converted to a number', () => {
    // A real queryid can exceed Number.MAX_SAFE_INTEGER; converting it would
    // silently corrupt the identity this field exists to carry.
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

  // Fix round 1: verified empirically against a live PostgreSQL 17.11 that
  // Postgres redacts a foreign row's `queryid`/`query`, it does not drop the
  // row — every cost column stays populated. `redacted` must mirror that:
  // true whenever EITHER signal Postgres uses is present, so it doesn't
  // silently stop working if a future PG version stops nulling one of them.
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

  // A4: `sort` must echo what the CALLER asked for (via the `requested_sort`
  // column bound from `Opts.sort` and read back from the row — `map` itself
  // has no access to `Opts`), not a constant. A regression back to a
  // hardcoded `sort: 'total'` — the shape the brief's own draft shipped —
  // passes every SQL-ordering assertion in query-stats.int.test.ts while
  // still mislabelling the column header for every other key; this is the
  // one test that catches that specific regression.
  it.each(['total', 'mean', 'calls', 'cache'] as const)(
    'echoes back the requested sort key %s, not a constant',
    (sort) => {
      const d = queryStats.map([row({ requested_sort: sort })]);
      expect(d.sort).toBe(sort);
    },
  );

  it('falls back to "total" for an unrecognized requested_sort rather than trusting an untyped string', () => {
    // Defends the `isQuerySort` narrowing itself: a value that could only
    // arrive from a driver/version mismatch, not from a real caller.
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
    expect(d).toEqual({ rows: [], totalShapes: 0, statsResetAt: null, sort: 'total' });
  });
});

describe('queryStats shape', () => {
  it('requires the extension and the PG14 floor', () => {
    expect(queryStats.requires).toContainEqual({ kind: 'extension', name: 'pg_stat_statements' });
    expect(queryStats.requires).toContainEqual({ kind: 'version', min: 140000 });
  });

  it('has no verdict/thresholds — a listing check, same as sessions.ts\'s own `sessions`', () => {
    expect(queryStats.verdict).toBeUndefined();
    expect(queryStats.thresholds).toBeUndefined();
  });
});
