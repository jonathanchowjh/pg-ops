import type { Check, Verdict } from '../types.js';
import { DEFAULT_LIMIT, visibleSchemas, type ListOpts } from './indexes.js';

export interface ConstraintRow {
  name: string;
  table_name: string;
  definition: string;
  total: number;
}

export interface InvalidConstraint {
  name: string;
  /** Schema-qualified. A constraint name is unique per TABLE, not per database. */
  table: string;
  /** `pg_get_constraintdef`, which ends in `NOT VALID` for exactly these rows. */
  definition: string;
}

export interface ConstraintData {
  constraints: InvalidConstraint[];
  total: number;
  truncated: boolean;
}

export function toConstraints(rows: ConstraintRow[]): ConstraintData {
  const total = rows[0]?.total ?? 0;
  return {
    constraints: rows.map((r) => ({
      name: r.name,
      table: r.table_name,
      definition: r.definition,
    })),
    total,
    truncated: total > rows.length,
  };
}

/**
 * `NOT convalidated` is the WHOLE filter, and the absence of a `contype`
 * allowlist beside it is deliberate.
 *
 * The obvious form is `AND c.contype IN ('c', 'f')`, on the reasoning that
 * only CHECK and FOREIGN KEY can be left `NOT VALID`. That was true through
 * PostgreSQL 17 and stopped being true in 18, which catalogues NOT NULL as a
 * constraint of its own and lets it be added unvalidated. Verified on 18.6:
 *
 *     ALTER TABLE t ADD CONSTRAINT t_v_nn NOT NULL v NOT VALID;
 *     -- conname | contype | convalidated | pg_get_constraintdef
 *     -- t_v_nn  | n       | f            | NOT NULL v NOT VALID
 *
 * An allowlist would drop that row and render an EMPTY panel on a database
 * with a half-built NOT NULL — the silent-incompleteness failure this project
 * exists to avoid, and the CI matrix runs 18.
 *
 * Dropping the allowlist costs nothing in exchange, because `convalidated` is
 * not a general-purpose flag: counted on 18.6, primary-key, unique and
 * exclusion constraints are all `convalidated = true` always, so no allowlist
 * was ever excluding a row on any version. A clause that cannot exclude
 * anything is not a safety net; it is a comment that the compiler checks.
 *
 * The schema filter is the package's shared one, imported rather than copied
 * — it carries the doubled-backslash trap in its own docblock, and a second
 * copy is a second place for that to regrow.
 *
 * `ORDER BY c.conname` alone is NOT stable under the cap. Constraint names
 * are unique per table, so `public.child` and `other.child` can both hold a
 * `child_n_positive` — verified on 17.11, two rows, same name. With `LIMIT 1`
 * over a tie, which one survives is up to the executor. The qualified table
 * breaks the tie.
 */
const INVALID_CONSTRAINTS_SQL = `
SELECT
  c.conname AS name,
  n.nspname || '.' || t.relname AS table_name,
  pg_get_constraintdef(c.oid) AS definition,
  count(*) OVER ()::int AS total
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE NOT c.convalidated
  AND ${visibleSchemas('n.nspname')}
ORDER BY c.conname, n.nspname, t.relname
LIMIT $1`;

/**
 * `gate: 'keep-up'` while the page that renders it is a `work` page.
 *
 * That mismatch is intentional and is one of three the spec names. The gate
 * says which gate of a request's life the READING is about — an unvalidated
 * constraint is maintenance debt, not something a query is blocked on — while
 * the page groups it beside `invalidIndexes` because both answer one
 * operator question: did a migration leave something half-built? Do not
 * "fix" this to match its page.
 */
export const invalidConstraints: Check<ConstraintRow, ConstraintData, ListOpts> = {
  id: 'invalidConstraints',
  // A7: the count reaches the hygiene cache and so the triage page and the
  // overview, without a verdict being invented for a finding that is worth
  // doing something about and is not a reason to call a database unwell.
  found: (d) => (d.total === 0 ? null : `${d.total} ${d.total === 1 ? 'unvalidated constraint' : 'unvalidated constraints'}`),
  title: 'Invalid constraints',
  gate: 'keep-up',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: INVALID_CONSTRAINTS_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toConstraints,
  thresholds: [
    { level: 'warn', value: 1, unit: 'count',
      because: 'pgHero treats a non-empty invalid-constraint list as a warning '
             + '(methods/constraints.rb); adopted for parity, not re-derived',
      // Prose, lower case, no statement. `guards.test.ts` confines DDL to
      // run.ts, and its regex is `(CREATE|ALTER|DROP)\s+...TABLE` — so the
      // obvious wording, "validate it with alter table ... validate
      // constraint", fails that guard from inside a string literal, which
      // `strip()` does not remove the way it removes this comment.
      remedy: 'An unvalidated constraint binds new rows only — rows already in the '
            + 'table may violate it, and the planner will not rely on it. Run the '
            + 'validate-constraint form once the existing rows conform; it scans '
            + 'the table once under a lock that still allows reads and writes.' },
  ],
  /**
   * Escalates on `data.total`, never `rows.length` (§5) — with a cap of one
   * over three findings, `constraints.length` would report "1 unvalidated
   * constraint" under a list the cap itself truncated.
   *
   * Not `findingVerdict` from indexes.ts, which is otherwise the same shape:
   * that one pluralises with `es`, for "index/indexes", and would render
   * "3 unvalidated constraintes".
   */
  verdict: (d, t): Verdict => {
    const warn = t.find((x) => x.level === 'warn');
    if (warn && d.total >= warn.value) {
      return {
        level: 'warn',
        note: `${d.total} unvalidated constraint${d.total === 1 ? '' : 's'}`,
      };
    }
    return { level: 'ok' };
  },
};
