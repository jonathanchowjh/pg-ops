import type { Check } from '../types.js';
import { DEFAULT_LIMIT, visibleSchemas, type ListOpts } from './indexes.js';

export interface DatabaseSizeRow { size_bytes: string | null }
/** `null` means "we could not read one", never a zero-byte database. */
export interface DatabaseSizeData { sizeBytes: number | null }

export function toDatabaseSize(rows: DatabaseSizeRow[]): DatabaseSizeData {
  const raw = rows[0]?.size_bytes;
  if (raw === undefined || raw === null) return { sizeBytes: null };
  return { sizeBytes: Number(raw) };
}

/**
 * #37, and §3's divergence from pgHero applies to all three checks here.
 *
 * pgHero returns `PgHero.pretty_size(...)` — the string `"8192 MB"` — which
 * cannot be thresholded, compared, summed or charted. P4 charts space growth
 * from exactly these numbers, so bytes cross the boundary and formatting
 * happens at the surface that renders them.
 *
 * `::text` because the value is bigint: node-postgres would otherwise round a
 * large database through a float64.
 */
const DATABASE_SIZE_SQL = 'SELECT pg_database_size(current_database())::text AS size_bytes';

export const databaseSize: Check<DatabaseSizeRow, DatabaseSizeData> = {
  id: 'databaseSize',
  title: 'Database size',
  gate: 'keep-up',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: DATABASE_SIZE_SQL,
  map: toDatabaseSize,
  // No verdict: §2.2. There is no size at which a database is "wrong".
};

export type RelationKind = 'table' | 'matview' | 'index';

export interface RelationSizeRow {
  name: string;
  type: RelationKind;
  size_bytes: string;
  total: number;
}

export interface RelationSize {
  name: string;
  type: RelationKind;
  sizeBytes: number;
}

export interface RelationSizeData {
  relations: RelationSize[];
  total: number;
  truncated: boolean;
}

export function toRelationSizes(rows: RelationSizeRow[]): RelationSizeData {
  const total = rows[0]?.total ?? 0;
  return {
    relations: rows.map((r) => ({ name: r.name, type: r.type, sizeBytes: Number(r.size_bytes) })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * The two size functions are NOT interchangeable, and choosing the wrong one
 * here is not a rounding error — it double-counts every index in the database.
 *
 * `pg_total_relation_size(t)` already includes `t`'s indexes and its TOAST
 * relation. This check lists RELATIONS, indexes among them, so using it per
 * row counts each index twice: once inside its table's figure and once as its
 * own row. Measured during review at 76,693,504 bytes of rows describing a
 * 56,481,459-byte database — a list that sums to more than the thing it
 * describes.
 *
 * `pg_table_size` is the per-relation figure, and it is what pgHero uses for
 * this capability (methods/space.rb): `relkind IN ('r','m','i')` with
 * `pg_table_size`, against `relkind = 'r'` with `pg_total_relation_size` for
 * #39 below. Confirmed against the 4.0.1 source, not inferred.
 *
 * The size is computed ONCE, in the CTE, and both the filter and the ordering
 * read that column. Calling the function in `SELECT`, `WHERE` and `ORDER BY`
 * evaluates it three times per row — and worse, makes the `IS NOT NULL` guard
 * incoherent, since the call that passed the filter is not the call whose
 * value is returned.
 *
 * That guard is real: `pg_table_size` on an oid that no longer exists returns
 * NULL rather than raising (verified on 17.11 with `999999999::oid`), which is
 * what a relation dropped mid-scan looks like. It cannot eliminate the race —
 * the catalog scan and the function call are still separate — but it keeps a
 * NULL out of the arithmetic.
 *
 * The schema filter is the package's shared one, which is WIDER than pgHero's.
 * pgHero writes `NOT IN ('pg_catalog','information_schema') AND nspname !~
 * '^pg_toast'`, and that lets every `pg_temp_N` through — so another session's
 * scratch tables appear on the page, under a schema the reader cannot reach.
 */
const RELATION_SIZES_SQL = `
WITH rel AS (
  SELECT
    n.nspname || '.' || c.relname AS name,
    CASE c.relkind WHEN 'r' THEN 'table' WHEN 'm' THEN 'matview' ELSE 'index' END AS type,
    pg_table_size(c.oid) AS size_num
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'm', 'i')
    AND ${visibleSchemas('n.nspname')}
)
SELECT name, type, size_num::text AS size_bytes, count(*) OVER ()::int AS total
FROM rel
WHERE size_num IS NOT NULL
ORDER BY size_num DESC, name
LIMIT $1`;

export const relationSizes: Check<RelationSizeRow, RelationSizeData, ListOpts> = {
  id: 'relationSizes',
  title: 'Relation sizes',
  gate: 'keep-up',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: RELATION_SIZES_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toRelationSizes,
  // No verdict: §2.2.
};

export interface TableSizeRow {
  name: string;
  size_bytes: string;
  total: number;
}

export interface TableSize {
  name: string;
  sizeBytes: number;
}

export interface TableSizeData {
  relations: TableSize[];
  total: number;
  truncated: boolean;
}

export function toTableSizes(rows: TableSizeRow[]): TableSizeData {
  const total = rows[0]?.total ?? 0;
  return {
    relations: rows.map((r) => ({ name: r.name, sizeBytes: Number(r.size_bytes) })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * #39, and here `pg_total_relation_size` IS the right function: this check
 * answers "how big is this table", and nobody asking that means the heap
 * alone. Indexes and TOAST are counted in, and no index appears as a row of
 * its own — which is exactly why the same table reads larger here than it does
 * through #38 above.
 *
 * `relkind = 'r'` follows pgHero and excludes partitioned parents (`'p'`),
 * which is correct rather than an oversight: a partitioned parent has no
 * storage, so `pg_total_relation_size` on one is 0 and it would render as a
 * zero-byte table at the bottom of a list sorted by size. The partitions
 * themselves are `'r'` and appear on their own.
 *
 * Ordered size DESC so the cap drops the SMALL relations. A size list that
 * truncates the largest row has hidden the only thing anyone opened it for —
 * §5's rule, which for this check is about the ordering as much as the total.
 */
const TABLE_SIZES_SQL = `
WITH rel AS (
  SELECT
    n.nspname || '.' || c.relname AS name,
    pg_total_relation_size(c.oid) AS size_num
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND ${visibleSchemas('n.nspname')}
)
SELECT name, size_num::text AS size_bytes, count(*) OVER ()::int AS total
FROM rel
WHERE size_num IS NOT NULL
ORDER BY size_num DESC, name
LIMIT $1`;

export const tableSizes: Check<TableSizeRow, TableSizeData, ListOpts> = {
  id: 'tableSizes',
  title: 'Table sizes',
  gate: 'keep-up',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: TABLE_SIZES_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toTableSizes,
  // No verdict: §2.2.
};
