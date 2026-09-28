import type { Check, Threshold, Verdict } from '../types.js';
import { DEFAULT_LIMIT, visibleSchemas, type RelationOpts } from './indexes.js';

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
  /** `null` when no column owns this sequence — see the docblock. */
  table: string | null;
  column: string | null;
  columnType: string | null;
  /**
   * The ceiling this sequence will actually hit, from the COLUMN's type where
   * one owns it. NOTE: the bigint ceiling, 9223372036854775807, is not exactly
   * representable as a JS number and arrives as 9223372036854776000. That is
   * harmless for the percentage — the error is ~1e-16 relative — but do not
   * render this value raw for a bigint column; render `columnType`.
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
   * #54. A window aggregate over every sequence that survived the WHERE, not
   * a count of the page — see the docblock. That was a database-wide count
   * before this file grew a `relation` filter; under one, it counts THAT
   * TABLE's unreadable sequences, exactly as `worstPctUsed` below does, and
   * the SQL comment above the `WHERE` covers both, not just `worst_pct`.
   */
  unreadable: number;
  /** The highest usage across EVERY readable sequence, cap or no cap. */
  worstPctUsed: number | null;
}

export function toSequences(rows: SequenceRow[]): SequenceData {
  const total = rows[0]?.total ?? 0;
  const worst = rows[0]?.worst_pct;
  return {
    sequences: rows.map((r) => {
      const maxValue = Number(r.max_value);
      // `=== null`, never `||`: an unreadable sequence has no value, and a
      // readable one sitting at 0 is a real reading.
      const lastValue = r.last_value === null ? null : Number(r.last_value);
      return {
        name: r.name,
        table: r.table_name,
        column: r.column_name,
        columnType: r.column_type,
        maxValue,
        lastValue,
        // Derived from the ceiling the QUERY chose, so the two cannot drift:
        // there is one mapping from column type to ceiling and it lives in the
        // SQL below.
        pctUsed: lastValue === null ? null : (lastValue / maxValue) * 100,
        readable: r.readable,
      };
    }),
    total,
    truncated: total > rows.length,
    unreadable: rows[0]?.unreadable ?? 0,
    worstPctUsed: worst === undefined || worst === null ? null : Number(worst) * 100,
  };
}

/**
 * #52, #53 and #54 in one query — the most intricate in P2.
 *
 * §3's divergence is the whole point of #53: **the danger is the COLUMN's
 * type, not the sequence's own maximum.** A `bigint` sequence feeding an
 * `integer` column fails at 2,147,483,647 with four billion values still
 * unspent, and a check measuring against the sequence would call that 0.00%
 * full. pgHero's mapping is adopted verbatim (methods/sequences.rb):
 * smallint 32767, integer 2147483647, everything else the bigint maximum.
 *
 * **Driven from `pg_class`, not from `pg_depend`.** A sequence wired only
 * through a column DEFAULT, with no OWNED BY, has NO `pg_class` dependency at
 * all — verified on 17.11, `CREATE SEQUENCE loose_seq; CREATE TABLE t (id int
 * DEFAULT nextval('loose_seq'))` produces only an `'n'` dependency on its
 * namespace. A `pg_depend`-driven query omits it silently, which is the one
 * failure mode this console exists to avoid. Listing every sequence and making
 * the COLUMN the optional part costs nothing and cannot omit one. pgHero
 * instead parses the default expression in Ruby; the ceiling here falls back
 * to the sequence's own `max_value`, which understates the risk for that case
 * and is recorded rather than hidden.
 *
 * **`regnamespace` is not used, deliberately.** `s.schemaname::regnamespace`
 * parses its argument as identifier syntax, so a single schema named
 * `"Weird Schema"` anywhere in the database makes the whole check return
 * `{ok:false}` with `ERROR: invalid name syntax` — permanently, for every
 * schema. The namespace is joined and compared by oid instead.
 *
 * **`'SELECT,USAGE'` means "any of".** Postgres exposes `last_value` to either
 * privilege, so a `'SELECT'`-only predicate calls a USAGE-only role's
 * perfectly readable sequence unreadable — blanking a 93%-full row and
 * dropping it from the verdict.
 *
 * **A NULL `last_value` does not mean unreadable.** Verified on 17.11: three
 * freshly created, fully readable sequences all read NULL, because nothing has
 * called them yet. Readability comes from the privilege predicate alone, and a
 * never-called sequence falls back to `start_value` exactly as pgHero's own
 * COALESCE does.
 *
 * **`unreadable` and `worst_pct` are window aggregates**, computed before the
 * LIMIT. `worst_pct` is deliberately redundant with the ordering: with the
 * ORDER BY correct, the worst row is always on the page and a per-row value
 * would agree, so no single mutation distinguishes them. It exists so the
 * VERDICT does not silently depend on the ordering staying right — change the
 * ORDER BY and one test fails, rather than the verdict quietly going wrong
 * too. Unreadable rows sort last and are the first a cap discards, so
 * counting the returned page would let a truncated list claim a database-wide
 * fact. The same reasoning applies to the verdict: `worst_pct` makes it
 * independent of the ORDER BY rather than relying on the worst row surviving.
 *
 * **Ordered by headroom, not by `last_value`.** Absolute ordering put a
 * 0.00%-full bigint sequence at 5,000,000,000 above a 93%-full integer one at
 * 2,000,000,000, and the cap then discarded the only finding.
 *
 * Temporary sequences are excluded by the shared schema filter, NOT by a
 * `relpersistence <> 't'` clause. pgHero carries that clause because it has no
 * temp-schema filter of its own; here it would be a second guard on the same
 * thing, and mutation proved it — deleting either one alone changed no test,
 * because a temporary sequence always lives in a `pg_temp_N` schema and the
 * filter already excludes it. One guard, and the tests now fail without it.
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
-- \`unreadable\` and \`worst_pct\` above are window functions computed AFTER
-- this WHERE, so a relation-scoped call's \`unreadable\` count and
-- \`worst_pct\` are both THAT TABLE's — one unreadable-sequence count and
-- one worst reading, not the database's. That is correct, and more
-- actionable, for a Table page asking about one relation: the 90% threshold
-- below is PER SEQUENCE, so a per-table \`worst_pct\` crossing it is as real
-- a finding as a database-wide one, and the Table page's own comment on
-- \`seqsForDisplay\` explains what it does and does not withhold.
WHERE ($2::text IS NULL OR o.table_name = $2)
ORDER BY (v.val / v.ceiling) DESC NULLS LAST, s.name
LIMIT $1`;

export const sequences: Check<SequenceRow, SequenceData, RelationOpts> = {
  id: 'sequences',
  title: 'Sequence exhaustion',
  gate: 'keep-up',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: SEQUENCES_SQL, values: [o.limit ?? DEFAULT_LIMIT, o.relation ?? null] }),
  map: toSequences,
  thresholds: [
    { level: 'warn', value: 90, unit: 'percent',
      because: "pgHero's sequence_danger(threshold: 0.9); adopted for parity, and "
             + 'measured against the column type rather than the sequence maximum',
      remedy: 'The column overflows before the sequence does, so widening the column '
            + 'is the fix and cycling the sequence is not. A bigint column takes the '
            + 'ceiling to nine quintillion; doing it on a large table rewrites it, so '
            + 'plan for the lock rather than discovering it at exhaustion.' },
  ],
  /**
   * Escalates on `worstPctUsed`, a window aggregate over EVERY readable
   * sequence, so the verdict is correct under a cap no matter how the list is
   * ordered. Reading the returned page would make the verdict depend on the
   * ORDER BY continuing to sort the worst row first.
   *
   * `null` — no readable sequence to judge — returns `ok`, because `Verdict`
   * has no third state. That is the absence of a finding, not a claim that the
   * sequences are fine; `data.unreadable` is rendered beside it and says so.
   */
  verdict: (d: SequenceData, t: Threshold[]): Verdict => {
    const warn = t.find((x) => x.level === 'warn');
    if (d.worstPctUsed === null || !warn) return { level: 'ok' };
    if (d.worstPctUsed >= warn.value) {
      return { level: 'warn', note: `${d.worstPctUsed.toFixed(2)}% of a column's range used` };
    }
    return { level: 'ok' };
  },
};
