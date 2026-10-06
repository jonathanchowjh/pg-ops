import type { Check } from '../types.js';
import {
  DEFAULT_LIMIT, rateVerdict, toRate, visibleSchemas,
  type HitRateData, type HitRateRow, type ListOpts,
} from './indexes.js';

/**
 * #33. The heap half of §6's NULL case, and it imports `toRate`/`rateVerdict`
 * from indexes.ts rather than restating them — the trap they exist to stop
 * (an unmeasurable rate reading as 0% against a 99% threshold, so every
 * freshly started database warns) has exactly one implementation to get
 * right.
 *
 * pgHero writes `sum(hit) / nullif(sum(hit) + sum(read), 0)` where indexes.ts
 * writes `sum(hit) / nullif(sum(hit + read), 0)`. The two differ only if a
 * row has NULL in one column and a value in the other; verified on 17.11 that
 * `pg_statio_user_tables` has no NULLs in either column, including for a
 * partition. pgHero's spelling is kept here so the parity claim is checkable
 * against the source it claims parity with.
 *
 * No `::numeric` cast on the numerator, unlike `tableCaching` below: `sum()`
 * over a bigint already returns numeric, so this division was never the
 * integer division that bug was about.
 */
const TABLE_HIT_RATE_SQL = `
SELECT (sum(heap_blks_hit) / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0))::text AS rate
FROM pg_statio_user_tables
WHERE ${visibleSchemas('schemaname')}`;

export const tableHitRate: Check<HitRateRow, HitRateData> = {
  id: 'tableHitRate',
  title: 'Table cache hit rate',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: TABLE_HIT_RATE_SQL,
  map: toRate,
  thresholds: [
    { level: 'warn', value: 99, unit: 'percent',
      because: "pgHero's cache_hit_rate_threshold (lib/pghero.rb) is 99; adopted for "
             + 'parity, not re-derived from Postgres behaviour',
      remedy: 'A low rate means heap pages are being read from disk. The per-table '
            + 'breakdown below says whether that is one big scan of one table or a '
            + 'cache too small for the whole working set, and those want different '
            + 'answers — the first is a query to look at, the second is memory.' },
  ],
  verdict: rateVerdict,
};

export interface TableCachingRow {
  table_name: string;
  hit_rate: string | null;
  total: number;
}

export interface TableCaching {
  table: string;
  /** `null` means no heap I/O yet — never 0%. See the docblock. */
  hitRate: number | null;
}

export interface TableCachingData {
  tables: TableCaching[];
  total: number;
  truncated: boolean;
}

export function toTableCaching(rows: TableCachingRow[]): TableCachingData {
  const total = rows[0]?.total ?? 0;
  return {
    tables: rows.map((r) => ({
      table: r.table_name,
      // Same null discipline and the same rounding as `toRate`, so one
      // table's rate and the database-wide rate are one value formatted one
      // way.
      hitRate: r.hit_rate === null ? null : Math.round(Number(r.hit_rate) * 10000) / 100,
    })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * #34, and a deliberate divergence from pgHero on its one interesting line.
 *
 * pgHero writes `CASE WHEN heap_blks_hit + heap_blks_read = 0 THEN 0 ELSE
 * ROUND(1.0 * heap_blks_hit / (...), 2) END`, so a table nothing has read yet
 * renders as 0% cached. That is a fabricated worst-case reading, and on a
 * page ranked by how bad the reading is it sorts to the top — every idle
 * table crowding out the one with a real problem. `nullif` instead, and the
 * null survives into the domain type. Same divergence `indexCaching` carries.
 *
 * `heap_blks_hit::numeric` is load-bearing. Both columns are bigint, and
 * without the cast Postgres does INTEGER division: a table with 1016 hits and
 * 3 reads returns 1, not 0.997. This is the bug Task 2 found in the
 * per-index form of the same query, and it does not announce itself — the
 * answer is a plausible-looking whole number.
 *
 * Ordered by total I/O descending, not pgHero's `ORDER BY 2 DESC, 1` (which
 * is `relname` descending — reverse-alphabetical, and nothing to do with the
 * reading). The cap should drop the tables nobody touches, not the ones after
 * "m".
 */
const TABLE_CACHING_SQL = `
SELECT
  schemaname || '.' || relname AS table_name,
  (heap_blks_hit::numeric / nullif(heap_blks_hit + heap_blks_read, 0))::text AS hit_rate,
  count(*) OVER ()::int AS total
FROM pg_statio_user_tables
WHERE ${visibleSchemas('schemaname')}
ORDER BY (heap_blks_hit + heap_blks_read) DESC, relname
LIMIT $1`;

export const tableCaching: Check<TableCachingRow, TableCachingData, ListOpts> = {
  id: 'tableCaching',
  title: 'Table caching',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: TABLE_CACHING_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toTableCaching,
  // No verdict: §2.2.
};

export interface UnusedTableRow {
  table_name: string;
  estimated_rows: string;
  total: number;
}

export interface UnusedTable {
  table: string;
  estimatedRows: number;
}

export interface UnusedTableData {
  tables: UnusedTable[];
  total: number;
  truncated: boolean;
}

export function toUnusedTables(rows: UnusedTableRow[]): UnusedTableData {
  const total = rows[0]?.total ?? 0;
  return {
    tables: rows.map((r) => ({
      table: r.table_name,
      estimatedRows: Number(r.estimated_rows),
    })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * #35, and the filter is `idx_scan = 0` — pgHero's, verbatim.
 *
 * The important thing about that clause is what it does NOT match.
 * `idx_scan` is **NULL**, not 0, for a table that has no indexes at all, so
 * `= 0` excludes every such table. Verified identical on 14.24 and 18.6: a
 * bare `CREATE TABLE no_pk (v int)` reads `idx_scan = NULL`, while
 * `CREATE TABLE with_pk (id int PRIMARY KEY)` reads 0.
 *
 * That exclusion is correct, not a null being collapsed. This check asks "are
 * this table's indexes being used?", and for a table with no indexes the
 * question has no answer — listing it under the heading "unused tables" would
 * say something false about it. The table with no index and a lot of rows is
 * a real finding, but it belongs to #28 `missing_indexes`, which is the check
 * that reasons about seq_scan against idx_scan and n_live_tup.
 *
 * Which is also why this cannot be reformulated on `seq_scan = 0` to "fix"
 * the exclusion: `CREATE INDEX` scans the heap and charges it to `seq_scan`,
 * so a table acquires `seq_scan = 1` before anything queries it. Verified on
 * 17.11 — a table populated with 1000 rows and then indexed reads
 * `seq_scan = 1, seq_tup_read = 1000`. A seq_scan filter would report only
 * tables that never had any index, including a primary key, AND were never
 * read; pinned by a test so it is not re-derived.
 */
const UNUSED_TABLES_SQL = `
SELECT
  schemaname || '.' || relname AS table_name,
  n_live_tup::text AS estimated_rows,
  count(*) OVER ()::int AS total
FROM pg_stat_user_tables
WHERE idx_scan = 0
  AND ${visibleSchemas('schemaname')}
ORDER BY n_live_tup DESC, relname
LIMIT $1`;

export const unusedTables: Check<UnusedTableRow, UnusedTableData, ListOpts> = {
  id: 'unusedTables',
  // A7: the count reaches the hygiene cache and so the triage page and the
  // overview, without a verdict being invented for a finding that is worth
  // doing something about and is not a reason to call a database unwell.
  found: (d) => (d.total === 0 ? null : `${d.total} ${d.total === 1 ? 'unused table' : 'unused tables'}`),
  title: 'Unused tables',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: UNUSED_TABLES_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toUnusedTables,
  // No verdict: §2.2.
};

export interface TableStatsRow {
  table_name: string;
  live_rows: string;
  dead_rows: string;
  last_vacuum: Date | null;
  last_autovacuum: Date | null;
  last_analyze: Date | null;
  last_autoanalyze: Date | null;
  total: number;
}

export interface TableStat {
  table: string;
  liveRows: number;
  deadRows: number;
  /** All four are `null` for "never", which is a reading, not a gap. */
  lastVacuum: Date | null;
  lastAutovacuum: Date | null;
  lastAnalyze: Date | null;
  lastAutoanalyze: Date | null;
}

export interface TableStatsData {
  tables: TableStat[];
  total: number;
  truncated: boolean;
}

export function toTableStats(rows: TableStatsRow[]): TableStatsData {
  const total = rows[0]?.total ?? 0;
  return {
    tables: rows.map((r) => ({
      table: r.table_name,
      liveRows: Number(r.live_rows),
      deadRows: Number(r.dead_rows),
      // Passed through, not defaulted. `null` here means this table has never
      // been vacuumed or analysed by that route — which is the finding on a
      // keep-up page, and `new Date(0)` or "now" would both hide it.
      lastVacuum: r.last_vacuum,
      lastAutovacuum: r.last_autovacuum,
      lastAnalyze: r.last_analyze,
      lastAutoanalyze: r.last_autoanalyze,
    })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * #36, and the shape diverges from pgHero's deliberately.
 *
 * pgHero's `table_stats` returns `(schema, table, reltuples, size_bytes)`
 * from `pg_class`. pgops returns live and dead tuple counts and the four
 * maintenance timestamps from `pg_stat_user_tables` instead, for two reasons.
 * Size is already #39 `table_sizes`, so pgHero's version of this check is
 * mostly a duplicate of its neighbour; and this check's gate is `keep-up`,
 * where the question is "is maintenance falling behind on this table?" —
 * which dead tuples and a last-vacuum time answer and a row count does not.
 *
 * `gate: 'keep-up'` while the page renders on `work`, one of the three the
 * spec names. Do not "fix" it to match its page.
 *
 * Ordered by dead tuples descending so the cap drops the tables that are
 * keeping up, not the ones that are not.
 */
const TABLE_STATS_SQL = `
SELECT
  schemaname || '.' || relname AS table_name,
  n_live_tup::text AS live_rows,
  n_dead_tup::text AS dead_rows,
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze,
  count(*) OVER ()::int AS total
FROM pg_stat_user_tables
WHERE ${visibleSchemas('schemaname')}
ORDER BY n_dead_tup DESC, relname
LIMIT $1`;

export const tableStats: Check<TableStatsRow, TableStatsData, ListOpts> = {
  id: 'tableStats',
  title: 'Table stats',
  gate: 'keep-up',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: TABLE_STATS_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toTableStats,
  // No verdict: §2.2.
};
