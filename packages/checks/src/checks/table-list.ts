import type { Check, SqlQuery } from '../types.js';
import { DEFAULT_LIMIT, visibleSchemas, type RelationOpts } from './indexes.js';

/**
 * THE TABLE INVENTORY, and the half of the console that was missing.
 *
 * `AREAS` gives the `indexes` area an inventory — `indexList`, titled
 * "Indexes", no verdict — beside its findings. The `tables` area had four
 * findings and nothing to read: `tableCaching`, `unusedTables`, `tableStats`
 * and `tableHitRate` each answer a question, and none of them lists the
 * tables. So "show me this database's tables, biggest first" had no check
 * behind it, and the console answered it with three separate pages that were
 * each one ORDER BY of a list nobody could see whole.
 *
 * ONE QUERY, because the sort must happen before the cap. The columns this
 * list sorts on live in four checks today, each capped at DEFAULT_LIMIT
 * independently. Joining those four in JavaScript and sorting the result
 * gives the ranking of whichever population the first cap admitted — "the 100
 * biggest tables, re-sorted by dead rows" is not "the 100 deadest tables",
 * and the page could not tell the difference to say so. See the design of
 * 2026-09-23 §6.2.
 */

export type TableSort = 'size' | 'dead' | 'vacuum' | 'cache' | 'rows' | 'name';

/** The closed set, exported so the web layer validates against it. */
export const TABLE_SORTS: readonly TableSort[] = ['size', 'dead', 'vacuum', 'cache', 'rows', 'name'];

/**
 * The ORDER BY for each sort.
 *
 * INTERPOLATED, not bound, and safe for exactly one reason: the key is a
 * member of a closed union and this Record is total over it. query-stats.ts
 * carries the same construction and the same warning — do not widen
 * `TableSort` to `string`, and do not reach into this map with an unchecked
 * value. `sqlFor` below is the only reader, and it throws on a miss rather
 * than returning undefined into a template literal.
 *
 * Every clause sorts on the underlying NUMERIC expression, never on the
 * `::text` alias the SELECT list declares — the text form of 9 sorts before
 * the text form of 10.
 *
 * THAT DISCIPLINE IS NOT ENFORCED BY boundaries.test.ts HERE, and it is a
 * mistake to think it is. That guard skips any backtick block that has no
 * literal `SELECT` in it — every entry in this Record is a bare fragment, so
 * none qualify — and even the assembled query only contains `${order}` as an
 * interpolation, never the alias name as literal source text for the guard's
 * regex to match against. boundaries.test.ts's own docblock names this exact
 * shape — an ORDER BY "assembled at runtime from `ORDER[o.sort]`" — as
 * explicitly out of its scope, and says what covers it instead: an
 * integration test per sort key, the same shape query-stats.int.test.ts
 * already carries for its `calls`/`cache` keys. table-list.int.test.ts is
 * that coverage here, for all six clauses — not a source-level guard.
 *
 * Each clause ends in `s.name` so the order is total. Without it a page of
 * tables that share a dead-row count of zero comes back in a different order
 * on every poll, which reads as the list churning.
 */
const ORDER: Record<TableSort, string> = {
  size: 's.size_num DESC NULLS LAST, s.name',
  dead: 's.n_dead_tup DESC, s.name',
  // NULLS FIRST: a table that has never been vacuumed is the most overdue
  // one there is, not the least. `greatest` because autovacuum and a manual
  // VACUUM are the same event to a reader asking when it last happened.
  vacuum: 'greatest(s.last_vacuum, s.last_autovacuum) ASC NULLS FIRST, s.name',
  // ASC: worst first, which is the only direction anyone asks for. NULLS LAST
  // keeps "no heap I/O recorded" out of the alarming end of a list it has no
  // reading for.
  cache: '(io.heap_blks_hit::numeric / nullif(io.heap_blks_hit + io.heap_blks_read, 0)) ASC NULLS LAST, s.name',
  rows: 's.n_live_tup DESC, s.name',
  name: 's.name ASC',
};

export interface TableListOpts extends RelationOpts {
  /** Defaults to `size`. */
  sort?: TableSort;
  /**
   * The `Unused` preset. `s.idx_scan = 0` — a table with at least one index,
   * none of them ever scanned. It does NOT match a table with no indexes at
   * all: `idx_scan` is NULL there, not 0, and `= 0` excludes a NULL rather
   * than matching it. That exclusion is inherited on purpose, not a gap —
   * `unusedTables` in tables.ts argues at length for the same filter: for a
   * table with no indexes, "are its indexes unused?" has no answer to give.
   */
  unusedOnly?: boolean;
  /** Case-insensitive substring of the schema-qualified name. */
  search?: string;
}

export interface TableListRow {
  name: string;
  size_bytes: string;
  live_rows: string;
  dead_rows: string;
  seq_scans: string;
  /** NULL for a table with no indexes at all — see `TableListEntry.idxScans`. */
  idx_scans: string | null;
  hit_rate: string | null;
  last_vacuum: Date | null;
  last_analyze: Date | null;
  total: number;
}

export interface TableListEntry {
  name: string;
  sizeBytes: number;
  liveRows: number;
  deadRows: number;
  seqScans: number;
  /**
   * `null` means this table has NO INDEXES AT ALL — `pg_stat_user_tables`
   * carries NULL, not 0, in that case (the same fact `tables.ts`'s
   * `unusedTables` and `indexes.ts`'s `indexUsage` each document). Folding it
   * to zero would render "Index scans: 0" for a table nobody could have
   * scanned by index in the first place, indistinguishable from an indexed
   * table nothing has used yet.
   */
  idxScans: number | null;
  /** null means no heap I/O has been recorded — NOT a hit rate of zero. */
  hitRate: number | null;
  /** The later of the manual and automatic events, or null for neither. */
  lastVacuum: Date | null;
  lastAnalyze: Date | null;
}

export interface TableListData {
  tables: TableListEntry[];
  /** The pre-`LIMIT`, post-filter total from `count(*) OVER ()`. */
  total: number;
  truncated: boolean;
}

export function toTableList(rows: TableListRow[]): TableListData {
  const total = rows[0]?.total ?? 0;
  return {
    tables: rows.map((r) => ({
      name: r.name,
      sizeBytes: Number(r.size_bytes),
      liveRows: Number(r.live_rows),
      deadRows: Number(r.dead_rows),
      seqScans: Number(r.seq_scans),
      idxScans: r.idx_scans === null ? null : Number(r.idx_scans),
      hitRate: r.hit_rate === null ? null : Number(r.hit_rate),
      lastVacuum: r.last_vacuum,
      lastAnalyze: r.last_analyze,
    })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * `pg_stat_user_tables` is the spine, but it is not literally "the one view
 * with a row per table" — it has a row per `relkind IN ('r','t','m','p')`:
 * ordinary tables, TOAST tables, MATERIALIZED VIEWS, and partitioned
 * parents. A page called Tables must not present a materialized view as one,
 * so `s` joins to `pg_class` on `relid` and filters `relkind IN ('r','p')`
 * there — ordinary tables and partitioned parents, whose own storage is
 * genuinely zero when it holds no local pages, so reporting zero for it is
 * true rather than fabricated. A materialized view is excluded outright
 * rather than shown with an invented size; `relationSizes` still reports it
 * elsewhere, and this list does not pretend to.
 *
 * That join is INNER, and `pg_total_relation_size(c.oid)` is computed in `s`
 * itself, in the SAME row that already passed the `relkind` check — not in a
 * second CTE LEFT JOINed back in by name. The latter is exactly how a
 * materialized view's real, unmeasured size was once folded into a
 * fabricated `0` (`coalesce(sz.size_num, 0)`): a `relkind = 'r'`-filtered
 * `sz` CTE simply had no row to match, and a zero meaning "we didn't measure
 * this" is indistinguishable from a zero meaning "this table is empty" — the
 * same failure `hit_rate`'s null discipline exists to prevent elsewhere in
 * this file. Sourcing size from the row that already passed the `relkind`
 * filter makes that class of bug impossible rather than patched.
 *
 * `io` (heap I/O) stays a separate CTE, LEFT JOINed: `pg_statio_user_tables`
 * carries no `relkind` of its own to filter by, and a table that has had no
 * heap I/O since the last stats reset — exactly the newly created table
 * someone is looking for — must still appear, with a null hit rate, rather
 * than being dropped by an INNER JOIN.
 */
const SELECT = `
WITH s AS (
  SELECT t.schemaname || '.' || t.relname AS name,
         t.n_live_tup, t.n_dead_tup, t.seq_scan, t.idx_scan,
         t.last_vacuum, t.last_autovacuum, t.last_analyze, t.last_autoanalyze,
         pg_total_relation_size(c.oid) AS size_num
  FROM pg_stat_user_tables t
  JOIN pg_class c ON c.oid = t.relid
  WHERE c.relkind IN ('r', 'p')
    AND ${visibleSchemas('t.schemaname')}
), io AS (
  SELECT schemaname || '.' || relname AS name, heap_blks_hit, heap_blks_read
  FROM pg_statio_user_tables
  WHERE ${visibleSchemas('schemaname')}
)
SELECT s.name,
       s.size_num::text AS size_bytes,
       s.n_live_tup::text AS live_rows,
       s.n_dead_tup::text AS dead_rows,
       s.seq_scan::text   AS seq_scans,
       s.idx_scan::text   AS idx_scans,
       (io.heap_blks_hit::numeric / nullif(io.heap_blks_hit + io.heap_blks_read, 0))::text AS hit_rate,
       greatest(s.last_vacuum, s.last_autovacuum)   AS last_vacuum,
       greatest(s.last_analyze, s.last_autoanalyze) AS last_analyze,
       count(*) OVER ()::int AS total
FROM s
LEFT JOIN io ON io.name = s.name
WHERE ($2::text IS NULL OR s.name = $2)
  AND ($3::boolean IS NOT TRUE OR s.idx_scan = 0)
  AND ($4::text IS NULL OR s.name ILIKE '%' || $4 || '%')`;

/**
 * Escapes `search` for the literal it is meant to be, not the ILIKE pattern
 * it would otherwise become.
 *
 * `sqlFor` below binds this value into `'%' || $4 || '%'`, so any `%` or `_`
 * IN THE SEARCH TERM ITSELF functions as an ILIKE wildcard rather than a
 * literal character: unescaped, `order_item` matches `orderXitem` (`_` means
 * "any one character"), and a search containing `%` matches every table in
 * the database. The escape character is `\`, ILIKE's default with no
 * explicit `ESCAPE` clause in this query — verified against the Postgres
 * pattern-matching docs, not assumed — so a literal backslash in the search
 * term must be escaped too, and first, or it would itself be read as
 * escaping the character after it. One regex pass handles all three: each
 * character is matched independently against the input, so a `\` in the
 * source is never re-scanned as part of an escape sequence this replace just
 * produced.
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * The three filters sit in the WHERE, so `count(*) OVER ()` counts what
 * survived them and the LIMIT caps what the operator is shown — "Showing 100
 * of 250" then means 250 MATCHING tables, which is the number a search box
 * has to report to be worth having.
 */
export function sqlFor(o: TableListOpts): SqlQuery {
  const sort = o.sort ?? 'size';
  const order = ORDER[sort];
  // Not a defensive nicety: without it an unknown key interpolates the string
  // "undefined" into the statement and Postgres answers with a syntax error
  // an operator cannot act on. The web layer validates against TABLE_SORTS
  // before it ever gets here; this is what makes that validation load-bearing
  // rather than merely customary.
  if (order === undefined) throw new Error(`unknown sort: ${String(sort)}`);
  return {
    text: `${SELECT}\nORDER BY ${order}\nLIMIT $1`,
    values: [
      o.limit ?? DEFAULT_LIMIT,
      o.relation ?? null,
      o.unusedOnly ?? null,
      o.search === undefined || o.search === '' ? null : escapeLike(o.search),
    ],
  };
}

export const tableList: Check<TableListRow, TableListData, TableListOpts> = {
  id: 'tableList',
  title: 'Tables',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: sqlFor,
  map: toTableList,
  // No verdict: §2.2, and the same ruling `indexList` carries. An inventory
  // is read, not judged — the four table findings beside it in the `tables`
  // area are what escalate, and adding a verdict here would also break
  // areas.test.ts's exact list of areas that can.
};
