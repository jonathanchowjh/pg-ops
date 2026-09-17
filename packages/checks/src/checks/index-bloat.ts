import type { Check } from '../types.js';
import { DEFAULT_LIMIT } from './indexes.js';

export interface IndexBloatOpts {
  limit?: number;
  /** The floor on WASTED bytes. Defaults to pgHero's 100 MB. */
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
 * The schema qualification happens HERE, not in the query.
 *
 * Every other check in this package concatenates `schema || '.' || name` in
 * SQL, and this one deliberately does not: the estimator below is a
 * transcription, and the fewer edits it carries the easier it is to diff
 * against the original it claims parity with. Joining three columns into two
 * is presentation, and presentation belongs in `map`.
 */
export function toIndexBloat(rows: IndexBloatRow[]): IndexBloatData {
  const total = rows[0]?.total ?? 0;
  return {
    indexes: rows.map((r) => ({
      name: `${r.schema}.${r.index_name}`,
      table: `${r.schema}.${r.table_name}`,
      bloatBytes: Number(r.bloat_bytes),
      indexBytes: Number(r.index_bytes),
      definition: r.definition,
      primary: r.is_primary,
    })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * pgHero's `index_bloat_bytes` default, `100.megabytes`
 * (lib/pghero/database.rb:68). Declared once, as the threshold's value, and
 * read from there as the query's default floor — the same single-number rule
 * `unusedIndexes` documents.
 */
const INDEX_BLOAT_FLOOR_BYTES = 100 * 1024 * 1024;

/**
 * TRANSCRIBED from pgHero 4.0.1 `lib/pghero/methods/indexes.rb#index_bloat`,
 * not written. Read that file beside this one before touching a line of it.
 *
 * The estimator is the widely circulated btree bloat query (pgHero credits
 * @jberkus and @mbanck). It reconstructs what an index OUGHT to occupy —
 * `otta` — from `pg_stats` column widths, null fractions and MAXALIGN
 * padding, then calls the excess over that "wasted". It is an ESTIMATE, and
 * the arithmetic is subtle enough that improving it in passing is the likely
 * outcome of editing it. A bloat figure that disagrees with pgHero's is not
 * parity.
 *
 * Exactly three changes from the original, all mechanical:
 *   1. `count(*) OVER ()::int AS total` for §5's truncation rule.
 *   2. `::text` on the two bigint/numeric outputs, so node-postgres does not
 *      round them through a float64.
 *   3. `$1` for the floor and `$2` for the cap, where pgHero binds `:min_size`
 *      and has no cap at all.
 * Column ALIASES changed too — `table_name`/`index_name`/`is_primary` rather
 * than `table`/`index`/`primary` — because those three are awkward property
 * names in TypeScript. No expression was touched.
 *
 * Checked, not asserted: a token-level diff of this string against the
 * original (comments stripped, whitespace normalised) reports 696 tokens
 * there against 711 here at 0.979 similarity, and every difference is one of
 * the edits listed above — the two dropped aliases, the two `::text` casts,
 * `is_primary` plus the window count, `$1` for `:min_size`, and the `LIMIT`
 * pgHero does not have. No expression differs. That check is not a test in
 * this suite, because it needs the network.
 *
 * `realbloat`, `table_bytes` and `index_scans` are computed in `raw_bloat` and
 * then never selected. That is true of the original as well; they are left in
 * place rather than pruned, because the point of a transcription is that it
 * diffs cleanly against its source.
 *
 * An index whose table has never been ANALYZEd has no `pg_stats` rows and
 * drops out of the join in `index_item_sizes` entirely. That is an absence,
 * not a zero, and it is the right answer: bloat cannot be estimated from
 * statistics that do not exist, and reporting such an index at 0 wasted bytes
 * would be a measurement nobody took.
 *
 * `bloat_bytes` is never NULL, so `map` has no null branch: `otta` is wrapped
 * in `coalesce(..., 0)`, and every other input to the two CASE arms
 * (`relpages`, `bs`) is non-null by construction. Verified on 17.11.
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
 * `class: 'on-demand'`, which is the whole reason that class exists — see
 * types.ts, where it is documented as the thing that makes `index_bloat` a
 * class member rather than an exception carved out in prose.
 *
 * The placement follows pgHero, which ships this DISABLED on its own
 * dashboard: `app/controllers/pg_hero/home_controller.rb:114` reads
 * `@index_bloat = [] # @database.index_bloat`, with a separate `index_bloat`
 * action at :125 behind its own route. Five CTEs over `pg_stats` and
 * `pg_class` is not something to run on a page an operator opens by reflex,
 * hence the 30s budget rather than hygiene's 10s: this runs when someone asks
 * for it and is willing to wait.
 */
export const indexBloat: Check<IndexBloatRow, IndexBloatData, IndexBloatOpts> = {
  id: 'indexBloat',
  title: 'Index bloat',
  gate: 'keep-up',
  class: 'on-demand',
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
  // No verdict: §2.2, and this one never escalates on its own — it runs only
  // when an operator navigates to it.
};
