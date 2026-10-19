import type { Check } from '../types.js';
import { DEFAULT_LIMIT, capped, visibleSchemas } from './shared.js';

/**
 * The catalog, as two captured reads: every table and every index of this
 * database, each row carrying what a dozen separate checks used to ask one
 * question at a time. The capture stores the rows; the web layer reads them
 * back, or runs these itself once a minute when there is no store.
 *
 * Every field is a number, a string, a boolean or null. A row is stored as
 * jsonb and handed to the browser as it is. Moments are epoch milliseconds.
 *
 * pgops's own schema is left out: a console whose store is a database it
 * also monitors would otherwise list its own tables first. The capture's
 * space series is the `tables` rows' sizes, so it leaves it out too.
 */

export type TableKind = 'table' | 'partitioned' | 'matview';

export interface TableRead {
  name: string;
  kind: TableKind;
  /** With its indexes and TOAST. */
  sizeBytes: number;
  heapBytes: number;
  indexBytes: number;
  liveRows: number;
  deadRows: number;
  /** Dead rows at which autovacuum starts on this table, from its own storage parameters where it has them. */
  vacuumTrigger: number;
  /** Cumulative since `statsReset`. The capture differences them into hours. */
  inserted: number;
  updated: number;
  deleted: number;
  seqScans: number;
  /** Rows read by sequential scans. */
  seqRows: number;
  /** Null for a table with no index at all. */
  idxScans: number | null;
  idxRows: number | null;
  /** 0 to 1. Null: no heap I/O recorded, which is not 0 %. */
  hitRate: number | null;
  /** The later of the manual and the automatic one. Null: never. */
  lastVacuum: number | null;
  lastAnalyze: number | null;
  /** With its TOAST table. Null for a partitioned parent, which has no storage to freeze. */
  xidAge: number | null;
  indexes: number;
  /** Constraints added NOT VALID and never validated. */
  unvalidated: number;
  /** The phase of a vacuum running on it now, or null. */
  vacuuming: string | null;
}

export interface TablesData {
  tables: TableRead[];
  /** Tables matched before the LIMIT. */
  total: number;
  truncated: boolean;
  /** When this database's statistics were last reset. Null: never, or no table to read it beside. */
  statsReset: number | null;
  /** `autovacuum_freeze_max_age`, the mark `xid age` is flagged at. */
  freezeMaxAge: number | null;
}

export interface TablesOpts {
  limit?: number;
  relation?: string;
  /** Case-insensitive substring of the schema-qualified name, taken literally. */
  search?: string;
}

export interface TableReadRow {
  name: string;
  kind: TableKind;
  size_bytes: string;
  heap_bytes: string;
  index_bytes: string;
  live_rows: string;
  dead_rows: string;
  vacuum_trigger: string;
  inserted: string;
  updated: string;
  deleted: string;
  seq_scans: string;
  seq_rows: string;
  idx_scans: string | null;
  idx_rows: string | null;
  hit_rate: string | null;
  last_vacuum_ms: number | null;
  last_analyze_ms: number | null;
  xid_age: number | null;
  indexes: number;
  unvalidated: number;
  vacuuming: string | null;
  freeze_max_age: number;
  stats_reset_ms: number | null;
  total: number;
}

/**
 * One row per table, partitioned parent and materialized view, largest
 * first so the cap keeps the ones that matter.
 *
 * - Driven from `pg_class`, with the statistics joined on: a table nothing
 *   has touched since a reset is still a table.
 * - The sizes are computed in `rel`, on the row that passed the filters, and
 *   a NULL there is a relation dropped mid-scan, which is left out.
 * - `vacuum_trigger` is autovacuum's own arithmetic: threshold plus scale
 *   factor times `reltuples`, each from the table's storage parameters when
 *   it sets them. `reltuples` is -1 for a table never analyzed.
 * - `xid_age` counts the TOAST table, which freezes on its own. A
 *   partitioned parent has `relfrozenxid = 0`, and `age(0)` is 2147483647.
 * - The ORDER BY names the numeric source, never a `::text` alias;
 *   boundaries.test.ts holds that.
 */
const TABLES_SQL = `
WITH cfg AS (
  SELECT current_setting('autovacuum_vacuum_threshold')::float8    AS base,
         current_setting('autovacuum_vacuum_scale_factor')::float8 AS scale,
         current_setting('autovacuum_freeze_max_age')::float8      AS freeze_max_age,
         (SELECT (EXTRACT(EPOCH FROM d.stats_reset) * 1000)::float8
            FROM pg_stat_database d WHERE d.datname = current_database()) AS stats_reset_ms
),
rel AS (
  SELECT c.oid, n.nspname || '.' || c.relname AS name, c.relkind, c.reltuples, c.reloptions,
         c.relfrozenxid, c.reltoastrelid,
         pg_total_relation_size(c.oid) AS size_num,
         pg_relation_size(c.oid)       AS heap_num,
         pg_indexes_size(c.oid)        AS index_num
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'm')
     AND ${visibleSchemas('n.nspname')}
     AND n.nspname <> 'pgops'
     AND ($2::text IS NULL OR n.nspname || '.' || c.relname = $2)
     AND ($3::text IS NULL OR n.nspname || '.' || c.relname ILIKE '%' || $3 || '%')
)
SELECT r.name,
       CASE r.relkind WHEN 'm' THEN 'matview' WHEN 'p' THEN 'partitioned' ELSE 'table' END AS kind,
       r.size_num::text  AS size_bytes,
       r.heap_num::text  AS heap_bytes,
       r.index_num::text AS index_bytes,
       COALESCE(s.n_live_tup, 0)::text AS live_rows,
       COALESCE(s.n_dead_tup, 0)::text AS dead_rows,
       (COALESCE((SELECT o.option_value::float8 FROM pg_options_to_table(r.reloptions) o
                   WHERE o.option_name = 'autovacuum_vacuum_threshold'), cfg.base)
        + COALESCE((SELECT o.option_value::float8 FROM pg_options_to_table(r.reloptions) o
                     WHERE o.option_name = 'autovacuum_vacuum_scale_factor'), cfg.scale)
          * greatest(r.reltuples, 0))::text AS vacuum_trigger,
       COALESCE(s.n_tup_ins, 0)::text    AS inserted,
       COALESCE(s.n_tup_upd, 0)::text    AS updated,
       COALESCE(s.n_tup_del, 0)::text    AS deleted,
       COALESCE(s.seq_scan, 0)::text     AS seq_scans,
       COALESCE(s.seq_tup_read, 0)::text AS seq_rows,
       s.idx_scan::text                  AS idx_scans,
       s.idx_tup_fetch::text             AS idx_rows,
       (io.heap_blks_hit::numeric / nullif(io.heap_blks_hit + io.heap_blks_read, 0))::text AS hit_rate,
       (EXTRACT(EPOCH FROM greatest(s.last_vacuum, s.last_autovacuum)) * 1000)::float8   AS last_vacuum_ms,
       (EXTRACT(EPOCH FROM greatest(s.last_analyze, s.last_autoanalyze)) * 1000)::float8 AS last_analyze_ms,
       CASE WHEN r.relkind = 'p' THEN NULL
            ELSE greatest(age(r.relfrozenxid), age(t.relfrozenxid)) END AS xid_age,
       (SELECT count(*) FROM pg_index i WHERE i.indrelid = r.oid)::int AS indexes,
       (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = r.oid AND NOT k.convalidated)::int AS unvalidated,
       (SELECT v.phase FROM pg_stat_progress_vacuum v
         WHERE v.relid = r.oid AND v.datname = current_database() LIMIT 1) AS vacuuming,
       cfg.freeze_max_age, cfg.stats_reset_ms,
       count(*) OVER ()::int AS total
  FROM rel r
  CROSS JOIN cfg
  LEFT JOIN pg_stat_user_tables s    ON s.relid = r.oid
  LEFT JOIN pg_statio_user_tables io ON io.relid = r.oid
  LEFT JOIN pg_class t               ON t.oid = r.reltoastrelid
 WHERE r.size_num IS NOT NULL
 ORDER BY r.size_num DESC, r.name
 LIMIT $1`;

/** Escapes `%`, `_` and `\` so a search matches literally inside `'%' || $3 || '%'`. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

const num = (s: string | null): number => (s === null ? 0 : Number(s));
const orNull = (s: string | null): number | null => (s === null ? null : Number(s));
const moment = (ms: number | null): number | null => (ms === null ? null : Math.round(ms));

export function toTables(rows: TableReadRow[]): TablesData {
  return {
    tables: rows.map((r) => ({
      name: r.name, kind: r.kind,
      sizeBytes: num(r.size_bytes), heapBytes: num(r.heap_bytes), indexBytes: num(r.index_bytes),
      liveRows: num(r.live_rows), deadRows: num(r.dead_rows), vacuumTrigger: num(r.vacuum_trigger),
      inserted: num(r.inserted), updated: num(r.updated), deleted: num(r.deleted),
      seqScans: num(r.seq_scans), seqRows: num(r.seq_rows),
      // Null stays null: no index, and no heap I/O, are readings of their own.
      idxScans: orNull(r.idx_scans), idxRows: orNull(r.idx_rows), hitRate: orNull(r.hit_rate),
      lastVacuum: moment(r.last_vacuum_ms), lastAnalyze: moment(r.last_analyze_ms),
      xidAge: r.xid_age, indexes: r.indexes, unvalidated: r.unvalidated, vacuuming: r.vacuuming,
    })),
    ...capped(rows),
    statsReset: moment(rows[0]?.stats_reset_ms ?? null),
    freezeMaxAge: rows[0]?.freeze_max_age ?? null,
  };
}

export const tables: Check<TableReadRow, TablesData, TablesOpts> = {
  id: 'tables',
  title: 'Tables',
  gate: 'keep-up',
  home: 'table',
  class: 'captured',
  timeoutMs: 10_000,
  sql: (o) => ({
    text: TABLES_SQL,
    values: [
      o.limit ?? DEFAULT_LIMIT,
      o.relation ?? null,
      o.search === undefined || o.search === '' ? null : escapeLike(o.search),
    ],
  }),
  map: toTables,
  // No verdict: what a table needs is said by its flags, on its own row.
};

/** What a table's row is tagged with, most urgent first. A node shows two. */
export type TableFlag = 'vacuum overdue' | 'xid age' | 'full scans' | 'not validated' | 'vacuuming';

/** pgHero's `missing_indexes` bounds: enough rows to matter, and under 95 % of its scans by index. */
const FULL_SCAN_MIN_ROWS = 10_000;
const FULL_SCAN_INDEX_PCT = 95;

export function tableFlags(t: TableRead, freezeMaxAge: number | null): TableFlag[] {
  const out: TableFlag[] = [];
  if (t.kind !== 'partitioned' && t.deadRows > t.vacuumTrigger) out.push('vacuum overdue');
  if (freezeMaxAge !== null && t.xidAge !== null && t.xidAge >= freezeMaxAge) out.push('xid age');
  if (t.idxScans !== null && t.idxScans > 0 && t.liveRows >= FULL_SCAN_MIN_ROWS
    && (100 * t.idxScans) / (t.seqScans + t.idxScans) < FULL_SCAN_INDEX_PCT) out.push('full scans');
  if (t.unvalidated > 0) out.push('not validated');
  if (t.vacuuming !== null) out.push('vacuuming');
  return out;
}

export interface IndexRead {
  name: string;
  table: string;
  /** Its key and included columns, as Postgres prints them. */
  columns: string;
  sizeBytes: number;
  /** Cumulative since `statsReset`. */
  scans: number;
  /** 0 to 1. Null: no index I/O recorded, which is not 0 %. */
  hitRate: number | null;
  unique: boolean;
  primary: boolean;
  /** False for an index a failed concurrent build left behind. */
  valid: boolean;
  /** The index that already covers this one, or null. */
  duplicateOf: string | null;
}

export interface IndexesData {
  indexes: IndexRead[];
  total: number;
  truncated: boolean;
  /** The moment `scans` counts from. Null: never reset. */
  statsReset: number | null;
}

export interface IndexesOpts { limit?: number; relation?: string }

export interface IndexReadRow {
  name: string;
  table_name: string;
  columns: string;
  size_bytes: string;
  scans: string;
  hit_rate: string | null;
  is_unique: boolean;
  is_primary: boolean;
  is_valid: boolean;
  duplicate_of: string | null;
  stats_reset_ms: number | null;
  total: number;
}

/**
 * One row per index, largest first.
 *
 * `dup` is the duplicate-index comparison pgops has always made, kept
 * clause for clause because it recommends a drop: key arrays compared by
 * slice, never as text; expression and partial indexes neither covered nor
 * covering; the operator classes equal over the shared prefix; a unique
 * index never the redundant one; an identical pair reported once, on the
 * higher oid. An invalid index covers nothing and is flagged as invalid,
 * not as covered.
 *
 * `string_agg … ORDER BY k` closes on a line of its own: boundaries.test.ts
 * reads an ORDER BY up to the next line that starts with a parenthesis, and
 * would otherwise find the `::text` aliases below it inside the clause.
 */
const INDEXES_SQL = `
WITH ix AS (
  SELECT i.indexrelid, i.indrelid, i.indisunique, i.indisprimary, i.indisvalid, i.indnatts,
         (i.indpred IS NOT NULL)  AS partial,
         (i.indexprs IS NOT NULL) AS has_exprs,
         (string_to_array(i.indkey::text, ' ')::int[])[1:i.indnkeyatts]   AS keys,
         (string_to_array(i.indclass::text, ' ')::oid[])[1:i.indnkeyatts] AS classes,
         n.nspname || '.' || c.relname  AS name,
         tn.nspname || '.' || t.relname AS table_name,
         pg_relation_size(i.indexrelid) AS bytes
    FROM pg_index i
    JOIN pg_class c      ON c.oid = i.indexrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_class t      ON t.oid = i.indrelid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
   WHERE ${visibleSchemas('n.nspname')}
     AND n.nspname <> 'pgops'
     AND ($2::text IS NULL OR tn.nspname || '.' || t.relname = $2)
),
dup AS (
  SELECT DISTINCT ON (a.indexrelid) a.indexrelid, b.name AS covered_by
    FROM ix a
    JOIN ix b
      ON b.indrelid = a.indrelid
     AND b.indexrelid <> a.indexrelid
     AND b.indisvalid AND NOT b.has_exprs AND NOT b.partial
     AND b.keys[1:array_length(a.keys, 1)] = a.keys
     AND b.classes[1:array_length(a.classes, 1)] = a.classes
     AND (array_length(b.keys, 1) > array_length(a.keys, 1) OR a.indexrelid > b.indexrelid)
   WHERE a.indisvalid AND NOT a.has_exprs AND NOT a.indisunique AND NOT a.partial
   ORDER BY a.indexrelid,
            (array_length(b.keys, 1) = array_length(a.keys, 1)) DESC,
            b.bytes,
            b.indexrelid
)
SELECT x.name, x.table_name,
       (SELECT string_agg(pg_get_indexdef(x.indexrelid, k, true), ', ' ORDER BY k
               )
          FROM generate_series(1, x.indnatts) AS k) AS columns,
       x.bytes::text AS size_bytes,
       COALESCE(s.idx_scan, 0)::text AS scans,
       (io.idx_blks_hit::numeric / nullif(io.idx_blks_hit + io.idx_blks_read, 0))::text AS hit_rate,
       x.indisunique AS is_unique, x.indisprimary AS is_primary, x.indisvalid AS is_valid,
       d.covered_by AS duplicate_of,
       (SELECT (EXTRACT(EPOCH FROM db.stats_reset) * 1000)::float8
          FROM pg_stat_database db WHERE db.datname = current_database()) AS stats_reset_ms,
       count(*) OVER ()::int AS total
  FROM ix x
  LEFT JOIN dup d ON d.indexrelid = x.indexrelid
  LEFT JOIN pg_stat_user_indexes s    ON s.indexrelid = x.indexrelid
  LEFT JOIN pg_statio_user_indexes io ON io.indexrelid = x.indexrelid
 WHERE x.bytes IS NOT NULL
 ORDER BY x.bytes DESC, x.name
 LIMIT $1`;

export function toIndexes(rows: IndexReadRow[]): IndexesData {
  return {
    indexes: rows.map((r) => ({
      name: r.name, table: r.table_name, columns: r.columns, sizeBytes: num(r.size_bytes), scans: num(r.scans),
      hitRate: orNull(r.hit_rate),
      unique: r.is_unique, primary: r.is_primary, valid: r.is_valid, duplicateOf: r.duplicate_of,
    })),
    ...capped(rows),
    statsReset: moment(rows[0]?.stats_reset_ms ?? null),
  };
}

export const indexes: Check<IndexReadRow, IndexesData, IndexesOpts> = {
  id: 'indexes',
  title: 'Indexes',
  gate: 'work',
  home: 'index',
  class: 'captured',
  timeoutMs: 10_000,
  sql: (o) => ({ text: INDEXES_SQL, values: [o.limit ?? DEFAULT_LIMIT, o.relation ?? null] }),
  map: toIndexes,
};

export type IndexFlag = 'invalid' | 'duplicate' | 'never used';

/**
 * "Never used" is no scan since `statsReset`, and only where a drop could be
 * right: a unique index enforces a constraint whether or not anything scans
 * it, and an invalid one is said to be invalid.
 */
export function indexFlags(i: IndexRead): IndexFlag[] {
  const out: IndexFlag[] = [];
  if (!i.valid) out.push('invalid');
  if (i.duplicateOf !== null) out.push('duplicate');
  if (i.valid && !i.unique && i.scans === 0) out.push('never used');
  return out;
}
