import type { Threshold, Verdict } from '../types.js';

/**
 * What several checks share: the list cap, the schema filter, and the few
 * conversions and comparisons that would otherwise be written out per check.
 */

/**
 * The cap every list check shares. A capped list carries its true total via
 * `count(*) OVER ()`, and verdicts read that total, never `rows.length`.
 */
interface ListOpts { limit?: number }

/**
 * A list check that can be asked about one relation.
 *
 * The filter is a nullable parameter in the WHERE, so it runs ahead of the
 * LIMIT. It compares against `nspname || '.' || relname`, not a cast:
 * `::regclass::text` and `::regnamespace` parse identifier syntax and break
 * on a schema named "Weird Schema".
 */
export interface RelationOpts extends ListOpts { relation?: string }

/**
 * What a role without pg_read_all_stats sees of another role's session,
 * probed on 14 and 17 on 2026-10-19: its database, user and application,
 * with `backend_type`, `state` and the query nulled. A background process
 * has no database, and none has a user but the logical replication
 * launcher, which has no database. So a row with a database, a user and no
 * backend type is a client this role cannot read.
 */
export const unreadableClient = (a = ''): string =>
  `(${a}backend_type IS NULL AND ${a}datname IS NOT NULL AND ${a}usesysid IS NOT NULL)`;

/** A client backend, readable or not: what draws from `max_connections`. */
export const anyClient = (a = ''): string => `(${a}backend_type = 'client backend' OR ${unreadableClient(a)})`;

/** The name pgops's pools connect under; the store's is this with `-store`. */
export const PGOPS_APP = 'pgops';

/**
 * A pgops connection, by the names its pools set, exactly. A prefix, or the
 * connection's own `application_name`, would hide an application that a
 * URL's `?application_name=` named the same. A pgops connection whose URL
 * renames it shows as anyone's: this over-shows and never hides.
 */
export const ownSession = (col: string): string => `${col} IN ('${PGOPS_APP}', '${PGOPS_APP}-store')`;

/** The row cap every list check in this package shares. */
export const DEFAULT_LIMIT = 100;

/**
 * The schema filter for catalog queries. Names are always qualified as
 * `nspname || '.' || relname`: a bare `relname` is ambiguous across schemas,
 * and `::regclass::text` qualifies only outside `search_path`.
 *
 * Two clauses: `NOT IN (...)` is exact-match and lets `pg_temp_7` and
 * `pg_toast_temp_7` through; `NOT LIKE 'pg\\_%'` excludes them. The doubled
 * backslash is needed in a JS template literal, or `_` reaches Postgres as a
 * wildcard.
 *
 * Takes the column because the `pg_stat_user_tables` /
 * `pg_statio_user_tables` views expose `schemaname`, and their own
 * definition does not exclude `pg_temp_N`.
 */
export function visibleSchemas(col: string): string {
  return `${col} NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND ${col} NOT LIKE 'pg\\_%'`;
}

/**
 * The pre-LIMIT total a capped query carries on every row as `total`, and
 * whether the cap dropped any.
 */
export function capped(rows: readonly { total: number }[]): { total: number; truncated: boolean } {
  const total = rows[0]?.total ?? 0;
  return { total, truncated: total > rows.length };
}

/** "1 unused index", "3 unused indexes". */
export function counted(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * The verdict for a reading that gets worse as it grows: critical at or
 * above the critical threshold, else warn at or above the warn one. `>=`,
 * because a threshold is the value at which the condition becomes a problem.
 * A level with no threshold never fires.
 */
export function escalate(value: number, thresholds: Threshold[], note: string): Verdict {
  const crit = thresholds.find((t) => t.level === 'critical');
  if (crit && value >= crit.value) return { level: 'critical', note };
  const warn = thresholds.find((t) => t.level === 'warn');
  if (warn && value >= warn.value) return { level: 'warn', note };
  return { level: 'ok' };
}
