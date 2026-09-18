import type { Check, Verdict } from '../types.js';

export interface LongRunningRow {
  /** int4, unadorned — node-pg's default parser hands pid back as a `number` already. */
  pid: number;
  /** `::text` cast below — genuinely arrives as text, so `map` converts it. */
  running_secs: string;
  query: string | null;
  /**
   * `::text`, exactly as sessions.ts casts it, and for the same reason: this
   * value round-trips through JSON to the browser and back into
   * `$2::timestamptz` as killBackend's PID-reuse guard. A `Date` would be
   * re-serialised on the way with millisecond truncation and stop matching
   * the session it identifies.
   *
   * Nullable because pg_stat_activity.backend_start is null for some backend
   * types. `killBackend` accepts null and reads it as "kill on pid alone".
   */
  backend_start: string | null;
  /**
   * `count(*) OVER ()` (int4, cast `::int` below), computed over every row
   * that matched WHERE, BEFORE `ORDER BY`/`LIMIT` clip the result — same
   * technique, and the same reason, as sessions.ts's own `total_matching`.
   * `limit` here is a runtime `LongRunningOpts` value, not a module
   * constant, so `map` — pure over `rows` alone, per the `Check` interface,
   * with no access to `Opts` — cannot detect truncation any other way.
   * locks.ts's LIMIT-N+1-then-slice technique doesn't apply here for the
   * same reason it doesn't apply to sessions.ts: that trick only works when
   * the limit is a fixed constant baked into the SQL, not a caller-supplied
   * option `map` never sees.
   */
  total_matching: number;
}

export interface LongRunning {
  pid: number;
  /**
   * How long this query has been running. The WHERE clause below restricts
   * this SQL to `state = 'active'`, so — unlike sessions.ts's `queryAgeSecs`,
   * which is deliberately ambiguous for an idle session (A9) — every row
   * this check returns genuinely IS a query in flight right now, and
   * `runningSecs` means exactly what it says.
   */
  runningSecs: number;
  query: string | null;
  /**
   * Session identity, captured at selection — see LongRunningRow.
   *
   * Here rather than derived later because that is the whole PID-reuse guard:
   * killBackend compares this, inside the same statement as the terminate,
   * against one snapshot of pg_stat_activity. A bulk kill that re-derived it
   * server-side would compare the server's current idea of the session
   * against itself and always agree.
   */
  backendStart: string | null;
}

export interface LongRunningOpts { minSecs?: number; limit?: number }

export interface LongRunningData {
  queries: LongRunning[];
  /**
   * True when the LIMIT dropped rows. Convention 6 (and A7, the same defect
   * on sessions.ts): a partial list an operator knows is partial is useful;
   * one they believe is complete is worse than nothing. A caller with a
   * runtime `limit` cannot otherwise tell "there were exactly this many" from
   * "there were more and this is a clipped page".
   */
  truncated: boolean;
}

/**
 * The floor is a parameter rather than a hardcoded 5 seconds: pgHero's
 * long_running_query_sec defaults to 60 (capability #9) and the shipped
 * code's 5 put ordinary reporting queries on the triage screen under a
 * green check.
 *
 * `ORDER BY query_start ASC` (oldest query_start first) is severity-
 * meaningful, not merely deterministic — the same principle as locks.ts's
 * `ORDER BY xact_start ASC`: the query that has been running longest is the
 * one worth seeing first when `limit` caps the result below the true count.
 * `pid` is a final tiebreak for two statements with the same query_start
 * (same convention as sessions.ts's own `ORDER BY ..., pid`), so a poll
 * against an unchanged database returns the same page rather than an
 * arbitrary reshuffle among tied rows.
 *
 * `total_matching` (see LongRunningRow) carries the pre-LIMIT row count on
 * every returned row, which is what lets `map` set `truncated` without
 * needing the `limit` value itself.
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
  values: [o.minSecs ?? 60, o.limit ?? 10],
});

export const longRunning: Check<LongRunningRow, LongRunningData, LongRunningOpts> = {
  id: 'longRunning',
  gate: 'work',
  title: 'Long-running queries',
  class: 'incident',
  sql: SQL,
  map: (rows) => {
    // Every row carries the same pre-LIMIT count (an unpartitioned window
    // function) — any row's value would do; `rows[0]` with a `?? 0`
    // fallback matches sessions.ts's own convention for "possibly no rows
    // at all".
    const totalMatching = rows[0]?.total_matching ?? 0;
    return {
      queries: rows.map((r) => ({
        // r.pid already arrives as a number (see LongRunningRow) — no
        // Number(...) needed there; running_secs genuinely arrives as text.
        pid: r.pid,
        runningSecs: Number(r.running_secs),
        query: r.query,
        backendStart: r.backend_start,
      })),
      truncated: totalMatching > rows.length,
    };
  },
  thresholds: [
    { level: 'warn', value: 60, unit: 'seconds',
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
  /**
   * Neither lookup uses a non-null assertion — same reasoning as
   * connections.ts's own comment on this: a level's threshold is data this
   * check may not have been given, not a guarantee the type system can see.
   *
   * I5: these were strict `>` and are now `>=`. This check was the outlier —
   * `blocked`, `locks` and `slots` already used `>=`, and `sessionStates`
   * used both inside one function. A threshold is the value AT WHICH the
   * condition becomes a problem, which is also how every `because` string in
   * this package is worded: the warn threshold's own text says pgHero "uses
   * 60s as the DEFINITION of long-running", not "past 60s". A query running
   * exactly 60.0s is therefore long-running, not almost long-running. The
   * flip point is pinned by long-running.test.ts's own boundary sweep, which
   * spec §9 requires and which nothing provided before.
   */
  verdict: (d, t): Verdict => {
    const longest = d.queries[0]?.runningSecs ?? 0;
    const crit = t.find((x) => x.level === 'critical');
    const warn = t.find((x) => x.level === 'warn');
    if (crit && longest >= crit.value) {
      return { level: 'critical', note: `pid ${d.queries[0]?.pid} running ${Math.round(longest)}s` };
    }
    if (warn && longest >= warn.value) {
      return { level: 'warn', note: `pid ${d.queries[0]?.pid} running ${Math.round(longest)}s` };
    }
    return { level: 'ok' };
  },
};
