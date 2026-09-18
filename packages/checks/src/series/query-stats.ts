import { readQueryStats, type ReadOpts } from '../store/read.js';
import type { Series } from '../types.js';

export interface CounterPoint {
  capturedAt: Date;
  calls: number;
  totalExecTime: number;
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
  /** From pg_stat_statements_info. An advance marks a discontinuity. */
  statsReset: Date | null;
}

export interface Interval {
  from: Date;
  to: Date;
  calls: number;
  totalExecTime: number;
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
}

/**
 * Difference consecutive cumulative snapshots into intervals.
 *
 * Counters are cumulative since the last reset, and there are two hazards,
 * both of which produce the same signature and get the same treatment:
 *
 *   - an explicit pg_stat_statements_reset(), visible as stats_reset advancing;
 *   - LRU eviction — pg_stat_statements.max defaults to 5000, and a shape
 *     evicted then re-added restarts from zero, which for that row is
 *     indistinguishable from a reset.
 *
 * An interval spanning either is a DISCONTINUITY and is DROPPED — not clamped
 * to zero, not rendered as a spike. A gap in a chart is honest; a spike is a
 * lie that reads as an incident, and this tool exists to be trusted during
 * one.
 *
 * Both conditions are tested, not just the counter one: after a reset the
 * counters can climb past their old values before the next capture, and
 * counter comparison alone would miss it and chart the whole post-reset total
 * as a five-minute spike.
 */
export function deltas(points: CounterPoint[]): Interval[] {
  const sorted = [...points].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const out: Interval[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    if (isDiscontinuity(prev, next)) continue;
    out.push({
      from: prev.capturedAt,
      to: next.capturedAt,
      calls: next.calls - prev.calls,
      totalExecTime: next.totalExecTime - prev.totalExecTime,
      rows: next.rows - prev.rows,
      sharedBlksHit: next.sharedBlksHit - prev.sharedBlksHit,
      sharedBlksRead: next.sharedBlksRead - prev.sharedBlksRead,
    });
  }
  return out;
}

function isDiscontinuity(prev: CounterPoint, next: CounterPoint): boolean {
  const resetAdvanced =
    next.statsReset !== null &&
    (prev.statsReset === null || next.statsReset.getTime() > prev.statsReset.getTime());
  if (resetAdvanced) return true;
  return next.calls < prev.calls
    || next.totalExecTime < prev.totalExecTime
    || next.rows < prev.rows
    || next.sharedBlksHit < prev.sharedBlksHit
    || next.sharedBlksRead < prev.sharedBlksRead;
}

export interface ShapeIntervals {
  queryid: string;
  query: string;
  intervals: Interval[];
}

export interface HistoricalQueryStatsOpts extends ReadOpts { databaseName: string }

/**
 * #15 historical_query_stats.
 *
 * pgHero gets deltas by calling pg_stat_statements_reset() after each
 * snapshot. pgops refuses — that silently breaks every other consumer on the
 * database — so it stores cumulative counters and differences them here, at
 * read time.
 */
export const historicalQueryStats: Series<ShapeIntervals, HistoricalQueryStatsOpts> = {
  id: 'historicalQueryStats',
  title: 'Query stats over time',
  read: async (ctx, range, opts) => {
    // `runSeries` returns `missing-store` before ever calling `read`, so the
    // store is present here by construction. Reached any other way this
    // throws, and `runSeries` converts that to ok:false like any other error.
    //
    // `opts` is forwarded WHOLE, and that fifth argument is load-bearing. It
    // was missing: `HistoricalQueryStatsOpts extends ReadOpts` precisely so a
    // caller can bound the read, the queries page passes `maxSnapshots: 2`
    // and the ~100 `queryids` it renders, and both were dropped here — so
    // read.ts's I2 bound existed, was unit-tested, and applied to nothing
    // reachable from a page. Every render of an INCIDENT page polling at 5s
    // read every snapshot in a twenty-minute window for every shape in the
    // database, each dragging its full query text: spec §5.1's "one indexed
    // lookup per render and it must stay that way", inverted.
    //
    // The extra `databaseName` property rides along unread; `ReadOpts` is a
    // supertype, so this is the whole options object arriving where its
    // store-facing half is wanted, not a cast.
    const shapes = await readQueryStats(ctx.store!, opts.databaseName, range.from, range.to, opts);
    return shapes
      .map((s) => ({ queryid: s.queryid, query: s.query, intervals: deltas(s.points) }))
      .filter((s) => s.intervals.length > 0);
  },
};

/**
 * #16. One shape's movement over a window, as intervals.
 *
 * A SECOND series rather than an option on `historicalQueryStats`, because
 * they bound differently and answering both from one object would give it two
 * incompatible defaults. That one answers "how has every shape on this page
 * moved since the last capture" — many shapes, two snapshots. This answers
 * "how has THIS shape moved over 24 hours" — one shape, every snapshot in the
 * window. They share `readQueryStats` and `deltas`, which is where the
 * sharing belongs.
 *
 * Returns `Interval[]`, not shapes: the caller already knows which shape it
 * asked about, and returning a one-element array of shapes to be unwrapped at
 * every call site is ceremony.
 */
export const queryShapeHistory: Series<Interval, {
  databaseName: string;
  queryid: string;
  maxSnapshots?: number;
}> = {
  id: 'queryShapeHistory',
  title: 'Query shape history',
  read: async (ctx, range, opts) => {
    const shapes = await readQueryStats(
      ctx.store!, opts.databaseName, range.from, range.to,
      { queryids: [opts.queryid], maxSnapshots: opts.maxSnapshots });
    // A shape the store has never captured yields no rows. `[]` is the
    // reading — `runSeries` reports ok:true with no points, and the page says
    // "no history yet" rather than "we could not look".
    const shape = shapes[0];
    return shape === undefined ? [] : deltas(shape.points);
  },
};
