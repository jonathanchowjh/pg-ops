import type { Check, Verdict } from '../types.js';
import { escalate } from './shared.js';

export interface LongRunningRow {
  pid: number;
  /** Cast `::text`; `map` converts it. */
  running_secs: string;
  query: string | null;
  /**
   * `::text`: this value round-trips through JSON to the browser and back
   * into `$2::timestamptz` as killBackend's PID-reuse guard. A `Date` would
   * be truncated to milliseconds and stop matching the session.
   *
   * Nullable because pg_stat_activity.backend_start is null for some backend
   * types. A null never matches killBackend's guard, so such a backend is
   * not terminated.
   */
  backend_start: string | null;
  /**
   * `count(*) OVER ()`, the count before LIMIT. `map` cannot see the runtime
   * `limit`, so this is how it detects truncation.
   */
  total_matching: number;
}

export interface LongRunning {
  pid: number;
  /** How long this query has been running. Every row is `state = 'active'`. */
  runningSecs: number;
  query: string | null;
  /**
   * Session identity captured at selection, for killBackend's PID-reuse
   * guard. It must not be re-derived at kill time.
   */
  backendStart: string | null;
}

export interface LongRunningOpts { minSecs?: number; limit?: number }

export interface LongRunningData {
  queries: LongRunning[];
  /** True when the LIMIT dropped rows. */
  truncated: boolean;
}

/** Shared by the SQL floor and the warn threshold, which must agree. */
const LONG_RUNNING_FLOOR_SECS = 60;

/**
 * Oldest `query_start` first, so the longest-running queries survive the
 * LIMIT; `pid` breaks ties so an unchanged database returns the same page.
 */
const SQL = (o: LongRunningOpts) => ({
  text: `
    SELECT pid, EXTRACT(EPOCH FROM (now() - query_start))::text AS running_secs, query,
           backend_start::text AS backend_start,
           count(*) OVER ()::int AS total_matching
    FROM pg_stat_activity
    WHERE state = 'active' AND backend_type = 'client backend'
      AND pid <> pg_backend_pid()
      -- >=, not >: minSecs defaults to the warn threshold and the verdict
      -- escalates at >= it, so a > here would drop the boundary row before
      -- the verdict ever saw it (see long-running.test.ts).
      AND now() - query_start >= make_interval(secs => $1)
    ORDER BY query_start ASC, pid
    LIMIT $2`,
  values: [o.minSecs ?? LONG_RUNNING_FLOOR_SECS, o.limit ?? 10],
});

export const longRunning: Check<LongRunningRow, LongRunningData, LongRunningOpts> = {
  id: 'longRunning',
  gate: 'work',
  home: 'session',
  title: 'Long-running queries',
  class: 'live',
  sql: SQL,
  map: (rows) => {
    const totalMatching = rows[0]?.total_matching ?? 0;
    return {
      queries: rows.map((r) => ({
        pid: r.pid,
        runningSecs: Number(r.running_secs),
        query: r.query,
        backendStart: r.backend_start,
      })),
      truncated: totalMatching > rows.length,
    };
  },
  thresholds: [
    { level: 'warn', value: LONG_RUNNING_FLOOR_SECS, unit: 'seconds',
      because: 'pgHero #9 uses 60s as the definition of long-running; matching it keeps '
             + 'the two tools comparable on the same database',
      remedy: 'Check whether this query is normally slow or newly slow — Queries carries '
            + "its history. A statement_timeout on the role bounds the unbounded case." },
    { level: 'critical', value: 300, unit: 'seconds',
      because: 'five minutes exceeds almost every application and proxy timeout, so the '
             + 'client is gone and the work is being redone elsewhere',
      remedy: 'The client has almost certainly timed out and retried, so terminating this '
            + 'backend usually frees work nobody is waiting for. Confirm it is not '
            + 'maintenance — a vacuum, or a concurrent index build — first; those '
            + 'look identical here and must not be killed.' },
  ],
  /** Exactly 60.0s is long-running; long-running.test.ts holds the boundary. */
  verdict: (d, t): Verdict => {
    const longest = d.queries[0]?.runningSecs ?? 0;
    return escalate(longest, t, `pid ${d.queries[0]?.pid} running ${Math.round(longest)}s`);
  },
};
