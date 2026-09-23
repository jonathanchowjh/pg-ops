import type { Check, Verdict } from '../types.js';

export interface BlockedRow {
  /** int4, cast `::int` below — node-pg's default parser hands this back as
   * a genuine JS `number` (connections.ts's own `used`/`max` convention). */
  blocked: number;
  longest_query_age_secs: string | null;
  /**
   * int4, cast `::int` below — same convention as `blocked` above, and as
   * every other pid in this package (LockRow.pid, SessionRow.pid,
   * LongRunningRow.pid). Not `::text`: a pid is never a value that
   * "genuinely arrives as a string" in the sense Convention 2 reserves
   * `Number(...)` for.
   */
  suspect_pid: number | null;
}

export interface BlockedData {
  count: number;
  /**
   * A8: this is the age of the blocked session's own QUERY, not the time it
   * has spent waiting. A query that ran productively for ten minutes and
   * then blocked five seconds ago reports ten minutes. pg_stat_activity
   * exposes no wait-start timestamp, so this is the only proxy available —
   * the name says what it actually measures rather than what an operator
   * might assume it does. Same reasoning, and the same field root, as
   * sessions.ts's `queryAgeSecs` and locks.ts's `xactAgeSecs`.
   */
  longestQueryAgeSecs: number | null;
  /**
   * The blocker an operator is invited to kill — but NOT a `KillTarget` on
   * its own (M2). `killBackend`'s PID-reuse guard requires `backendStart`,
   * which this shape does not carry, and passing `backendStart: null` fails
   * CLOSED: the SQL's CASE falls through to `ELSE NULL` and returns
   * `session-changed`. The working path is
   * `suspectPid` -> `runCheck(ctx, sessions, { pid })` -> that session's
   * `backendStart` -> `killBackend`. `SessionOpts.pid` exists for exactly
   * this hop and was added in a fix round for it.
   */
  suspectPid: number | null;
}

/**
 * One pg_blocking_pids call per backend. The shipped version called it twice
 * — once in the WHERE and once in the aggregate — and the function takes
 * exclusive access to the lock manager's shared state for the duration.
 * MATERIALIZED is load-bearing for the same reason locks.ts's own CTE needs
 * it: without it the planner may inline the CTE and evaluate
 * pg_blocking_pids once per reference per row.
 *
 * `backend_type = 'client backend'` — same restriction as locks.ts's,
 * sessions.ts's, and long-running.ts's own CTEs/WHERE clauses, and
 * deliberate here for a reason specific to THIS check: `suspect_pid` is the
 * pid an operator is invited to kill (Task 13 builds exactly that action),
 * and a non-client backend must never be offered as a kill target —
 * terminating an autovacuum worker or another background process is not the
 * same act as terminating a client session. Two more reasons: the
 * thresholds below are calibrated for client work, so counting background
 * workers would change what the number means without changing what it's
 * called; and one consistent population across every check in this package
 * is the A11 lesson this plan keeps relearning. A blocked autovacuum worker
 * genuinely is serious (a wraparound risk) but belongs to the vacuum area's
 * own check, with its own calibration and its own remedy — not folded into
 * "blocked sessions" here.
 *
 * `blockers[1]` picks the suspect with the highest-age blocked session, tied
 * by `pid` — same tiebreak convention as long-running.ts's `ORDER BY
 * query_start ASC, pid`, locks.ts's, and sessions.ts's: without it, which
 * blocker gets named as `suspect_pid` under an exact `query_start` tie could
 * flip between otherwise-identical polls, which matters when an operator is
 * watching a dashboard refresh — the underlying blocking relationship is
 * genuine either way, but the ANSWER should be stable.
 */
const SQL = `
WITH act AS MATERIALIZED (
  SELECT pid, query_start, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
  WHERE backend_type = 'client backend'
)
SELECT count(*)::int AS blocked,
       max(EXTRACT(EPOCH FROM (now() - query_start)))::text AS longest_query_age_secs,
       (array_agg(blockers[1] ORDER BY now() - query_start DESC, pid))[1]::int AS suspect_pid
FROM act WHERE cardinality(blockers) > 0`;

export const blocked: Check<BlockedRow, BlockedData> = {
  id: 'blocked',
  gate: 'wait',
  title: 'Blocked sessions',
  class: 'incident',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    return {
      // `blocked` and `suspect_pid` already arrive as numbers (see the
      // BlockedRow comments) — no Number(...) conversion needed for either;
      // Convention 2 reserves that for values that genuinely arrive as text.
      count: r?.blocked ?? 0,
      longestQueryAgeSecs: r?.longest_query_age_secs == null ? null : Number(r.longest_query_age_secs),
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
      // A8: worded around what `longestQueryAgeSecs` actually measures — the
      // blocked session's own query age — not "60 seconds of waiting". The
      // brief's original wording ("the waiters have exceeded most
      // application timeouts") attributed the duration to the waiters'
      // wait time, which is exactly the mislabeling this check exists to
      // avoid; see the fix note in the task report.
      because: 'past a minute of query age, most client and proxy timeouts have already '
             + 'fired for that session, so it is likely being retried elsewhere while '
             + 'still shown here as blocked, and the queue grows faster than it drains',
      // Deliberately NOT "terminate the root blocker" — that is the locks
      // check's remedy, and on the triage page these two panels sit one above
      // the other. Rendered as written, the console gave the same instruction
      // twice in eight lines. This one owns the half locks does not: why
      // waiting it out is the wrong call.
      remedy: 'Treat this as an outage in progress rather than something that will clear: '
            + 'the waiters are already timing out and retrying, which adds load to the '
            + 'queue behind them. The wait graph names the session to break it at.',
    },
  ],
  /**
   * Neither lookup uses a non-null assertion — same reasoning as
   * connections.ts's own comment on this: a level's threshold is data this
   * check may not have been given, not a guarantee the type system can see.
   * Absent `critical`, any blocked session still reports `warn` rather than
   * silently `ok` — this check exists specifically to surface blocking, so
   * "no threshold configured" must fail toward visible, not toward silence.
   */
  verdict: (d, t): Verdict => {
    if (d.count === 0) return { level: 'ok' };
    const crit = t.find((x) => x.level === 'critical');
    const level = crit && (d.longestQueryAgeSecs ?? 0) >= crit.value ? 'critical' : 'warn';
    return { level, note: `${d.count} session${d.count === 1 ? '' : 's'} blocked` };
  },
};
