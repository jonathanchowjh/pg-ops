import type { Check, Verdict, Threshold } from '../types.js';

/**
 * The cap seam every list check in this package shares.
 *
 * Spec §5: a capped list carries its true total via `count(*) OVER ()`, and
 * the verdict reads that total rather than `rows.length`, so a finding is
 * never hidden by the cap that was meant only to bound the page.
 */
export interface ListOpts { limit?: number }

/**
 * The ratio arrives as TEXT. `sum(...) / nullif(sum(...), 0)` is numeric
 * division, and node-postgres returns numeric as a string to avoid a float64
 * round trip — the same text->number split `locks.ts` documents for
 * `xact_age_secs`. Conversion happens in `map`, never in SQL.
 */
export interface HitRateRow { rate: string | null }

/** `null` means "we could not compute one", never "0%". */
export interface HitRateData { rate: number | null }

/**
 * `nullif` is load-bearing, not defensive.
 *
 * Verified against PostgreSQL 17.11: on a database that has done no index
 * I/O, `sum(idx_blks_hit + idx_blks_read)` is 0 and this returns NULL. Without
 * `nullif` it divides by zero; with the NULL collapsed to 0 in `map` it would
 * read as 0% against a 99% threshold — a false `warn` on every freshly
 * started database, which is §6's first priority case.
 */
const HIT_RATE_SQL = `
SELECT (sum(idx_blks_hit) / nullif(sum(idx_blks_hit + idx_blks_read), 0))::text AS rate
FROM pg_statio_user_indexes`;

export function toRate(rows: HitRateRow[]): HitRateData {
  const raw = rows[0]?.rate;
  // `=== undefined || === null`, never `||`: the string '0' is a real
  // reading — nothing served from cache — and `||` would erase it.
  if (raw === undefined || raw === null) return { rate: null };
  // Two decimals, matching what the page displays. See the unit test for why
  // the unrounded product is not what anyone expects.
  return { rate: Math.round(Number(raw) * 10000) / 100 };
}

export function rateVerdict(data: HitRateData, thresholds: Threshold[]): Verdict {
  // An unmeasurable rate must not ESCALATE. `Verdict.level` is
  // `ok | warn | critical` and this function must return one of them, so
  // there is no third state to return here — the same shape slots.ts uses
  // when `retainedBytes` is null. The `ok` is the absence of a finding, and
  // is not read as a claim about the cache: `CheckPanel` renders the reading
  // beside it, and the reading says null.
  if (data.rate === null) return { level: 'ok' };
  // Convention 3: no non-null assertion on `find`. A level's threshold is
  // data this check may not have been given, not a guarantee the type system
  // can see.
  const warn = thresholds.find((t) => t.level === 'warn');
  if (warn && data.rate < warn.value) {
    return { level: 'warn', note: `${data.rate.toFixed(2)}% of reads served from cache` };
  }
  return { level: 'ok' };
}

/** Spec §5's cap. Every list check in this PACKAGE shares it — see below. */
export const DEFAULT_LIMIT = 100;

/**
 * The schema-qualification rule for every catalog query in this file.
 *
 * `relname` alone is ambiguous: with `public.t` and `other.t` both present, a
 * bare name returns two rows labelled `t` and an operator cannot tell which
 * one the finding is about. `::regclass::text` is worse than useless here
 * because it qualifies only when the relation is OUTSIDE `search_path` — so
 * the same index renders as `public.foo` on one panel and `foo` on another,
 * depending on who is looking.
 *
 * The exclusion is two clauses, not one. `NOT IN (...)` is exact-match and
 * lets `pg_temp_7` and `pg_toast_temp_7` through, which puts another
 * session's temporary tables on the page; `NOT LIKE 'pg\\_%'` closes that.
 * The doubled backslash is deliberate — this is a JS template literal, and a
 * single `\_` is not a JS escape, so it would reach Postgres as a bare `_`
 * wildcard rather than a literal underscore.
 *
 * A function of the COLUMN, not a constant, because the column is not always
 * `n.nspname`. The `pg_stat_user_tables` / `pg_statio_user_tables` views
 * expose `schemaname` and no namespace oid to join on, and they do NOT close
 * this hole themselves: their own definition is
 * `schemaname <> ALL (ARRAY['pg_catalog','information_schema']) AND
 * schemaname !~ '^pg_toast'`, which lets every `pg_temp_N` through. Verified
 * on 17.11 — another session's `CREATE TEMP TABLE tmp_probe` reads back as
 * `pg_temp_29.tmp_probe` from an unrelated connection. One copy of the rule,
 * two spellings of the column.
 */
export function visibleSchemas(col: string): string {
  return `${col} NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND ${col} NOT LIKE 'pg\\_%'`;
}

export interface IndexEntry {
  name: string;
  table: string;
  definition: string;
  sizeBytes: number;
  unique: boolean;
  primary: boolean;
}

export interface IndexListRow {
  name: string;
  table_name: string;
  definition: string;
  size_bytes: string;
  is_unique: boolean;
  is_primary: boolean;
  total: number;
}

export interface IndexListData {
  indexes: IndexEntry[];
  /** The pre-`LIMIT` total (§5), from `count(*) OVER ()` — never `rows.length`. */
  total: number;
  truncated: boolean;
}

/**
 * `is_unique`/`is_primary`, not `unique`/`primary`: both are reserved words.
 * Postgres accepts a reserved word after an explicit `AS`, but the mapping
 * happens in TypeScript anyway, so there is nothing to buy by standing that
 * close to the edge — and `ORDER BY table` is already a syntax error that
 * cost an earlier draft an entire check.
 *
 * Ordered largest-first so the cap drops the least interesting rows (§5).
 * The `ORDER BY` reaches for `pg_relation_size(...)` again rather than the
 * `size_bytes` alias: that alias is `::text` for bigint safety, and sorting
 * it would rank '8192' above '20000000' lexicographically — the defect
 * `boundaries.test.ts` exists to catch.
 */
const INDEX_LIST_SQL = `
SELECT
  n.nspname || '.' || c.relname AS name,
  n.nspname || '.' || t.relname AS table_name,
  pg_get_indexdef(i.indexrelid) AS definition,
  pg_relation_size(i.indexrelid)::text AS size_bytes,
  i.indisunique AS is_unique,
  i.indisprimary AS is_primary,
  count(*) OVER ()::int AS total
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE ${visibleSchemas('n.nspname')}
ORDER BY pg_relation_size(i.indexrelid) DESC, c.relname
LIMIT $1`;

export function toIndexList(rows: IndexListRow[]): IndexListData {
  // §5: the total comes from the window function, so it survives the LIMIT.
  // Reading `rows.length` here would report a truncated list as complete.
  const total = rows[0]?.total ?? 0;
  return {
    indexes: rows.map((r) => ({
      name: r.name,
      table: r.table_name,
      definition: r.definition,
      // Convention 1: bigint arrives as text.
      sizeBytes: Number(r.size_bytes),
      unique: r.is_unique,
      primary: r.is_primary,
    })),
    total,
    truncated: total > rows.length,
  };
}

export const indexList: Check<IndexListRow, IndexListData, ListOpts> = {
  id: 'indexList',
  title: 'Indexes',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: INDEX_LIST_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toIndexList,
  // No verdict: §2.2. An inventory is a table an operator reads, and
  // `runCheck` yields `verdict: null`, which renders no badge.
};

export interface IndexCachingEntry { name: string; table: string; hitRate: number | null }

export interface IndexCachingRow {
  name: string;
  table_name: string;
  hit_rate: string | null;
  total: number;
}

export interface IndexCachingData {
  indexes: IndexCachingEntry[];
  total: number;
  truncated: boolean;
}

/**
 * `idx_blks_hit::numeric` is the whole correctness of this query, and the
 * cast is not cosmetic.
 *
 * Both columns are bigint, and bigint / bigint is INTEGER division in
 * Postgres — it truncates toward zero. Measured against 17.11 on an index
 * with 39,649 hits and 1 read, the uncast expression returns `0` where the
 * true rate is 0.99997477931904161412. Every index in the console would have
 * reported a 0% cache hit rate, and the per-index panel would have
 * contradicted `indexHitRate` above it, which divides sums the same way but
 * is saved by `sum()` returning numeric.
 *
 * Ordered by total blocks touched, descending, so the cap drops the indexes
 * nobody is reading — a rate computed from four block accesses is noise, and
 * it is the busy indexes whose cache behaviour is worth a page.
 */
const INDEX_CACHING_SQL = `
SELECT
  schemaname || '.' || indexrelname AS name,
  schemaname || '.' || relname AS table_name,
  (idx_blks_hit::numeric / nullif(idx_blks_hit + idx_blks_read, 0))::text AS hit_rate,
  count(*) OVER ()::int AS total
FROM pg_statio_user_indexes
ORDER BY (idx_blks_hit + idx_blks_read) DESC, indexrelname
LIMIT $1`;

export function toIndexCaching(rows: IndexCachingRow[]): IndexCachingData {
  const total = rows[0]?.total ?? 0;
  return {
    indexes: rows.map((r) => ({
      name: r.name,
      table: r.table_name,
      // Same null discipline and the same rounding as `toRate`, so one
      // index's rate and the database-wide rate are the same value formatted
      // the same way. An index with no I/O yet reads null, never 0%.
      hitRate: r.hit_rate === null ? null : Math.round(Number(r.hit_rate) * 10000) / 100,
    })),
    total,
    truncated: total > rows.length,
  };
}

export const indexCaching: Check<IndexCachingRow, IndexCachingData, ListOpts> = {
  id: 'indexCaching',
  title: 'Index caching',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: INDEX_CACHING_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toIndexCaching,
  // No verdict: §2.2.
};

export interface IndexFinding {
  name: string;
  table: string;
  sizeBytes: number;
}

export interface IndexFindingRow {
  name: string;
  table_name: string;
  size_bytes: string;
  total: number;
}

export interface IndexFindingData {
  indexes: IndexFinding[];
  total: number;
  truncated: boolean;
}

export function toFindings(rows: IndexFindingRow[]): IndexFindingData {
  const total = rows[0]?.total ?? 0;
  return {
    indexes: rows.map((r) => ({
      name: r.name,
      table: r.table_name,
      sizeBytes: Number(r.size_bytes),
    })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * The schema filter is not boilerplate here.
 *
 * A failed `REINDEX INDEX CONCURRENTLY` on a TOAST index leaves an invalid
 * index in `pg_toast`, and an operator cannot reindex it by name — listing it
 * is an instruction they cannot follow. An earlier draft scanned all of
 * `pg_index` and did exactly that.
 */
const INVALID_INDEXES_SQL = `
SELECT
  n.nspname || '.' || c.relname AS name,
  n.nspname || '.' || t.relname AS table_name,
  pg_relation_size(i.indexrelid)::text AS size_bytes,
  count(*) OVER ()::int AS total
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT i.indisvalid
  AND ${visibleSchemas('n.nspname')}
ORDER BY c.relname
LIMIT $1`;

/**
 * Escalates on `data.total`, never `rows.length` (§5).
 *
 * The distinction is the whole reason `total` is selected: with forty invalid
 * indexes and a cap of one hundred they agree, and with a cap of one they do
 * not — and the operator reading "1 invalid index" under a list of one is
 * given a number that is simply wrong.
 */
function findingVerdict(noun: string) {
  return (data: IndexFindingData, thresholds: Threshold[]): Verdict => {
    const warn = thresholds.find((t) => t.level === 'warn');
    if (warn && data.total >= warn.value) {
      return {
        level: 'warn',
        note: `${data.total} ${noun}${data.total === 1 ? '' : 'es'}`,
      };
    }
    return { level: 'ok' };
  };
}

export const invalidIndexes: Check<IndexFindingRow, IndexFindingData, ListOpts> = {
  id: 'invalidIndexes',
  title: 'Invalid indexes',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: INVALID_INDEXES_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toFindings,
  thresholds: [
    { level: 'warn', value: 1, unit: 'count',
      because: 'pgHero treats a non-empty invalid-index list as a warning '
             + '(index.html.erb); adopted for parity, not re-derived',
      // Prose, lower case, no statement: `guards.test.ts` confines DDL to
      // run.ts, and 'REINDEX INDEX CONCURRENTLY <name>;' matches its regex.
      remedy: 'An invalid index is not used by the planner and is not maintained. '
            + 'Rebuild it with reindex index concurrently, or drop it if nothing needs it.' },
  ],
  verdict: findingVerdict('invalid index'),
};

/**
 * Ten megabytes, declared ONCE — as the threshold's `value`, which the query
 * then reads as its floor.
 *
 * An earlier draft declared `value: 10, unit: 'bytes'` beside a query using
 * `10 * 1024 * 1024`. Both numbers were "10 MB" to whoever wrote them, and
 * `CheckPanel`'s Guidance would have told an operator the floor was ten
 * bytes. One number, one place.
 */
const UNUSED_INDEX_FLOOR_BYTES = 10 * 1024 * 1024;

/**
 * `indisunique` is excluded because those indexes exist to ENFORCE a
 * constraint, not to be scanned. A primary key with zero scans is perfectly
 * normal — nothing has looked a row up by id — and "drop it" is never the
 * right advice for one. Verified on 17.11 that both kinds would otherwise
 * qualify: at 600,000 rows the pkey is 13 MB and the unique index 22 MB,
 * both unscanned and both over the floor.
 *
 * One clause, not two. `AND NOT i.indisprimary` beside this reads as though
 * it were doing separate work, and it cannot: `indisprimary` implies
 * `indisunique` — a primary key is always backed by a unique index. Counted
 * on 17.11: 106 primary-key indexes, 106 of them unique, and zero rows
 * anywhere matching `indisprimary AND NOT indisunique`. Removing the
 * redundant clause changed no test, which is exactly why it should not be
 * here pretending to.
 *
 * Ordered largest-first so the cap drops the least wasteful rows (§5), and
 * by `pg_relation_size(...)` rather than the `size_bytes` alias, which is
 * `::text` and would sort lexicographically.
 */
const UNUSED_INDEXES_SQL = `
SELECT
  n.nspname || '.' || c.relname AS name,
  n.nspname || '.' || t.relname AS table_name,
  pg_relation_size(i.indexrelid)::text AS size_bytes,
  count(*) OVER ()::int AS total
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE s.idx_scan = 0
  AND NOT i.indisunique
  AND pg_relation_size(i.indexrelid) >= $1
  AND ${visibleSchemas('n.nspname')}
ORDER BY pg_relation_size(i.indexrelid) DESC, c.relname
LIMIT $2`;

export const unusedIndexes: Check<IndexFindingRow, IndexFindingData, ListOpts> = {
  id: 'unusedIndexes',
  title: 'Unused indexes',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({
    text: UNUSED_INDEXES_SQL,
    values: [UNUSED_INDEX_FLOOR_BYTES, o.limit ?? DEFAULT_LIMIT],
  }),
  map: toFindings,
  thresholds: [
    { level: 'warn', value: UNUSED_INDEX_FLOOR_BYTES, unit: 'bytes',
      because: "pgHero's unused_index_megabytes (database.rb) is 10 MB; adopted for "
             + 'parity. It is a floor on what is worth reporting, not a level a '
             + 'reading climbs to',
      remedy: 'Confirm the index is unused on every replica too — idx_scan is '
            + 'per-server — then drop it. Statistics since the last reset are all '
            + 'this counts, so check when that was.' },
  ],
  // Escalates on the COUNT of qualifying indexes, not on their size: the
  // threshold's value is the floor the query already applied, so every row
  // here is over it and one is enough.
  verdict: (d, _t): Verdict => (d.total > 0
    ? { level: 'warn', note: `${d.total} unused index${d.total === 1 ? '' : 'es'}` }
    : { level: 'ok' }),
};

export interface DuplicatePair {
  name: string;
  coveredBy: string;
  table: string;
  sizeBytes: number;
}

export interface DuplicateRow {
  name: string;
  covered_by: string;
  table_name: string;
  size_bytes: string;
  total: number;
}

export interface DuplicateData {
  pairs: DuplicatePair[];
  /** Redundant INDEXES, not covering relationships — see the docblock. */
  total: number;
  truncated: boolean;
}

export function toDuplicates(rows: DuplicateRow[]): DuplicateData {
  const total = rows[0]?.total ?? 0;
  return {
    pairs: rows.map((r) => ({
      name: r.name,
      coveredBy: r.covered_by,
      table: r.table_name,
      sizeBytes: Number(r.size_bytes),
    })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * The only check in this phase whose output is a DESTRUCTIVE recommendation,
 * and the reason it compares key ARRAYS the way pgHero's `index_covers?`
 * does rather than matching `indkey` as text.
 *
 * The text approach — `b.indkey::text LIKE a.indkey::text || '%'` — is wrong
 * in five distinct ways, each reproduced on PostgreSQL 17.11 against the
 * fixture in indexes.int.test.ts:
 *
 *   1. Column-number prefix collision. `indkey` for `(c1)` is "1" and for
 *      `(c11)` is "11", and '11' LIKE '1%'. An index on c1 was reported as
 *      covered by an index on an unrelated column.
 *   2. Exact duplicates never reported. Pairing on strictly-longer keys
 *      skips equal-length pairs, so two byte-identical indexes on (a)
 *      produced nothing — the most common and most actionable duplicate
 *      there is.
 *   3. Expression indexes all collide: every expression index has `indkey`
 *      "0", so `lower(d)` was reported as covered by any other expression
 *      index. Excluded here via `indexprs IS NULL`.
 *   4. Partial indexes treated as covering. `ix_full ON t(c3)` was reported
 *      as covered by `ix_part ON t(c3,c4) WHERE c4 > 0`; acting on that
 *      loses coverage for `c4 <= 0`. Hence `NOT b.partial`.
 *   5. Access method and opclass ignored. A hash index was reported as
 *      covered by a btree, and a `text_pattern_ops` index by a
 *      default-opclass one — though only the former serves `LIKE 'x%'`.
 *      The equal leading `indclass` slice closes BOTH, which is why there is
 *      no `b.relam = a.relam` beside it. An opclass OID names one access
 *      method and only one (`pg_opclass.opcmethod`), so equal opclass arrays
 *      already imply an equal access method: `int4_ops` is OID 1978 under
 *      btree and a SEPARATE OID 10020 under hash, so the hash index in the
 *      fixture is excluded by opclass before an access-method test could
 *      look at it. Adding that test back changes no result — verified by
 *      deleting it and watching all twenty integration tests still pass,
 *      which is how it was found.
 *
 * The slice is `[1:indnkeyatts]`, so INCLUDE columns are not compared as
 * keys — a covering index's payload does not make it a prefix of anything.
 *
 * Two deliberate asymmetries:
 *
 * A unique index is never reported as REDUNDANT (`NOT a.indisunique`) —
 * it enforces a constraint, and dropping it changes what the database
 * accepts — but it stays available on the covering side, because an ordinary
 * index duplicating a unique one really is redundant. A partial index is
 * likewise never the candidate: it is the cheaper, narrower object, and
 * "drop the partial because a full index covers it" is a judgement about
 * cost that this check has no information to make.
 *
 * `DISTINCT ON (a.indexrelid)` makes this ONE ROW PER REDUNDANT INDEX, not
 * one per covering relationship — an index covered by three others is one
 * problem, not three — so `total` counts indexes an operator could drop, and
 * the page's copy must say so. The tie-break prefers a coverer with the same
 * key count, because "these two are identical" is a stronger and clearer
 * statement than "this one is a prefix of that one".
 *
 * `(array_length(b.keys,1) > array_length(a.keys,1) OR a.indexrelid >
 * b.indexrelid)` is what keeps a byte-identical pair from being reported
 * twice, once in each direction: for equal keys only the later-created index
 * is the redundant one.
 */
const DUPLICATE_INDEXES_SQL = `
WITH ix AS (
  SELECT
    i.indexrelid,
    i.indrelid,
    i.indisunique,
    (i.indpred IS NOT NULL) AS partial,
    (string_to_array(i.indkey::text, ' ')::int[])[1:i.indnkeyatts]   AS keys,
    (string_to_array(i.indclass::text, ' ')::oid[])[1:i.indnkeyatts] AS classes,
    n.nspname || '.' || c.relname AS name,
    n.nspname || '.' || t.relname AS table_name,
    pg_relation_size(i.indexrelid) AS bytes
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE i.indexprs IS NULL
    AND i.indisvalid
    AND ${visibleSchemas('n.nspname')}
), dups AS (
  -- The ::text cast is declared HERE, above this CTE's own ORDER BY, and the
  -- outer query references it only as \`d.size_bytes\`. boundaries.test.ts
  -- slices from the FIRST \`ORDER BY\` to the end of the statement and fails
  -- on a bare occurrence of a ::text alias inside that slice — so an
  -- \`AS size_bytes\` written in the outer SELECT, which necessarily follows
  -- this ORDER BY, trips it even though nothing sorts by it. Qualifying the
  -- reference is the escape the guard documents; \`bytes_num\` is the numeric
  -- column the outer ORDER BY actually sorts on, named distinctly for the
  -- same reason slots.ts has \`retained_bytes_num\`.
  SELECT DISTINCT ON (a.indexrelid)
    a.name, b.name AS covered_by, a.table_name,
    a.bytes AS bytes_num,
    a.bytes::text AS size_bytes
  FROM ix a
  JOIN ix b
    ON b.indrelid = a.indrelid
   AND b.indexrelid <> a.indexrelid
   AND NOT b.partial
   AND b.keys[1:array_length(a.keys, 1)] = a.keys
   AND b.classes[1:array_length(a.classes, 1)] = a.classes
   AND (array_length(b.keys, 1) > array_length(a.keys, 1) OR a.indexrelid > b.indexrelid)
  WHERE NOT a.indisunique
    AND NOT a.partial
  ORDER BY a.indexrelid,
           (array_length(b.keys, 1) = array_length(a.keys, 1)) DESC,
           b.bytes,
           b.indexrelid
)
SELECT d.name, d.covered_by, d.table_name, d.size_bytes, count(*) OVER ()::int AS total
FROM dups d
ORDER BY d.bytes_num DESC, d.name
LIMIT $1`;

export const duplicateIndexes: Check<DuplicateRow, DuplicateData, ListOpts> = {
  id: 'duplicateIndexes',
  title: 'Duplicate indexes',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: DUPLICATE_INDEXES_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toDuplicates,
  // No verdict, and §2.2 is only half the reason. A duplicate index is
  // sometimes deliberate — kept during a migration, or held for a rebuild —
  // so a database with one is not thereby unhealthy. This lists what it
  // found and lets a human decide.
};

export interface TableIndexUsage {
  table: string;
  /**
   * `null` is §3's divergence from pgHero, which emits the STRING
   * 'Insufficient data' in the same column as a numeric percentage — making
   * that column text-or-number for every consumer downstream.
   */
  indexHitRate: number | null;
  estimatedRows: number;
}

export interface TableUsageRow {
  name: string;
  index_hit_rate: string | null;
  estimated_rows: string;
  total: number;
}

export interface TableUsageData {
  tables: TableIndexUsage[];
  total: number;
  truncated: boolean;
}

export function toTableUsage(rows: TableUsageRow[]): TableUsageData {
  const total = rows[0]?.total ?? 0;
  return {
    tables: rows.map((r) => ({
      table: r.name,
      // Null stays null. Collapsing it to 0 would report the index-less
      // table as "0% of scans used an index" — true in a sense, and
      // indistinguishable from a table whose indexes are being ignored.
      indexHitRate: r.index_hit_rate === null
        ? null
        : Math.round(Number(r.index_hit_rate) * 100) / 100,
      estimatedRows: Number(r.estimated_rows),
    })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * Why the rate can be null, stated correctly.
 *
 * `pg_stat_user_tables.idx_scan` is NULL for a table with NO INDEXES AT ALL
 * — verified on 17.11: a 100-row table scanned twice reports `seq_scan = 2`
 * and `idx_scan = NULL`, while an indexed table that has merely not been
 * index-scanned reports `idx_scan = 0`. So the null row is the heavily
 * seq-scanned, index-less table: the one most obviously WANTING an index,
 * not the one nobody has touched. An earlier draft's comment said the
 * opposite, which would have led a reader to dismiss exactly the rows worth
 * looking at.
 *
 * `::numeric` for the same reason as `indexCaching`: `idx_scan` and
 * `seq_scan` are bigint, and bigint division truncates, so every rate below
 * 100% would render as a whole number at best and 0 at worst.
 *
 * Largest table first, so the cap drops the rows least worth acting on.
 */
const INDEX_USAGE_SQL = `
SELECT
  schemaname || '.' || relname AS name,
  (100 * idx_scan::numeric / nullif(seq_scan + idx_scan, 0))::text AS index_hit_rate,
  n_live_tup::text AS estimated_rows,
  count(*) OVER ()::int AS total
FROM pg_stat_user_tables
WHERE schemaname NOT LIKE 'pg\\_%'
ORDER BY n_live_tup DESC, relname
LIMIT $1`;

export const indexUsage: Check<TableUsageRow, TableUsageData, ListOpts> = {
  id: 'indexUsage',
  title: 'Index usage by table',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: INDEX_USAGE_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toTableUsage,
  // No verdict: §2.2.
};

/**
 * pgHero's three filters, kept as SQL constants rather than `Threshold` data,
 * and the distinction is deliberate.
 *
 * A `Threshold` is a number a READING is compared against, which the panel
 * shows the operator beside a verdict and explains with `because`. These
 * three decide which rows EXIST at all, and this check has no verdict for
 * them to feed (§2.1 lists none for #25). Promoting them would put three
 * numbers on the page that no badge ever refers to.
 *
 * The numbers are pgHero's `missing_indexes`: `idx_scan > 0`, an index hit
 * rate under 95, and at least 10,000 live rows. Adopted for parity, not
 * re-derived.
 *
 * pgHero's `CASE WHEN idx_scan = 0 THEN 'Insufficient data'` arm is NOT
 * ported: its own `WHERE idx_scan > 0` makes that branch unreachable (§3).
 *
 * The filter keeps pgHero's integer division while the displayed rate uses
 * numeric, and the two cannot disagree: `floor(x) < 95` holds exactly when
 * `x < 95`, since 95 is an integer.
 */
const MISSING_INDEXES_SQL = `
SELECT
  schemaname || '.' || relname AS name,
  (100 * idx_scan::numeric / nullif(seq_scan + idx_scan, 0))::text AS index_hit_rate,
  n_live_tup::text AS estimated_rows,
  count(*) OVER ()::int AS total
FROM pg_stat_user_tables
WHERE idx_scan > 0
  AND (100 * idx_scan / (seq_scan + idx_scan)) < 95
  AND n_live_tup >= 10000
  AND schemaname NOT LIKE 'pg\\_%'
ORDER BY n_live_tup DESC, relname
LIMIT $1`;

export const missingIndexes: Check<TableUsageRow, TableUsageData, ListOpts> = {
  id: 'missingIndexes',
  title: 'Tables that may want an index',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: MISSING_INDEXES_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toTableUsage,
  // No verdict: §2.2. "May want an index" is a reading, not a finding — the
  // right index depends on the queries, which this check cannot see.
};

export interface StatsResetRow { stats_reset: string | null }

/** `null` means the statistics have never been reset, not the epoch. */
export interface StatsResetData { statsReset: string | null }

/**
 * Scoped to `current_database()` — the Ruling 55 scoping `queryStats`
 * already uses. `pg_stat_database` has a row per database, and unscoped this
 * attributes some other database's reset to this one.
 */
const STATS_RESET_SQL = `
SELECT stats_reset::text AS stats_reset
FROM pg_stat_database
WHERE datname = current_database()`;

export function toStatsReset(rows: StatsResetRow[]): StatsResetData {
  // `?? null` rather than `||`: there is no falsy timestamp to confuse here,
  // but the rule is the rule, and an absent row means "we could not look".
  return { statsReset: rows[0]?.stats_reset ?? null };
}

export const lastStatsReset: Check<StatsResetRow, StatsResetData> = {
  id: 'lastStatsReset',
  title: 'Statistics last reset',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: STATS_RESET_SQL,
  map: toStatsReset,
  // No verdict: §2.2. A date is context for every other number on the page,
  // not a thing to escalate on.
};

export const indexHitRate: Check<HitRateRow, HitRateData> = {
  id: 'indexHitRate',
  title: 'Index cache hit rate',
  gate: 'work',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: HIT_RATE_SQL,
  map: toRate,
  thresholds: [
    { level: 'warn', value: 99, unit: 'percent',
      because: "pgHero's cache_hit_rate_threshold (lib/pghero.rb) is 99; adopted for "
             + 'parity, not re-derived from Postgres behaviour',
      remedy: 'A low rate means index pages are being read from disk rather than '
            + 'found in cache, usually because the working set has outgrown '
            + 'shared_buffers. Check when statistics were last reset before acting: '
            + 'these counters run from that moment, so a rate read shortly after a '
            + 'restart describes the restart more than the cache.' },
  ],
  verdict: rateVerdict,
};
