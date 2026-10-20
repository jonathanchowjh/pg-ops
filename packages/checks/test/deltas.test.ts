import { describe, expect, it } from 'vitest';
import { deltas, type CounterPoint } from '../src/series/query-stats.js';
import { relationSpace } from '../src/series/space.js';
import { runSeries } from '../src/run.js';
import type { CheckContext } from '../src/types.js';

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min));

function point(min: number, calls: number, reset: Date | null = null): CounterPoint {
  return {
    capturedAt: at(min), calls, totalExecTime: calls * 10, rows: calls,
    sharedBlksHit: calls, sharedBlksRead: 0, statsReset: reset,
  };
}

describe('deltas', () => {
  it('differences consecutive cumulative snapshots', () => {
    const out = deltas([point(0, 100), point(5, 130)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.calls).toBe(30);
    expect(out[0]!.totalExecTime).toBe(300);
  });

  it('needs two points to produce an interval', () => {
    expect(deltas([point(0, 100)])).toEqual([]);
    expect(deltas([])).toEqual([]);
  });

  it('DROPS the interval when a counter decreased — never clamps it to zero', () => {
    // An LRU eviction: the shape was evicted from pg_stat_statements, then
    // re-added from zero. Indistinguishable from a reset for that row.
    const out = deltas([point(0, 100), point(5, 4), point(10, 20)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.from).toEqual(at(5));
    expect(out[0]!.calls).toBe(16);
  });

  it('DROPS the interval when stats_reset advanced, even if counters rose', () => {
    // The counters climbed past their old values before the next capture,
    // so counter comparison alone would miss the reset and chart a spike.
    const out = deltas([
      point(0, 100, at(0)),
      point(5, 400, at(3)),
    ]);
    expect(out).toEqual([]);
  });

  it('DROPS the interval that spans pgops\'s own reset, which stats_reset does not show', () => {
    // A hot shape climbed past its old count within the interval: only the event says.
    expect(deltas([point(0, 100), point(5, 130), point(10, 160)], [at(7).getTime()]).map((i) => i.from)).toEqual([at(0)]);
  });

  it('never emits a spike for a discontinuity — a gap is honest, a spike is a lie', () => {
    const out = deltas([point(0, 1000), point(5, 5), point(10, 9)]);
    expect(out.every((i) => i.calls >= 0)).toBe(true);
    expect(out.map((i) => i.calls)).toEqual([4]);
  });

  it('sorts by capturedAt before differencing', () => {
    const out = deltas([point(5, 130), point(0, 100)]);
    expect(out[0]!.calls).toBe(30);
  });
});

/**
 * `npm run typecheck:test`, not vitest, is what checks this: the body never
 * runs. If the call below ever compiles, the `@ts-expect-error` becomes an
 * unused directive and tsc fails on that line.
 */
describe('runSeries’ arity is part of its type (I4)', () => {
  it('rejects an options-bearing series called without its options, at compile time', () => {
    const neverCalled = async (ctx: CheckContext): Promise<void> => {
      const range = { from: new Date(0), to: new Date() };
      // @ts-expect-error — relationSpace declares its options.
      await runSeries(ctx, relationSpace, range);
      // ...and supplying them still does.
      await runSeries(ctx, relationSpace, range, { databaseName: 'prod', relation: 'public.t' });
    };
    expect(typeof neverCalled).toBe('function');
  });
});

