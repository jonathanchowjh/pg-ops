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
 * Counters are cumulative since the last reset, and two things restart them:
 *
 *   - an explicit pg_stat_statements_reset(), visible as stats_reset advancing;
 *   - LRU eviction: pg_stat_statements.max defaults to 5000, and a shape
 *     evicted then re-added restarts from zero.
 *
 * An interval spanning either is dropped, not clamped to zero and not
 * charted as a spike.
 *
 * Both `stats_reset` and the counters are compared: after a reset the
 * counters can climb past their old values before the next capture, which a
 * counter comparison alone would miss.
 *
 * `resets` are the moments of pgops's own resets, from its events. The reset
 * it issues is scoped to one database, and Postgres advances `stats_reset`
 * only for a reset of everything, so these are the only sign of it.
 */
export function deltas(points: CounterPoint[], resets: readonly number[] = []): Interval[] {
  const sorted = [...points].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const out: Interval[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    if (isDiscontinuity(prev, next)) continue;
    if (resets.some((r) => r > prev.capturedAt.getTime() && r <= next.capturedAt.getTime())) continue;
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
 * Per-shape intervals over a window. pgops stores cumulative counters and
 * differences them here at read time; it never resets pg_stat_statements,
 * as pgHero does, because that breaks every other consumer on the database.
 */
export const historicalQueryStats: Series<ShapeIntervals, HistoricalQueryStatsOpts> = {
  id: 'historicalQueryStats',
  title: 'Query stats over time',
  read: async (ctx, range, opts) => {
    // `ctx.store!`: `runSeries` returns `missing-store` before calling `read`.
    //
    // `opts` must be forwarded: it carries the `maxSnapshots` and `queryids`
    // bounds, without which a polling page reads every snapshot of every
    // shape in the window.
    const shapes = await readQueryStats(ctx.store!, opts.databaseName, range.from, range.to, opts);
    return shapes
      .map((s) => ({ queryid: s.queryid, query: s.query, intervals: deltas(s.points) }))
      .filter((s) => s.intervals.length > 0);
  },
};

/**
 * One shape's movement over a window, as intervals: one shape, every
 * snapshot in the window, where `historicalQueryStats` reads many shapes and
 * few snapshots.
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
    // A shape the store has never captured yields `[]`, which is a reading
    // ("no history yet"), not a failure.
    const shape = shapes[0];
    return shape === undefined ? [] : deltas(shape.points);
  },
};
