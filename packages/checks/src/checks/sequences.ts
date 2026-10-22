import type { Check } from '../types.js';
import { DEFAULT_LIMIT, capped, visibleSchemas, type RelationOpts } from './shared.js';

export interface SequenceRow {
  name: string;
  table_name: string | null;
  column_name: string | null;
  column_type: string | null;
  max_value: string;
  last_value: string | null;
  readable: boolean;
  unreadable: number;
  worst_pct: string | null;
  total: number;
}

export interface SequenceEntry {
  name: string;
  /** `null` when no column owns this sequence. */
  table: string | null;
  column: string | null;
  columnType: string | null;
  /**
   * The ceiling this sequence will actually hit, from the column's type
   * where one owns it. The bigint ceiling is not exactly representable as a
   * JS number and arrives as 9223372036854776000: fine for the percentage,
   * but do not render it raw; render `columnType`.
   */
  maxValue: number;
  /** `null` only when the sequence is unreadable. Never-called reads as its start value. */
  lastValue: number | null;
  /** `null` means "we could not look", never 0%. */
  pctUsed: number | null;
  readable: boolean;
}

export interface SequenceData {
  sequences: SequenceEntry[];
  total: number;
  truncated: boolean;
  /**
   * Unreadable sequences among everything that matched the WHERE, not on
   * the page. Under a `relation` filter it counts that table's only.
   */
  unreadable: number;
  /** The highest usage across every readable sequence that matched, before the cap. */
  worstPctUsed: number | null;
}

export function toSequences(rows: SequenceRow[]): SequenceData {
  const worst = rows[0]?.worst_pct;
  return {
    sequences: rows.map((r) => {
      const maxValue = Number(r.max_value);
      // `=== null`, never `||`: a readable sequence at 0 is a real reading.
      const lastValue = r.last_value === null ? null : Number(r.last_value);
      return {
        name: r.name,
        table: r.table_name,
        column: r.column_name,
        columnType: r.column_type,
        maxValue,
        lastValue,
        // Uses the ceiling the query chose; the type-to-ceiling mapping
        // lives only in the SQL.
        pctUsed: lastValue === null ? null : (lastValue / maxValue) * 100,
        readable: r.readable,
      };
    }),
    ...capped(rows),
    unreadable: rows[0]?.unreadable ?? 0,
    worstPctUsed: worst === undefined || worst === null ? null : Number(worst) * 100,
  };
}

/**
 * Sequence usage, measured against the owning column's type and not the
 * sequence's own maximum: a `bigint` sequence feeding an `integer` column
 * fails at 2,147,483,647. The mapping is pgHero's: smallint 32767, integer
 * 2147483647, everything else the bigint maximum.
 *
 * - Driven from `pg_class`, with the column optional. A sequence wired only
 *   through a column DEFAULT, with no OWNED BY, has no `pg_depend` row to a
 *   table, and a `pg_depend`-driven query would omit it. Its ceiling falls
 *   back to the sequence's own `max_value`, which understates the risk.
 * - No `::regnamespace`: it parses identifier syntax, so one schema named
 *   "Weird Schema" fails the whole check with `invalid name syntax`.
 * - `'SELECT,USAGE'` means "any of". Either privilege exposes `last_value`.
 * - A NULL `last_value` means never called, not unreadable. Readability
 *   comes from the privilege predicate, and the value falls back to
 *   `start_value`.
 * - `unreadable` and `worst_pct` are window aggregates, computed before the
 *   LIMIT, so the worst does not depend on the worst row surviving the
 *   cap or on the ORDER BY.
 * - Ordered by fraction used, not `last_value`, so the cap keeps the
 *   nearest-to-full sequences.
 * - Temporary sequences are excluded by the schema filter; they always live
 *   in a `pg_temp_N` schema.
 */
const SEQUENCES_SQL = `
WITH seq AS (
  SELECT c.oid AS seqoid,
         n.nspname || '.' || c.relname AS name,
         n.nspname AS nsp, c.relname AS rel,
         has_sequence_privilege(c.oid, 'SELECT,USAGE') AS readable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'S'
    AND ${visibleSchemas('n.nspname')}
    AND n.nspname <> 'pgops'
),
owned AS (
  SELECT DISTINCT ON (d.objid)
         d.objid AS seqoid,
         tn.nspname || '.' || t.relname AS table_name,
         a.attname AS column_name,
         format_type(a.atttypid, NULL) AS column_type
  FROM pg_depend d
  JOIN pg_class t ON t.oid = d.refobjid
  JOIN pg_namespace tn ON tn.oid = t.relnamespace
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  WHERE d.classid = 'pg_class'::regclass
    AND d.refclassid = 'pg_class'::regclass
    AND d.deptype IN ('a', 'i')
    AND d.objsubid = 0
    AND NOT a.attisdropped
  ORDER BY d.objid, a.attnum
)
SELECT s.name,
       o.table_name,
       o.column_name,
       o.column_type,
       v.ceiling::text AS max_value,
       v.val::text     AS last_value,
       s.readable,
       count(*) FILTER (WHERE NOT s.readable) OVER ()::int AS unreadable,
       max(v.val / v.ceiling) OVER ()::text AS worst_pct,
       count(*) OVER ()::int AS total
FROM seq s
LEFT JOIN owned o ON o.seqoid = s.seqoid
LEFT JOIN pg_sequences ps ON ps.schemaname = s.nsp AND ps.sequencename = s.rel
CROSS JOIN LATERAL (
  SELECT
    CASE o.column_type
      WHEN 'smallint' THEN 32767::numeric
      WHEN 'integer'  THEN 2147483647::numeric
      WHEN 'bigint'   THEN 9223372036854775807::numeric
      ELSE coalesce(ps.max_value, 9223372036854775807)::numeric
    END AS ceiling,
    CASE WHEN s.readable THEN coalesce(ps.last_value, ps.start_value)::numeric END AS val
) v
-- unreadable and worst_pct are window functions computed after this
-- WHERE, so a relation-scoped call reports that table's own figures.
WHERE ($2::text IS NULL OR o.table_name = $2)
ORDER BY (v.val / v.ceiling) DESC NULLS LAST, s.name
LIMIT $1`;

export const sequences: Check<SequenceRow, SequenceData, RelationOpts> = {
  id: 'sequences',
  home: 'sequence',
  class: 'captured',
  timeoutMs: 10_000,
  sql: (o) => ({ text: SEQUENCES_SQL, values: [o.limit ?? DEFAULT_LIMIT, o.relation ?? null] }),
  map: toSequences,
  thresholds: [
    { level: 'warn', value: 90,
      because: "pgHero's sequence_danger(threshold: 0.9); adopted for parity, and "
             + 'measured against the column type rather than the sequence maximum' },
  ],
};
