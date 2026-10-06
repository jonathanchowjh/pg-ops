import type { Check, Verdict } from '../types.js';

export interface BlockedRow {
  /** int4, cast `::int` below — node-pg's default parser hands this back as
   * a genuine JS `number` (connections.ts's own `used`/`max` convention). */
  blocked: number;
  longest_query_age_secs: string | null;
  /**
   * B9: seconds the longest-waiting blocked session has actually spent
   * waiting, from `pg_locks.waitstart`. NULL when no blocked session has a
   * measurable wait yet — `waitstart` is briefly NULL for a wait that has
   * only just begun, the same bound locks.ts's `wait_secs` carries.
   */
  longest_wait_secs: string | null;
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
   * then blocked five seconds ago reports ten minutes. The name says what it
   * actually measures rather than what an operator might assume it does.
   * Same reasoning, and the same field root, as sessions.ts's `queryAgeSecs`
   * and locks.ts's `xactAgeSecs`.
   *
   * Still rendered — how long a stuck session's statement has been open is
   * worth showing — but B9 moved the VERDICT onto `longestWaitSecs` below.
   * A8's own note here used to say pg_stat_activity exposes no wait-start
   * timestamp and this was therefore the only proxy available. True of
   * pg_stat_activity, and the wrong catalog: `pg_locks.waitstart` has
   * carried it since PG14, which is this package's floor, and locks.ts had
   * already been reading it for a release.
   */
  longestQueryAgeSecs: number | null;
  /**
   * B9: the longest time any blocked session has ACTUALLY spent waiting.
   * This is what `verdict` escalates on.
   *
   * NULL means the wait could not be measured, not that nothing is waiting:
   * `waitstart` is documented as briefly NULL for a wait that has only just
   * begun. `verdict` treats that as warn, never as ok.
   */
  longestWaitSecs: number | null;
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
  title: 'Blocked sessions',
  class: 'incident',
  /**
   * B9: `pg_locks.waitstart` is PG14+, and 14 is this package's floor — so
   * every supported server has it. Declared anyway for the same reason
   * locks.ts declares it: a check that merely assumes its floor fails on an
   * older server with a raw `42703 column "waitstart" does not exist`
   * instead of the sentence this console exists to print.
   */
  requires: [{ kind: 'version', min: 140000 }],
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    return {
      // `blocked` and `suspect_pid` already arrive as numbers (see the
      // BlockedRow comments) — no Number(...) conversion needed for either;
      // Convention 2 reserves that for values that genuinely arrive as text.
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
      // B9: says what it means again. A8 had to word this around the age of
      // the blocked session's query, because that is what the verdict then
      // compared the threshold to — a duration that starts when the
      // statement starts, not when it queues. With `waitstart` read above,
      // the threshold's subject is the wait itself and the sentence the
      // brief originally wanted is simply true.
      because: 'a minute of waiting outlives most client and proxy timeouts, so the '
             + 'waiters are already being retried elsewhere while still shown here as '
             + 'blocked, and the queue grows faster than it drains',
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
    // B9: the subject is `longestWaitSecs`, the quantity the threshold's own
    // `because` describes. `?? 0` keeps an unmeasurable wait at warn rather
    // than escalating it — a reading this console could not take never
    // decides a severity, in either direction.
    const level = crit && (d.longestWaitSecs ?? 0) >= crit.value ? 'critical' : 'warn';
    return { level, note: `${d.count} session${d.count === 1 ? '' : 's'} blocked` };
  },
};
