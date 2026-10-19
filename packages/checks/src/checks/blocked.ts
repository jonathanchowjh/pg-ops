import type { Check, Verdict } from '../types.js';
import { counted } from './shared.js';

export interface BlockedRow {
  /** Cast `::int`, so node-pg returns a JS number. */
  blocked: number;
  longest_query_age_secs: string | null;
  /**
   * Seconds the longest-waiting blocked session has spent waiting, from
   * `pg_locks.waitstart`. NULL when no wait is measurable yet: `waitstart`
   * is briefly NULL for a wait that has only just begun.
   */
  longest_wait_secs: string | null;
  /** Cast `::int`, like every other pid in this package. */
  suspect_pid: number | null;
}

export interface BlockedData {
  count: number;
  /**
   * Age of the blocked session's query, not the time it has spent waiting:
   * a query that ran for ten minutes and blocked five seconds ago reports
   * ten minutes. Rendered; the verdict uses `longestWaitSecs`.
   */
  longestQueryAgeSecs: number | null;
  /**
   * The longest time any blocked session has spent waiting; `verdict`
   * escalates on this. NULL means the wait could not be measured, not that
   * nothing is waiting, and `verdict` treats that as warn.
   */
  longestWaitSecs: number | null;
  /**
   * The blocker an operator is invited to kill, but not a `KillTarget` on
   * its own: `killBackend`'s PID-reuse guard needs `backendStart`, and a
   * null one returns `session-changed`. Get it with
   * `runCheck(ctx, sessions, { pid })` first.
   */
  suspectPid: number | null;
}

/**
 * One pg_blocking_pids call per backend: the function takes exclusive access
 * to the lock manager's shared state. MATERIALIZED stops the planner
 * inlining the CTE and evaluating it once per reference per row.
 *
 * Client backends only, as in locks.ts, sessions.ts and long-running.ts.
 * `suspect_pid` is offered as a kill target, which a background process
 * must never be, and the thresholds are calibrated for client work.
 *
 * `suspect_pid` is the first blocker of the oldest blocked query, tied by
 * `pid` so the answer is stable between polls.
 */
const SQL = `
WITH act AS MATERIALIZED (
  SELECT pid, query_start, pg_blocking_pids(pid) AS blockers,
         (SELECT min(l.waitstart) FROM pg_locks l
           WHERE l.pid = pg_stat_activity.pid AND NOT l.granted) AS waitstart
    FROM pg_stat_activity
   WHERE backend_type = 'client backend'
)
SELECT count(*)::int AS blocked,
       max(EXTRACT(EPOCH FROM (now() - query_start)))::text AS longest_query_age_secs,
       max(EXTRACT(EPOCH FROM (now() - waitstart)))::text AS longest_wait_secs,
       (array_agg(blockers[1] ORDER BY now() - query_start DESC, pid))[1]::int AS suspect_pid
FROM act WHERE cardinality(blockers) > 0`;

export const blocked: Check<BlockedRow, BlockedData> = {
  id: 'blocked',
  gate: 'wait',
  home: 'session',
  title: 'Blocked sessions',
  class: 'live',
  /**
   * `pg_locks.waitstart` is PG14+. Declared so an older server gets the
   * version message, not a raw `42703 column "waitstart" does not exist`.
   */
  requires: [{ kind: 'version', min: 140000 }],
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    return {
      count: r?.blocked ?? 0,
      longestQueryAgeSecs: r?.longest_query_age_secs == null ? null : Number(r.longest_query_age_secs),
      longestWaitSecs: r?.longest_wait_secs == null ? null : Number(r.longest_wait_secs),
      suspectPid: r?.suspect_pid ?? null,
    };
  },
  thresholds: [
    { level: 'warn', value: 1, unit: 'count',
      because: 'any blocked session is a query not completing',
      remedy: 'Open the wait graph. The session to act on is the ROOT of the chain, which '
            + 'is often idle in transaction rather than the one running a slow query.' },
    {
      level: 'critical', value: 60, unit: 'seconds',
      because: 'a minute of waiting outlives most client and proxy timeouts, so the '
             + 'waiters are already being retried elsewhere while still shown here as '
             + 'blocked, and the queue grows faster than it drains',
      // Not "terminate the root blocker": that is the locks check's remedy,
      // and the two panels sit together on the triage page.
      remedy: 'Treat this as an outage in progress rather than something that will clear: '
            + 'the waiters are already timing out and retrying, which adds load to the '
            + 'queue behind them. The wait graph names the session to break it at.',
    },
  ],
  /**
   * Without a `critical` threshold, any blocked session still reports
   * `warn`, never `ok`.
   */
  verdict: (d, t): Verdict => {
    if (d.count === 0) return { level: 'ok' };
    const crit = t.find((x) => x.level === 'critical');
    // `?? 0` keeps an unmeasurable wait at warn.
    const level = crit && (d.longestWaitSecs ?? 0) >= crit.value ? 'critical' : 'warn';
    return { level, note: `${counted(d.count, 'session')} blocked` };
  },
};
