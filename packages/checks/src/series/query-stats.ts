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
    const shapes = await readQueryStats(ctx.store!, opts.databaseName, range.from, range.to);
    return shapes
      .map((s) => ({ queryid: s.queryid, query: s.query, intervals: deltas(s.points) }))
      .filter((s) => s.intervals.length > 0);
  },
};
