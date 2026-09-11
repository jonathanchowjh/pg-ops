import type { Check } from '../types.js';

/**
 * A4: the shipped TUI's `TOP_SQL` was `ORDER BY total_exec_time DESC LIMIT
 * 100`, always — regardless of which of `total | mean | calls | cache`
 * `top/stats.ts` then re-sorted those 100 rows by, client-side. With
 * `pg_stat_statements.max` defaulting to 5000, "sort by mean" meant "the
 * worst mean among the 100 highest-total" — the twice-daily four-minute
 * report sits at rank ~3000 by total time and was unreachable under every
 * sort the UI offered, `cache` included. `ORDER` is a closed record keyed
 * by `QuerySort`, one entry per key the defect named, so the LIMIT and the
 * sort are always the same key: a caller-supplied string never reaches
 * `ORDER BY` (see the file-bottom note on why that's still safe SQL despite
 * not being a bind parameter).
 *
 * `cache` sorts ASCENDING, not DESCENDING like the other three: for
 * total/mean/calls, "worst" is the biggest number; for cache hit rate,
 * "worst" is the SMALLEST — the query evicting the buffer cache hardest. A
 * shape with no I/O at all (hit + read = 0) sorts last regardless of
 * direction: it has no cache behavior to rank, good or bad.
 */
export type QuerySort = 'total' | 'mean' | 'calls' | 'cache';

export interface QueryStatsOpts {
  sort: QuerySort;
  limit?: number;
}

export interface QueryStatRow {
  /**
   * bigint (a 64-bit hash) — kept as a string throughout; never arithmetic,
   * only identity. NULL when Postgres itself redacts this row (see the
   * `WHERE toplevel` comment below on `redacted` / fix-round-1's finding).
   */
  queryid: string | null;
  /** NULL/`'<insufficient privilege>'` when redacted — see the same comment. */
  query: string | null;
  /** bigint counter — see the map-level comment on why `Number(...)` is safe for it below. */
  calls: string;
  /**
   * double precision, natively in milliseconds since pg_stat_statements
   * 1.3 (bundled with every server this package supports). node-pg's
   * default parser hands float8 back as a JS `number` already — unlike the
   * bigint columns on this row, a `double precision` value IS an IEEE-754
   * double, so no cast-to-text-then-parse round trip is needed or done
   * (Convention 1's "type it as what genuinely arrives").
   */
  total_ms: number;
  mean_ms: number;
  stddev_ms: number;
  /** bigint counter, same as `calls`. */
  rows: string;
  /** bigint counters, same as `calls`. */
  shared_blks_hit: string;
  shared_blks_read: string;
  /**
   * int4 — `count(*)::int`, bounded by `pg_stat_statements.max`. Rides
   * along on every row for the same reason as `sessions.ts`'s and
   * `long-running.ts`'s own `total_matching`; see the SQL comment above
   * `SQL` for the full reasoning.
   */
  total_shapes: number;
  /** timestamptz cast to text — when these counters were last cleared, or null if never/unreadable. */
  stats_reset: string | null;
  /**
   * `o.sort` bound back as `$2` and echoed on every row (see the SQL
   * comment on why `map`, pure over `rows` alone, needs this). Kept `string`
   * here, narrowed to `QuerySort` in `map` via `isQuerySort` — a type guard,
   * not an `as` assertion (Convention 5).
   */
  requested_sort: string;
}

export interface QueryStatRowData {
  /** null when `redacted` — see below. */
  queryid: string | null;
  /** null, or the literal `'<insufficient privilege>'`, when `redacted`. */
  query: string | null;
  calls: number;
  totalMs: number;
  meanMs: number;
  stddevMs: number;
  rows: number;
  /** null when this shape has never touched the buffer cache (hit + read = 0) — not 0%, not 100%: unknown. */
  cacheHitPct: number | null;
  /**
   * Fix round 1: Postgres itself — not this check — decides whether the
   * calling role may see another role's `queryid`/`query` text. It answers
   * that by nulling/masking those two columns, never by omitting the row:
   * every cost figure (`calls`, `totalMs`, `meanMs`, ...) stays fully
   * populated regardless. `redacted` surfaces that distinction instead of
   * hiding it: a row this operator cannot IDENTIFY but can still see the
   * COST of is actionable ("your worst query is one you lack privileges to
   * view — granting pg_read_all_stats would reveal it"), which a silently
   * dropped row is not. See the SQL comment on `WHERE toplevel` for why no
   * privilege filter is applied before this point.
   */
  redacted: boolean;
}

export interface QueryStatsData {
  rows: QueryStatRowData[];
  /**
   * Every top-level shape visible to this role, before `LIMIT` clipped it —
   * "visible" per Postgres's OWN policy (redacted rows count; see
   * `redacted` above), not a stricter one this check imposes. `rows.length`
   * is a slice of it — Convention 6: a truncated list an operator knows is
   * truncated is useful; one they believe is complete is worse than nothing.
   */
  totalShapes: number;
  sort: QuerySort;
  /** When `pg_stat_statements_reset()` last ran, or null if never (in this server's uptime) or unreadable. */
  statsResetAt: string | null;
}

/**
 * ORDER BY expression per sort key, every one qualified `v.` — see the
 * top-of-file A4 comment for why the LIMIT and the sort must always agree,
 * and the file-bottom note for why keying off a closed union, rather than a
 * caller-supplied string, keeps this interpolation safe.
 *
 * The `v.` qualification is load-bearing, not decoration, for `calls` and
 * `cache`: Postgres resolves an unqualified `ORDER BY` name against the
 * SELECT list's OUTPUT column names first, ahead of the FROM-list's input
 * columns, when both exist under the same name. The SELECT below re-outputs
 * `calls` and `shared_blks_hit`/`shared_blks_read` under their OWN names
 * after casting them `::text` (Convention 1 — see QueryStatRow), so a bare
 * `ORDER BY calls DESC` would sort the TEXT output column lexicographically
 * — '5' sorts ahead of '11' as text — not the numeric input column. Caught
 * by query-stats.int.test.ts's "sorts by calls and by cache hit rate too"
 * test, which fails exactly this way without the qualifier. `total`/`mean`
 * don't collide (their output aliases are `total_ms`/`mean_ms`, not
 * `total_exec_time`/`mean_exec_time`) but are qualified anyway so the same
 * mistake can't reappear if either output alias is ever renamed to match.
 */
const ORDER: Record<QuerySort, string> = {
  total: 'v.total_exec_time DESC',
  mean: 'v.mean_exec_time DESC',
  calls: 'v.calls DESC',
  cache: `(CASE WHEN v.shared_blks_hit + v.shared_blks_read = 0 THEN NULL
                ELSE v.shared_blks_hit::float8 / (v.shared_blks_hit + v.shared_blks_read) END)
          ASC NULLS LAST`,
};

/**
 * Narrows the `$2`-echoed `requested_sort` column (genuinely `string` on
 * the wire — Postgres text, not a TypeScript union) back to `QuerySort`
 * without a type assertion (Convention 5): a user-defined type predicate,
 * checked against the same four literals `ORDER` is keyed by.
 */
function isQuerySort(x: string): x is QuerySort {
  return x === 'total' || x === 'mean' || x === 'calls' || x === 'cache';
}

/**
 * A5: `pg_stat_statements.toplevel` (PG14+, added alongside
 * `pg_stat_statements_info` in extension version 1.9 — bundled with every
 * server release this package supports, PG14 through 18, so the floor
 * `requires` below is the only gate needed) separates a PL/pgSQL function
 * call from the statements executed inside it. Without this filter, once an
 * operator sets `pg_stat_statements.track = all`, a function and its own
 * internals are counted as separate rows, `total_exec_time` sums to more
 * than 100% of wall clock, and the function competes against its own guts
 * for the top slot. `WHERE toplevel` keeps exactly the statements an
 * application actually issued.
 *
 * Fix round 1: an earlier revision also filtered `WHERE userid = current
 * user's oid OR pg_has_role(..., 'pg_read_all_stats', ...)`, on the theory
 * that a role without pg_read_all_stats can't see another role's rows at
 * all. Verified empirically against a live PostgreSQL 17.11: a role with
 * neither ownership nor pg_read_all_stats querying pg_stat_statements
 * directly still gets back every row that role's own toplevel/track scope
 * matches — including other users' — with `query` replaced by the literal
 * `<insufficient privilege>`, `queryid` NULLed, and every COST column
 * (calls, total/mean/stddev_exec_time, shared_blks_*) fully populated.
 * Postgres redacts the identifying columns; it does not drop the row. That
 * removed clause was strictly more restrictive than Postgres's own policy,
 * and it failed exactly where this check matters most: a monitoring role
 * distinct from the application roles, where `userid` matches almost
 * nothing and the check would have silently returned a near-empty result —
 * no error, indistinguishable from "no slow queries" — the same
 * silent-failure shape the missing-extension path exists to prevent, and
 * untestable by any integration test that connects as a superuser (every
 * one in this suite did; `userid = current_user` was always true, so the
 * `OR` branch never ran). Deleted; Postgres already enforces its own
 * policy correctly, and re-implementing it here was worse than deferring to
 * it. `QueryStatRowData.redacted` (see above) surfaces what Postgres
 * redacted instead of the check hiding it a second time by omission.
 *
 * I2 (final review): `dbid = (SELECT oid FROM pg_database WHERE datname =
 * current_database())`. `pg_stat_statements` is a CLUSTER-WIDE view — a
 * connection to one database reads back statements issued against every
 * other one — and `QueryStatRow` carries no `dbid` or `datname`. Unscoped,
 * this check ranked `app_staging`'s batch jobs against `app_prod`'s on a
 * shared instance, unlabelled, with nothing on any row an operator could use
 * to tell them apart.
 *
 * Scoped to the current database rather than fixed by adding a `datname`
 * column, because all three authorities on this point are per-database:
 * pgHero's own #14 `query_stats` joins `pg_database ON pg_database.oid =
 * pg_stat_statements.dbid` and filters the same way (registry.ts claims that
 * mapping); the spec's route is `/db/[name]/queries` (§6.2); and the spec's
 * `pgops.queries` / `pgops.query_stats` tables are keyed by `database_id`
 * (§4.2). The capture job that populates those tables knows which database
 * it connected to, so it can stamp the id itself — this check does not need
 * to return one.
 *
 * This is deliberately the OPPOSITE of what vitest.config.ts argues for
 * `sessions`, `locks`, `blocked` and `longRunning`, and the difference is
 * not an inconsistency. Those read `pg_stat_activity` / `pg_locks`, whose
 * rows carry a `pid` and could carry a `datname`, so nothing is hidden from
 * an operator by leaving them cluster-wide — and the resources they measure
 * (max_connections, the lock manager) genuinely ARE cluster-wide. Here the
 * rows carry no database identity at all, and the quantity being ranked is
 * per-database work.
 *
 * `toplevel_stats` is referenced twice below (the outer SELECT and the
 * `total_shapes` subquery). Postgres 12+ already materializes a
 * multiply-referenced CTE by default rather than inlining it, but
 * `MATERIALIZED` is spelled out explicitly so that guarantee doesn't depend
 * on planner heuristics that could differ across the PG14–18 matrix: the
 * whole point is exactly ONE scan of pg_stat_statements — see the note
 * below on why that scan's cost is judged acceptable here despite the
 * table's query-text payload.
 *
 * `total_shapes` (see QueryStatRow) rides along on every row so `map` — pure
 * over `rows` alone, with no access to `Opts`, same constraint as
 * sessions.ts's and long-running.ts's own `total_matching` — can report what
 * the LIMIT did not return, without needing the `limit` value itself.
 *
 * Cost note (Convention 6's caution): `count(*) OVER ()`, the technique
 * sessions.ts and long-running.ts use, forces Postgres to materialize every
 * matching row before LIMIT trims the payload — cheap against
 * pg_stat_activity, an in-memory view scoped to live connections. Here the
 * source is `pg_stat_statements`, whose SRF constructs a full row —
 * including the query text — for every call regardless of which columns a
 * query actually projects (it can't prune columns the way a real table
 * scan can), and the ORDER BY/LIMIT above must see every row's sort key to
 * pick the right survivors either way. So the "touch every matching row"
 * cost is inherent to this check's job, not created by the counting
 * technique. Two things keep it bounded rather than open-ended, unlike
 * pg_stat_activity's live-connection count during exactly the incident A7
 * worried about: `pg_stat_statements.max` is a fixed operator-configured
 * ceiling (default 5000, not a number that grows with load), and the
 * `toplevel` WHERE clause only shrinks that ceiling (fix round 1 removed
 * the privilege half — see above — without widening it back past that
 * ceiling: the row count doesn't change, only which columns are masked). A
 * single `count(*)` scalar subquery, reusing the one `MATERIALIZED` scan
 * via the CTE, is the cheapest way to get that count — cheaper than a
 * second `count(*) OVER ()` window column, which would carry the count on
 * every projected row of the (also-materialized) window input rather than
 * computing it once.
 */
const SQL = (o: QueryStatsOpts) => ({
  text: `
    WITH toplevel_stats AS MATERIALIZED (
      SELECT * FROM pg_stat_statements
      WHERE toplevel
        -- I2: pg_stat_statements is cluster-wide; this console is per
        -- database. See the comment above this template for why the scope
        -- is a dbid filter and not a datname column.
        AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    )
    SELECT v.queryid::text, v.query, v.calls::text,
           v.total_exec_time  AS total_ms,
           v.mean_exec_time   AS mean_ms,
           v.stddev_exec_time AS stddev_ms,
           v.rows::text,
           v.shared_blks_hit::text, v.shared_blks_read::text,
           (SELECT count(*) FROM toplevel_stats)::int AS total_shapes,
           (SELECT stats_reset::text FROM pg_stat_statements_info) AS stats_reset,
           $2::text AS requested_sort
    FROM toplevel_stats v
    ORDER BY ${ORDER[o.sort]}
    LIMIT $1`,
  values: [o.limit ?? 100, o.sort],
});

export const queryStats: Check<QueryStatRow, QueryStatsData, QueryStatsOpts> = {
  id: 'queryStats',
  gate: 'work',
  title: 'Query statistics',
  class: 'incident',
  sql: SQL,
  requires: [
    { kind: 'extension', name: 'pg_stat_statements' },
    { kind: 'version', min: 140000 },
  ],
  map: (rows) => {
    // Every row carries the same pre-LIMIT total, the same stats_reset, and
    // the same requested_sort (all computed/bound once — see the SQL
    // comment above `SQL` for why). `rows[0]` with a `?? 0` / `?? null`
    // fallback matches sessions.ts's and long-running.ts's own convention
    // for "possibly no rows at all". With zero rows there is no
    // `requested_sort` to read back either; `'total'` is an arbitrary
    // fallback in that case, and it IS operator-visible on `sort` — this
    // check cannot make it harmless by itself. It stays unobserved only
    // because the one caller today (apps/web's queries page) suppresses its
    // "sorted by …" label on an empty list, since nothing was actually
    // ordered. A future caller that renders `sort` unconditionally would
    // need the same care.
    const requested = rows[0]?.requested_sort ?? 'total';
    return {
      totalShapes: rows[0]?.total_shapes ?? 0,
      statsResetAt: rows[0]?.stats_reset ?? null,
      sort: isQuerySort(requested) ? requested : 'total',
      rows: rows.map((r) => {
        // calls/rows/shared_blks_hit/shared_blks_read are genuine bigint
        // counters (Convention 1) — `Number(...)` loses precision only past
        // 2^53 (~9.007e15). A shape would need to accumulate roughly nine
        // quadrillion calls, or the equivalent in block touches, between
        // resets to hit that ceiling — many orders of magnitude past
        // anything a real deployment's uptime (or `pg_stat_statements_reset`
        // cadence) produces. Judged safe; not proven safe by a runtime guard,
        // because a guard here would have nothing sane to do instead (this
        // package has no "degraded number" representation) — the honest
        // alternative would be keeping these as strings all the way to the
        // consumer, which every other numeric field in this package's
        // `*Data` shapes (headroom, txnsUntilShutdown, runningSecs, ...) does
        // not do either.
        const calls = Number(r.calls);
        const rowsCount = Number(r.rows);
        const hit = Number(r.shared_blks_hit);
        const read = Number(r.shared_blks_read);
        return {
          queryid: r.queryid,
          query: r.query,
          calls,
          totalMs: r.total_ms,
          meanMs: r.mean_ms,
          stddevMs: r.stddev_ms,
          rows: rowsCount,
          cacheHitPct: hit + read === 0 ? null : (100 * hit) / (hit + read),
          // Fix round 1: Postgres nulls `queryid` for a row this role can't
          // fully see (see the SQL comment on `WHERE toplevel`); it also
          // replaces `query` with the literal `'<insufficient privilege>'`.
          // Checking both, rather than only `queryid`, is defensive against
          // either signal alone changing across a PG minor version — either
          // one is sufficient evidence Postgres, not this check, redacted
          // the row.
          redacted: r.queryid == null || r.query === '<insufficient privilege>',
        };
      }),
    };
  },
};

/*
 * Note on `ORDER[o.sort]`: this is the one place in this check a value
 * reaches SQL text outside a bind parameter. It is safe because `ORDER` is
 * a closed `Record<QuerySort, string>` keyed by the `QuerySort` union — no
 * caller-supplied string ever reaches it; `o.sort` can only ever be one of
 * the four literal keys TypeScript already knows about. Do not widen
 * `QuerySort` to `string`, and do not add a fifth key without adding its
 * `ORDER` entry in the same change.
 */

export interface SlowQueryOpts {
  minCalls?: number;
  minMeanMs?: number;
}

/**
 * pgHero's defaults (lib/pghero.rb:44-45), adopted rather than re-derived —
 * the same provenance rule the hygiene thresholds follow in the P2 spec §2.1.
 */
export const SLOW_QUERY_DEFAULTS = { minCalls: 100, minMeanMs: 20 } as const;

/**
 * pgHero's #17, which is a FILTER over query_stats, not a query of its own
 * (`query_stats.select { |q| q[:calls] >= slow_query_calls && q[:average_time]
 * >= slow_query_ms }`). Implemented the same way: a second
 * pg_stat_statements scan to re-derive rows the caller already has would cost
 * a round trip and give a second, inconsistent snapshot.
 *
 * Both bounds must hold. Either alone is a bad filter: a query called twice
 * that takes a second is a one-off, and a query called a million times at 1ms
 * is the database doing its job.
 *
 * Inherits `queryStats`'s LIMIT, exactly as pgHero's inherits its
 * `query_stats(**options)` limit — a slow shape outside the top N by the
 * caller's sort is not surfaced, and no single sort fixes that: this filter
 * is a CONJUNCTION over two axes (`calls >= minCalls AND meanMs >=
 * minMeanMs`), and a top-N window ordered by either axis alone is blind to
 * the other — sorting by `mean` fills the window with one-off expensive
 * statements that never reach `minCalls`, sorting by `calls` fills it with
 * high-volume statements too cheap to reach `minMeanMs`. No ordering makes
 * this list definitive; only disclosing the truncation (see the doc comment
 * on the caller side, apps/web's queries page) does.
 *
 * Takes only the one field it reads, not the full `QueryStatsData` — a
 * caller that already extracted `{ rows }` (or a test fixture that never
 * populates `totalShapes`/`sort`/`statsResetAt`, all irrelevant to a filter)
 * satisfies this without fabricating the rest of the shape. A caller that
 * needs to disclose truncation (comparing `rows.length` against
 * `totalShapes`, as the queries page does) reads `totalShapes` itself from
 * its own `QueryStatsData` — `slowQueries` has no reason to pass it through.
 */
export function slowQueries(
  data: Pick<QueryStatsData, 'rows'>,
  opts: SlowQueryOpts = {},
): QueryStatRowData[] {
  const minCalls = opts.minCalls ?? SLOW_QUERY_DEFAULTS.minCalls;
  const minMeanMs = opts.minMeanMs ?? SLOW_QUERY_DEFAULTS.minMeanMs;
  return data.rows.filter((r) => r.calls >= minCalls && r.meanMs >= minMeanMs);
}
