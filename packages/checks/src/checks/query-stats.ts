import type { Check } from '../types.js';
import { OWN_SQL_MARKER } from '../run.js';

/**
 * The sort is applied in SQL, with the LIMIT, so "top by mean" ranks every
 * shape and not only the top 100 by total time.
 *
 * `cache` sorts ascending: the worst cache hit rate is the smallest. A
 * shape with no I/O (hit + read = 0) sorts last.
 */
export type QuerySort = 'total' | 'mean' | 'calls' | 'cache';

export interface QueryStatsOpts {
  sort: QuerySort;
  limit?: number;
  /**
   * Show pgops's own marked statements. Default false: this package's own
   * catalog reads would otherwise rank among the top shapes.
   */
  showOurs?: boolean;
  /** Only this shape. The sum and the counts are still every shape's. */
  queryid?: string;
}

export interface QueryStatRow {
  /** bigint hash, kept as a string. NULL when Postgres redacts the row. */
  queryid: string | null;
  /** `'<insufficient privilege>'` when redacted. */
  query: string | null;
  /** bigint counter, as text. */
  calls: string;
  /** double precision milliseconds, which node-pg returns as a JS number. */
  total_ms: number;
  mean_ms: number;
  stddev_ms: number;
  /** bigint counter, as text. */
  rows: string;
  /** bigint counters, as text. */
  shared_blks_hit: string;
  shared_blks_read: string;
  /** The count before LIMIT, on every row. */
  total_shapes: number;
  /**
   * How many of `total_shapes` end with OWN_SQL_MARKER. Counted regardless
   * of `showOurs`.
   */
  own_shapes: number;
  /** When these counters were last cleared, or null if never or unreadable. */
  stats_reset: string | null;
  /**
   * `o.sort` echoed back on every row, because `map` cannot see `Opts`.
   * Narrowed to `QuerySort` by `isQuerySort`.
   */
  requested_sort: string;
  all_ms: number;
}

export interface QueryStatRowData {
  /** null when `redacted`. */
  queryid: string | null;
  /** null, or the literal `'<insufficient privilege>'`, when `redacted`. */
  query: string | null;
  calls: number;
  totalMs: number;
  meanMs: number;
  stddevMs: number;
  rows: number;
  /** null when this shape has never touched the buffer cache: unknown, not 0%. */
  cacheHitPct: number | null;
  /**
   * Postgres masked `queryid`/`query` because this role may not see another
   * role's statement text. The cost figures are still populated, so the row
   * is kept and flagged, not dropped.
   */
  redacted: boolean;
}

export interface QueryStatsData {
  rows: QueryStatRowData[];
  /**
   * Every top-level shape visible to this role before the LIMIT, redacted
   * rows included. `rows` is a slice of it.
   */
  totalShapes: number;
  /** How many of `totalShapes` are pgops's own, whether or not shown. */
  ownShapes: number;
  sort: QuerySort;
  /** When `pg_stat_statements_reset()` last ran, or null if never or unreadable. */
  statsResetAt: string | null;
  /** Every top-level shape's execution time, own statements included: the denominator of a share. */
  allMs: number;
}

/**
 * ORDER BY expression per sort key. Interpolated into SQL text, which is
 * safe only because the keys are the closed `QuerySort` union: do not widen
 * it to `string`.
 *
 * The `v.` qualifier is required for `calls` and `cache`: an unqualified
 * ORDER BY name resolves to the SELECT list's output column first, and those
 * are `::text`, so they would sort lexicographically
 * (query-stats.int.test.ts holds this).
 */
const ORDER: Record<QuerySort, string> = {
  total: 'v.total_exec_time DESC',
  mean: 'v.mean_exec_time DESC',
  calls: 'v.calls DESC',
  cache: `(CASE WHEN v.shared_blks_hit + v.shared_blks_read = 0 THEN NULL
                ELSE v.shared_blks_hit::float8 / (v.shared_blks_hit + v.shared_blks_read) END)
          ASC NULLS LAST`,
};

function isQuerySort(x: string): x is QuerySort {
  return x === 'total' || x === 'mean' || x === 'calls' || x === 'cache';
}

/**
 * `WHERE toplevel` (PG14+) keeps the statements an application issued. With
 * `pg_stat_statements.track = all`, a function and the statements inside it
 * are otherwise separate rows and total time sums past wall clock.
 *
 * No privilege filter: for a role without pg_read_all_stats, Postgres still
 * returns other roles' rows, with `query` masked, `queryid` NULL and every
 * cost column populated. `redacted` surfaces those rows.
 *
 * Scoped by `dbid` to the current database: pg_stat_statements is
 * cluster-wide and this check's rows carry no database identity.
 *
 * `MATERIALIZED` guarantees one scan of pg_stat_statements, whose function
 * builds every row, query text included, whatever is projected. The counts
 * are scalar subqueries over that one scan, and the row count is bounded by
 * `pg_stat_statements.max` (default 5000).
 *
 * Every statement this package runs ends with `OWN_SQL_MARKER` (run.ts).
 * It is matched as a suffix because PostgreSQL 18 drops a leading comment
 * from the text pg_stat_statements stores; a prefix match finds nothing
 * there. Own rows are filtered from `rows` unless `showOurs`, but
 * `own_shapes` and `total_shapes` count the unfiltered CTE.
 *
 * `v.query IS NULL OR`: a redacted row with a null `query` makes the LIKE
 * NULL, which would drop it. A row that cannot be identified as pgops's own
 * is shown.
 */
const SQL = (o: QueryStatsOpts) => ({
  text: `
    WITH toplevel_stats AS MATERIALIZED (
      SELECT * FROM pg_stat_statements
      WHERE toplevel
        -- pg_stat_statements is cluster-wide; this console is per database.
        AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
    )
    SELECT v.queryid::text, v.query, v.calls::text,
           v.total_exec_time  AS total_ms,
           v.mean_exec_time   AS mean_ms,
           v.stddev_exec_time AS stddev_ms,
           v.rows::text,
           v.shared_blks_hit::text, v.shared_blks_read::text,
           (SELECT count(*) FROM toplevel_stats)::int AS total_shapes,
           (SELECT count(*) FROM toplevel_stats t WHERE t.query LIKE '%' || $3::text)::int AS own_shapes,
           (SELECT stats_reset::text FROM pg_stat_statements_info) AS stats_reset,
           (SELECT COALESCE(sum(t.total_exec_time), 0) FROM toplevel_stats t) AS all_ms,
           $2::text AS requested_sort
    FROM toplevel_stats v
    WHERE ($4::bool OR v.query IS NULL OR v.query NOT LIKE '%' || $3::text)
      AND ($5::text IS NULL OR v.queryid::text = $5)
    ORDER BY ${ORDER[o.sort]}
    LIMIT $1`,
  values: [o.limit ?? 100, o.sort, OWN_SQL_MARKER, o.showOurs ?? false, o.queryid ?? null],
});

export const queryStats: Check<QueryStatRow, QueryStatsData, QueryStatsOpts> = {
  id: 'queryStats',
  gate: 'work',
  home: 'query',
  title: 'Query statistics',
  class: 'live',
  sql: SQL,
  requires: [
    { kind: 'extension', name: 'pg_stat_statements' },
    { kind: 'version', min: 140000 },
  ],
  map: (rows) => {
    // With zero rows there is no `requested_sort` to read back, so `sort`
    // falls back to `'total'` whatever was asked. A caller must not render
    // `sort` for an empty list.
    const requested = rows[0]?.requested_sort ?? 'total';
    return {
      totalShapes: rows[0]?.total_shapes ?? 0,
      ownShapes: rows[0]?.own_shapes ?? 0,
      statsResetAt: rows[0]?.stats_reset ?? null,
      allMs: rows[0]?.all_ms ?? 0,
      sort: isQuerySort(requested) ? requested : 'total',
      rows: rows.map((r) => {
        // bigint counters: `Number(...)` loses precision only past 2^53,
        // which is judged unreachable. There is no runtime guard.
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
          // Postgres nulls `queryid` and masks `query`; either is enough.
          redacted: r.queryid == null || r.query === '<insufficient privilege>',
        };
      }),
    };
  },
};

export interface SlowQueryOpts {
  minCalls?: number;
  minMeanMs?: number;
}

/** pgHero's defaults. */
export const SLOW_QUERY_DEFAULTS = { minCalls: 100, minMeanMs: 20 } as const;

/**
 * A filter over `queryStats` rows the caller already has, not a second
 * query. Both bounds must hold.
 *
 * It inherits `queryStats`'s LIMIT, so a slow shape outside the top N by
 * the caller's sort is not surfaced, and no single sort fixes that. The
 * caller must disclose the truncation.
 */
export function slowQueries(
  data: Pick<QueryStatsData, 'rows'>,
  opts: SlowQueryOpts = {},
): QueryStatRowData[] {
  const minCalls = opts.minCalls ?? SLOW_QUERY_DEFAULTS.minCalls;
  const minMeanMs = opts.minMeanMs ?? SLOW_QUERY_DEFAULTS.minMeanMs;
  return data.rows.filter((r) => r.calls >= minCalls && r.meanMs >= minMeanMs);
}
