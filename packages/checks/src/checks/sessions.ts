import type { Check, Verdict } from '../types.js';

export interface SessionRow {
  pid: number;
  state: string | null;
  usename: string | null;
  app: string | null;
  client_addr: string | null;
  backend_start: string | null;
  in_state_secs: string | null;
  query_age_secs: string | null;
  query: string | null;
  /**
   * `count(*) OVER ()` (int4, cast `::int` below — see connections.ts's
   * `used` for the same server-side-cast convention) computed over every row
   * that matched WHERE (including the optional `pid` predicate below),
   * BEFORE `ORDER BY`/`LIMIT` clip the result. Postgres's execution order
   * runs window functions ahead of ORDER BY/LIMIT, so every returned row
   * carries the true pre-LIMIT count regardless of how many rows survive the
   * cap. That is what lets `map` — a pure function of `rows` alone, with no
   * access to the `limit` the caller requested — still detect A7 truncation
   * correctly for a runtime-configurable limit.
   */
  total_matching: number;
}

export interface Session {
  pid: number;
  state: string | null;
  user: string | null;
  app: string | null;
  clientAddr: string | null;
  backendStart: string | null;
  inStateSecs: number | null;
  /** Age of the CURRENT (or, if idle, the LAST) query. Not "time waiting" — see A8. */
  queryAgeSecs: number | null;
  query: string | null;
}

export interface SessionOpts {
  limit?: number;
  /**
   * Fix-round 1: an exact pid to look up, answered by Postgres directly
   * rather than by filtering the already-capped page (see the SQL comment
   * below, and `prepareSessions`'s comment on why the client-side text
   * filter can't do this on its own).
   */
  pid?: number;
}

/**
 * A11: the shipped TUI had two definitions of this — `state.startsWith('idle
 * in transaction')` in home/query.ts, and an explicit two-literal
 * enumeration in sessions/model.ts. One concept, one implementation,
 * exported so nothing in this package has an excuse to write a third.
 */
export function isIdleInTransaction(state: string | null | undefined): boolean {
  return state === 'idle in transaction' || state === 'idle in transaction (aborted)';
}

/** Default cap when the caller doesn't specify one — see the SQL comment below. */
const DEFAULT_LIMIT = 500;

/**
 * A7: pg_stat_activity is unbounded. On a 2,000-connection instance
 * mid-incident this query — with no cap — would return 2,000 rows, each
 * carrying up to track_activity_query_size (1 kB default) of query text,
 * every poll. That is precisely the moment this check exists to serve, and
 * precisely the moment a slow, oversized response is least tolerable.
 *
 * The ORDER BY buys two DIFFERENT properties, and both matter:
 *
 *  1. Determinism: `pid` as the final tiebreak means the same 500 rows (for
 *     an unchanged database) survive every poll, rather than an arbitrary
 *     500 reshuffling for no reason between polls.
 *  2. Severity priority: the CASE expression mirrors `rank()` below — idle-
 *     in-transaction first, then active, then everything else — so that
 *     when not everything fits, what's KEPT is what matters. This is the
 *     same principle as locks.ts's `ORDER BY xact_start ASC` (oldest
 *     transaction survives the cap), and it is load-bearing, not cosmetic:
 *     Postgres assigns pids roughly monotonically within a server's uptime,
 *     so a plain `ORDER BY pid` keeps the LOWEST-numbered 500 sessions
 *     regardless of state. During the very incident A7 describes, a fresh
 *     burst of idle-in-transaction sessions has the HIGHEST pids and would
 *     be dropped wholesale — before `prepareSessions`'s triage rank, which
 *     exists to surface exactly those sessions, ever saw them. The check
 *     would confidently report no idle-in-transaction sessions during an
 *     idle-in-transaction incident. `state LIKE 'idle in transaction%'`
 *     mirrors `isIdleInTransaction` above (SQL can't call it directly); both
 *     known Postgres spellings share that prefix, same as the old, single-
 *     literal half of A11's `startsWith` implementation.
 *
 * `total_matching` (see SessionRow) carries the pre-LIMIT row count on every
 * returned row, which is what lets `map` set `truncated` without needing the
 * `limit` value itself — locks.ts's LIMIT-501-then-slice trick can't apply
 * here because its LIMIT is a fixed module constant, while this check's
 * limit is a runtime `SessionOpts` the `map` function (deliberately pure
 * over `rows` alone, per the `Check` interface) never sees.
 *
 * Fix-round 1 (A7 defeating A10): `prepareSessions`'s text filter runs
 * client-side, over whatever page this LIMIT already returned — it cannot
 * find a session the server never sent. `pid = $2` answers the one case
 * A10 exists for (an operator holding nothing but a pid) directly in
 * Postgres, so that lookup is immune to the cap: pid is unique, so at most
 * one row can ever match it, regardless of `LIMIT`/`ORDER BY`.
 */
const SQL = (o: SessionOpts) => ({
  text: `
    SELECT pid, state, usename, application_name AS app,
           client_addr::text AS client_addr, backend_start::text AS backend_start,
           EXTRACT(EPOCH FROM (now() - state_change))::text AS in_state_secs,
           EXTRACT(EPOCH FROM (now() - query_start))::text  AS query_age_secs,
           query,
           count(*) OVER ()::int AS total_matching
    FROM pg_stat_activity
    WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
      AND ($2::int IS NULL OR pid = $2)
    ORDER BY
      CASE WHEN state LIKE 'idle in transaction%' THEN 0
           WHEN state = 'active' THEN 1
           ELSE 2 END,
      CASE WHEN state = 'active' THEN query_start ELSE state_change END ASC NULLS LAST,
      pid
    LIMIT $1`,
  values: [o.limit ?? DEFAULT_LIMIT, o.pid ?? null],
});

export interface SessionsData {
  sessions: Session[];
  /**
   * True when the LIMIT dropped rows. Convention 6: a partial session list
   * an operator knows is partial is useful; one they believe is complete is
   * worse than nothing.
   */
  truncated: boolean;
}

export const sessions: Check<SessionRow, SessionsData, SessionOpts> = {
  id: 'sessions',
  title: 'Sessions',
  class: 'incident',
  sql: SQL,
  map: (rows) => {
    // Every row carries the same pre-LIMIT count (an unpartitioned window
    // function) — any row's value would do; `rows[0]` with a `?? 0` fallback
    // reads cleanly and matches connections.ts's own `r?.field ?? 0` style
    // for "possibly no rows at all".
    const totalMatching = rows[0]?.total_matching ?? 0;
    return {
      sessions: rows.map((r) => ({
        pid: r.pid,
        state: r.state,
        user: r.usename,
        app: r.app,
        clientAddr: r.client_addr,
        backendStart: r.backend_start,
        inStateSecs: r.in_state_secs == null ? null : Number(r.in_state_secs),
        queryAgeSecs: r.query_age_secs == null ? null : Number(r.query_age_secs),
        query: r.query,
      })),
      truncated: totalMatching > rows.length,
    };
  },
};

export interface PrepareOpts { sort: 'triage' | 'active'; filter: string }

/** Triage priority: idle-in-transaction first — the #1 preventable incident. */
function rank(r: Session): number {
  if (isIdleInTransaction(r.state)) return 0;
  if (r.state === 'active') return 1;
  return 2;
}

/**
 * Pure: sort + filter for the sessions table. No Postgres, no rendering —
 * the pgops equivalent of locks.ts's `buildChains`.
 *
 * Fix-round 1: `filter` here operates ONLY on `rows` — the page that already
 * survived the SQL's `LIMIT`. If more sessions exist than the cap
 * (`SessionsData.truncated`), a substring search over this array can miss a
 * session that is genuinely running but landed outside the returned page —
 * no amount of client-side filtering can find a row the server never sent.
 * That's why `SessionOpts.pid` exists as a second, server-side path for
 * exactly the case A10 is about: a caller holding nothing but a pid should
 * use it instead of (or in addition to) this text filter whenever
 * `truncated` is, or might be, true. A consumer surfacing `filter` to an
 * operator should surface `truncated` alongside it.
 */
export function prepareSessions(rows: Session[], o: PrepareOpts): Session[] {
  const needle = o.filter.trim().toLowerCase();
  const filtered = needle
    // A10: pid is included — an operator arriving from a log line, an
    // alert, or another view almost always holds a pid and nothing else.
    // (Minor, accepted: a numeric needle can also match inside `query`
    // text, e.g. '4242' surfacing an unrelated session whose SQL contains
    // that literal — the same substring ambiguity every other field here
    // already has, not new to pid.)
    ? rows.filter((r) => [String(r.pid), r.user, r.app, r.state, r.query]
        .some((f) => f?.toLowerCase().includes(needle)))
    : rows;

  return [...filtered].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    // A9: an `active` session's queryAgeSecs is how long its current query
    // has run — meaningful. An `idle` (or idle-in-transaction) session's
    // queryAgeSecs is time since its LAST query ENDED, which carries no
    // information about how long the session has actually been sitting.
    // inStateSecs (time since state_change) is the key that means something
    // for every non-active group.
    const key = (r: Session) => (r.state === 'active' ? r.queryAgeSecs : r.inStateSecs) ?? 0;
    return key(b) - key(a);
  });
}

export interface StateRow {
  state: string | null;
  sessions: number;
  longest_secs: string | null;
}

export interface StatesData {
  byState: { state: string; sessions: number; longestInStateSecs: number }[];
  oldestIdleInTxnSecs: number | null;
}

/**
 * No LIMIT/truncation concern here (unlike `sessions` above, A7): GROUP BY
 * state collapses pg_stat_activity down to a handful of rows — the distinct
 * Postgres session states — regardless of how many connections are open.
 *
 * Unlike `sessions` above, this does NOT exclude `pg_backend_pid()`: it's a
 * census, not a list an operator reads row-by-row, and this check's own
 * (necessarily 'active') backend is one real client-backend session among
 * the total — worth counting, not worth the extra WHERE clause to hide.
 */
const STATES_SQL = `
SELECT state, count(*)::int AS sessions,
       max(EXTRACT(EPOCH FROM (now() - state_change)))::text AS longest_secs
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state ORDER BY sessions DESC`;

export const sessionStates: Check<StateRow, StatesData> = {
  id: 'sessionStates',
  title: 'Session states',
  class: 'incident',
  sql: STATES_SQL,
  map: (rows) => {
    const byState = rows.map((r) => ({
      state: r.state ?? 'unknown',
      sessions: r.sessions,
      longestInStateSecs: r.longest_secs == null ? 0 : Number(r.longest_secs),
    }));
    // A11: isIdleInTransaction again — the only definition in this package.
    const oldestIdleInTxnSecs = byState.reduce<number | null>((longest, st) => {
      if (!isIdleInTransaction(st.state)) return longest;
      return longest == null || st.longestInStateSecs > longest ? st.longestInStateSecs : longest;
    }, null);
    return { byState, oldestIdleInTxnSecs };
  },
  thresholds: [
    { level: 'warn', value: 60, unit: 'seconds',
      because: 'a transaction idle for a minute is holding row locks and pinning the '
             + 'xmin horizon for no reason; almost always an application bug' },
    { level: 'critical', value: 300, unit: 'seconds',
      because: 'five minutes of idle-in-transaction blocks autovacuum from reclaiming '
             + 'anything newer, so bloat starts accumulating on top of the locking' },
  ],
  /**
   * Neither lookup uses a non-null assertion — same reasoning as
   * connections.ts's own comment on this: a level's threshold is data this
   * check may not have been given, not a guarantee the type system can see.
   *
   * I5: the warn comparison was `>` while the critical one immediately above
   * it was `>=` — the same function disagreeing with itself about what a
   * threshold means, and neither pinned by any test. Both are `>=` now: a
   * threshold is the value AT WHICH the condition becomes a problem, which
   * is how this check's own `because` strings read ("a transaction idle for
   * a minute is holding row locks", not "idle for more than a minute").
   * sessions.test.ts's boundary sweep is what holds it there.
   */
  verdict: (d, t): Verdict => {
    const s = d.oldestIdleInTxnSecs;
    if (s == null) return { level: 'ok' };
    const note = `idle in transaction for ${Math.round(s)}s`;
    const crit = t.find((x) => x.level === 'critical');
    if (crit && s >= crit.value) return { level: 'critical', note };
    const warn = t.find((x) => x.level === 'warn');
    if (warn && s >= warn.value) return { level: 'warn', note };
    return { level: 'ok' };
  },
};
