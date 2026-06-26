import { query } from '../../core/connection.js';

/**
 * Live slow-query view over pg_stat_statements (plan §A2).
 *
 * Unlike `locks` (which reads the always-present pg_locks), this reads the
 * pg_stat_statements EXTENSION — aggregated per-query timing across every call.
 * It must be in shared_preload_libraries and created with CREATE EXTENSION; if
 * it isn't, the query errors and the view surfaces an install hint (handled in
 * index.tsx, the same place locks surfaces connection errors).
 *
 * Design mirror of locks/query.ts:
 *   - the SQL does the cheap, bounded fetch (top 100 by total time) — we never
 *     pull the whole table, which can hold thousands of distinct query shapes;
 *   - sorting/filtering/deriving lives in the PURE transform (stats.ts), so it's
 *     unit-testable with no database, exactly like chain.ts.
 *
 * Column names are the PG 13+ spelling (total_exec_time, mean_exec_time). PG 13
 * renamed them from total_time/mean_time; every version in our support matrix
 * (13–18) uses the new names, so no version branch is needed for v0.
 */
const TOP_SQL = `
SELECT
  queryid,
  query,
  calls,
  total_exec_time   AS total_ms,
  mean_exec_time    AS mean_ms,
  stddev_exec_time  AS stddev_ms,
  rows,
  shared_blks_hit,
  shared_blks_read
FROM pg_stat_statements
-- Only this role's statements unless it can read all (pg_read_all_stats). A
-- non-superuser without that role sees just its own queries; that's fine —
-- we show what we're allowed to see rather than erroring.
WHERE userid = (SELECT usesysid FROM pg_user WHERE usename = current_user)
   OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
ORDER BY total_exec_time DESC
LIMIT 100;
`;

/** One aggregated query-shape row from pg_stat_statements (raw, pre-transform). */
export interface QueryStat {
  /** Stable hash of the normalized query; bigint, so pg hands it back as a string. */
  queryid: string | null;
  /** Normalized query text (literals stripped by pg_stat_statements). */
  query: string | null;
  calls: number;
  /** Total time across all calls, ms. The default sort — "what cost us the most." */
  totalMs: number;
  /** Mean time per call, ms. */
  meanMs: number;
  /** Stddev of per-call time, ms — high = inconsistent (plan flips, lock waits). */
  stddevMs: number;
  /** Total rows returned/affected across all calls. */
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
}

export async function fetchQueryStats(): Promise<QueryStat[]> {
  // EXTRACT/numeric columns come back as strings from pg; coerce once here so
  // the rest of the pipeline (stats.ts, render.ts, the view) deals in numbers.
  const rows = await query<Record<string, unknown>>(TOP_SQL);
  return rows.map((r) => ({
    queryid: r.queryid == null ? null : String(r.queryid),
    query: (r.query as string) ?? null,
    calls: Number(r.calls),
    totalMs: Number(r.total_ms),
    meanMs: Number(r.mean_ms),
    stddevMs: Number(r.stddev_ms),
    rows: Number(r.rows),
    sharedBlksHit: Number(r.shared_blks_hit),
    sharedBlksRead: Number(r.shared_blks_read),
  }));
}
