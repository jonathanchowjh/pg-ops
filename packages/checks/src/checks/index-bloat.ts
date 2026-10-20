import type { Check } from '../types.js';
import { DEFAULT_LIMIT, capped } from './shared.js';

export interface IndexBloatOpts {
  limit?: number;
  /** The floor on wasted bytes. Defaults to 100 MB. */
  minBytes?: number;
}

export interface IndexBloatRow {
  schema: string;
  table_name: string;
  index_name: string;
  bloat_bytes: string;
  index_bytes: string;
  definition: string;
  is_primary: boolean;
  total: number;
}

export interface BloatedIndex {
  name: string;
  table: string;
  bloatBytes: number;
  indexBytes: number;
  definition: string;
  primary: boolean;
}

export interface IndexBloatData {
  indexes: BloatedIndex[];
  total: number;
  truncated: boolean;
}

/**
 * Schema qualification happens here, not in the query, to keep the
 * transcribed estimator close to its source.
 */
export function toIndexBloat(rows: IndexBloatRow[]): IndexBloatData {
  return {
    indexes: rows.map((r) => ({
      name: `${r.schema}.${r.index_name}`,
      table: `${r.schema}.${r.table_name}`,
      bloatBytes: Number(r.bloat_bytes),
      indexBytes: Number(r.index_bytes),
      definition: r.definition,
      primary: r.is_primary,
    })),
    ...capped(rows),
  };
}

/**
 * pgHero's `index_bloat_bytes` default. Both the threshold's value and the
 * query's default floor.
 */
const INDEX_BLOAT_FLOOR_BYTES = 100 * 1024 * 1024;

/**
 * Transcribed from pgHero 4.0.1 `lib/pghero/methods/indexes.rb#index_bloat`.
 * It is the widely circulated btree bloat estimator: it reconstructs what an
 * index ought to occupy (`otta`) from `pg_stats` and calls the excess
 * wasted. Do not edit the arithmetic; the figure must agree with pgHero's.
 *
 * Changes from the original, none to an expression: the window `total`,
 * `::text` on the two byte outputs, `$1`/`$2` for the floor and the added
 * LIMIT, and the `table_name`/`index_name`/`is_primary` aliases. The unused
 * `realbloat`, `table_bytes` and `index_scans` columns are the original's.
 *
 * An index whose table has never been ANALYZEd has no `pg_stats` rows and
 * drops out: its bloat cannot be estimated, so it is absent, not zero.
 * `bloat_bytes` is never NULL.
 */
const INDEX_BLOAT_SQL = `
WITH btree_index_atts AS (
  SELECT
    nspname, relname, reltuples, relpages, indrelid, relam,
    regexp_split_to_table(indkey::text, ' ')::smallint AS attnum,
    indexrelid as index_oid
  FROM pg_index
  JOIN pg_class ON pg_class.oid = pg_index.indexrelid
  JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
  JOIN pg_am ON pg_class.relam = pg_am.oid
  WHERE pg_am.amname = 'btree'
),
index_item_sizes AS (
  SELECT
    i.nspname, i.relname, i.reltuples, i.relpages, i.relam,
    (quote_ident(s.schemaname) || '.' || quote_ident(s.tablename))::regclass AS starelid,
    a.attrelid AS table_oid, index_oid,
    current_setting('block_size')::numeric AS bs,
    /* MAXALIGN: 4 on 32bits, 8 on 64bits (and mingw32 ?) */
    CASE WHEN version() ~ 'mingw32' OR version() ~ '64-bit' THEN 8 ELSE 4 END AS maxalign,
    24 AS pagehdr,
    /* per tuple header: add index_attribute_bm if some cols are null-able */
    CASE WHEN max(coalesce(s.null_frac,0)) = 0 THEN 2 ELSE 6 END AS index_tuple_hdr,
    /* data len: we remove null values save space using it fractionnal part from stats */
    sum( (1-coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 2048) ) AS nulldatawidth
  FROM pg_attribute AS a
  JOIN pg_stats AS s ON (quote_ident(s.schemaname) || '.' || quote_ident(s.tablename))::regclass=a.attrelid AND s.attname = a.attname
  JOIN btree_index_atts AS i ON i.indrelid = a.attrelid AND a.attnum = i.attnum
  WHERE a.attnum > 0
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
),
index_aligned AS (
  SELECT
    maxalign, bs, nspname, relname AS index_name, reltuples, relpages, relam,
    table_oid, index_oid,
    ( 2 +
      maxalign - CASE /* Add padding to the index tuple header to align on MAXALIGN */
        WHEN index_tuple_hdr%maxalign = 0 THEN maxalign
        ELSE index_tuple_hdr%maxalign
      END
    + nulldatawidth + maxalign - CASE /* Add padding to the data to align on MAXALIGN */
        WHEN nulldatawidth::integer%maxalign = 0 THEN maxalign
        ELSE nulldatawidth::integer%maxalign
      END
    )::numeric AS nulldatahdrwidth, pagehdr
  FROM index_item_sizes AS s1
),
otta_calc AS (
  SELECT
    bs, nspname, table_oid, index_oid, index_name, relpages,
    coalesce(
      ceil((reltuples*(4+nulldatahdrwidth))/(bs-pagehdr::float)) +
      CASE WHEN am.amname IN ('hash','btree') THEN 1 ELSE 0 END , 0 /* btree and hash have a metadata reserved block */
    ) AS otta
  FROM index_aligned AS s2
  LEFT JOIN pg_am am ON s2.relam = am.oid
),
raw_bloat AS (
  SELECT
    nspname,
    c.relname AS table_name,
    index_name,
    bs*(sub.relpages)::bigint AS totalbytes,
    CASE
      WHEN sub.relpages <= otta THEN 0
      ELSE bs*(sub.relpages-otta)::bigint END
      AS wastedbytes,
    CASE
      WHEN sub.relpages <= otta
      THEN 0 ELSE bs*(sub.relpages-otta)::bigint * 100 / (bs*(sub.relpages)::bigint) END
      AS realbloat,
    pg_relation_size(sub.table_oid) as table_bytes,
    stat.idx_scan as index_scans,
    stat.indexrelid
  FROM otta_calc AS sub
  JOIN pg_class AS c ON c.oid=sub.table_oid
  JOIN pg_stat_user_indexes AS stat ON sub.index_oid = stat.indexrelid
)
SELECT
  nspname AS schema,
  table_name,
  index_name,
  wastedbytes::text AS bloat_bytes,
  totalbytes::text AS index_bytes,
  pg_get_indexdef(rb.indexrelid) AS definition,
  indisprimary AS is_primary,
  count(*) OVER ()::int AS total
FROM raw_bloat rb
INNER JOIN pg_index i ON i.indexrelid = rb.indexrelid
WHERE wastedbytes >= $1
ORDER BY wastedbytes DESC, index_name
LIMIT $2`;

/**
 * Captured, and never captured: five CTEs over `pg_stats` and `pg_class` are
 * too heavy for a page opened by reflex, so this runs only from a button,
 * with a 30s budget instead of a captured read's 10s.
 */
export const indexBloat: Check<IndexBloatRow, IndexBloatData, IndexBloatOpts> = {
  id: 'indexBloat',
  title: 'Index bloat',
  home: 'index',
  class: 'captured',
  timeoutMs: 30_000,
  sql: (o) => ({
    text: INDEX_BLOAT_SQL,
    values: [o.minBytes ?? INDEX_BLOAT_FLOOR_BYTES, o.limit ?? DEFAULT_LIMIT],
  }),
  map: toIndexBloat,
  thresholds: [
    { level: 'warn', value: INDEX_BLOAT_FLOOR_BYTES, unit: 'bytes',
      because: "pgHero's index_bloat_bytes default (lib/pghero/database.rb:68) is "
             + '100 megabytes; adopted for parity. It is a floor on what is worth '
             + 'reporting, not a level a reading climbs to',
      remedy: 'The figure is an estimate from column statistics, not a measurement, '
            + 'so confirm it before acting. Rebuilding the index concurrently '
            + 'reclaims the space; on a table that is still churning it will bloat '
            + 'again, which is a vacuum question rather than an index one.' },
  ],
  // No verdict: it runs only when an operator navigates to it.
};
