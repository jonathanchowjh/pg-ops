import type { Check } from '../types.js';

export interface ActivityRow {
  kind: 'total' | 'wait' | 'shape';
  key: string | null;
  detail: string | null;
  sessions: number;
  longest_secs: string | null;
  query_id: string | null;
  statement: string | null;
  /** Buckets this grouping had BEFORE its cap; null on the total row. */
  total: number | null;
  /**
   * MEASURED (horizon.int.test.ts:44): a role without `pg_read_all_stats`
   * gets NULL `state` for a backend belonging to another role. This check's
   * `act` CTE filters `WHERE state = 'active'`, and `NULL = 'active'` is
   * NULL, not true — so every foreign backend this role cannot see the
   * state of is silently excluded, and a saturated server this role cannot
   * fully read comes back with zero rows, same as an idle one. Carried only
   * on the `'total'` row (NULL on the others) because `count(*)` over an
   * empty CTE still returns exactly one row of that kind, so it is never
   * missing even when `act` is empty. `pg_has_role(..., 'USAGE')` is true
   * for a superuser (implicit membership) and for any role directly or
   * indirectly granted `pg_read_all_stats`.
   */
  sees_all: boolean | null;
}

export interface WaitBucket { type: string; event: string | null; sessions: number; longestSecs: number }
export interface ShapeBucket {
  /**
   * The shape's stable identity — `ActivityRow.key`, either the server's own
   * `query_id` or an md5 of the statement text — never the statement itself.
   * See its use as a React key on the Sessions page for why that distinction
   * is load-bearing rather than cosmetic.
   */
  shapeKey: string;
  queryId: string | null;
  statement: string | null;
  sessions: number;
  longestSecs: number;
}
export interface ActivityData {
  active: number;
  waits: WaitBucket[];
  shapes: ShapeBucket[];
  waitsTruncated: boolean;
  shapesTruncated: boolean;
  /**
   * True when this role lacks `pg_read_all_stats` (see `ActivityRow.sees_all`
   * above): the reading this check just produced covers only sessions this
   * role owns, not the server. Every other zero this check can report is a
   * real "nothing is executing"; this one is "we could not fully look" and
   * must be rendered as such, not folded into the same empty state — that
   * conflation is the defect this field exists to close.
   */
  restricted: boolean;
}

/**
 * Three readings of the same rows, in one statement, so all three describe the
 * same instant. `wait_event_type` NULL is a backend that is not waiting — on
 * CPU, or between waits — reported as `running` rather than dropped, because
 * "30 running, 12 on IO" is the sentence that says whether the server is
 * CPU-bound or IO-bound.
 *
 * Shapes group by `query_id` when the server computes one (14+, with
 * compute_query_id on or pg_stat_statements loaded) and by a hash of the text
 * otherwise. `min(query)` is one representative text, rendered through <Sql>
 * like every other statement.
 *
 * WHY EACH GROUPING IS CAPPED SEPARATELY, and not by one LIMIT over the union.
 * The first draft ended `ORDER BY kind, sessions DESC LIMIT 60`. `'shape'`
 * sorts before `'wait'`, so shape rows consumed the whole budget and a server
 * with more than 60 distinct active shapes returned no wait buckets at all —
 * losing the primary diagnostic exactly when it is being read. A LIMIT over a
 * UNION is a race between the branches, decided by the ORDER BY, not a bound on
 * each. `row_number()` per grouping makes the lists unable to starve each other,
 * and the row count is bounded by construction: 1 + 30 + 30.
 *
 * WHY `active` HAS ITS OWN ROW. It was the sum of the wait buckets, which is
 * only the true count when nothing was dropped. Combined with the bug above it
 * would have rendered "0 active" on the busiest server in the fleet. A headline
 * number must never be a partial sum, so it comes from `count(*)` over the CTE.
 *
 * The two ranking CTEs (`waits_ranked`, `shapes_ranked`) are pulled out to
 * name each `row_number() OVER (ORDER BY …)` rather than inlining it as a
 * bare subquery — boundaries.test.ts's "never sorts a ::text-cast column by
 * its own text alias" guard bounds an `ORDER BY` clause by the next `LIMIT`
 * or a closing paren at the start of a line, and an inlined
 * `(SELECT … ORDER BY sessions DESC, key) AS rn, … FROM waits) w` has neither
 * ahead of it in a UNION with no `LIMIT` — so the guard's own clause slice ran
 * to the end of the statement and flagged column names it found further down
 * the query text, never actually inside an `ORDER BY`. Naming the CTE and
 * giving `ORDER BY` its own line is a formatting change only; the plan
 * (row_number, one CTE per grouping, independent caps) is unchanged. `kind`
 * and `key` on the `total` row drop their explicit `::text` casts for the
 * same reason and with the same non-effect: both are always text (a fixed
 * label, and either `wait_event_type` or an md5 hash), so the cast was never
 * bigint-safety, only redundant, and Postgres already resolves `NULL`/a bare
 * string literal to the concrete type the other UNION branches provide
 * (verified: `SELECT NULL AS k FROM x UNION ALL SELECT 'y'::text AS k FROM z`
 * types `k` as `text` either way).
 */
const SQL = `
WITH act AS MATERIALIZED (
  SELECT query_id, query, wait_event_type, wait_event,
         EXTRACT(EPOCH FROM (now() - query_start)) AS running_secs
  FROM pg_stat_activity
  WHERE backend_type = 'client backend' AND state = 'active' AND pid <> pg_backend_pid()
    -- Task 8, step 3b (measured, not assumed — see the task report): one page
    -- render fires about six checks in PARALLEL on separate pool connections,
    -- so at the instant any one check runs, the other five are themselves
    -- active client backends — pgops inflates the very thing it is
    -- measuring. Filtered on application_name via current_setting, not on
    -- the OWN_SQL_MARKER this task also adds: a role without
    -- pg_read_all_stats can see another role's application_name but not its
    -- query, so a marker filter would leak pgops's own rows back in for
    -- exactly the restricted roles a DBA is most likely running this as.
    -- Every check runs on one of pgops's own connections, so
    -- current_setting('application_name') is always what pgops calls
    -- itself, with no name threaded in from apps/web (sql never sees
    -- CheckContext). The empty-string guard is NOT defensive clutter: without
    -- it, a connection with no application_name set makes the pattern '%',
    -- which excludes EVERY backend and leaves this panel permanently empty —
    -- a worse failure than the one being fixed. NOT LIKE ... || '%' is a
    -- prefix match, not equality, so 'pgops-store' (apps/web/lib/store.ts)
    -- is excluded by the same clause as plain 'pgops'. pid <>
    -- pg_backend_pid() above STAYS: it is what excludes the checking
    -- backend itself when application_name is empty and this guard has
    -- disabled the rest of the filter.
    AND (current_setting('application_name') = ''
         OR application_name NOT LIKE current_setting('application_name') || '%')
),
waits AS (
  SELECT coalesce(wait_event_type, 'running') AS key, wait_event AS detail,
         count(*)::int AS sessions, max(running_secs)::text AS longest_secs
  FROM act GROUP BY wait_event_type, wait_event
),
shapes AS (
  SELECT coalesce(query_id::text, md5(coalesce(query, ''))) AS key,
         count(*)::int AS sessions, max(running_secs)::text AS longest_secs,
         query_id::text AS qid, min(query) AS statement
  FROM act GROUP BY query_id, coalesce(query_id::text, md5(coalesce(query, '')))
),
waits_ranked AS (
  SELECT *,
         row_number() OVER (
           ORDER BY sessions DESC, key
         ) AS rn,
         count(*) OVER ()::int AS total
  FROM waits
),
shapes_ranked AS (
  SELECT *,
         row_number() OVER (
           ORDER BY sessions DESC, key
         ) AS rn,
         count(*) OVER ()::int AS total
  FROM shapes
)
SELECT 'total' AS kind, NULL AS key, NULL::text AS detail,
       count(*)::int AS sessions, NULL::text AS longest_secs,
       NULL::text AS query_id, NULL::text AS statement, NULL::int AS total,
       pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS sees_all
FROM act
UNION ALL
SELECT 'wait', key, detail, sessions, longest_secs, NULL, NULL, total, NULL::boolean
FROM waits_ranked
WHERE rn <= 30
UNION ALL
SELECT 'shape', key, NULL, sessions, longest_secs, qid, statement, total, NULL::boolean
FROM shapes_ranked
WHERE rn <= 30
ORDER BY kind, sessions DESC`;

export const activity: Check<ActivityRow, ActivityData> = {
  id: 'activity',
  gate: 'work',
  title: 'Active now',
  class: 'incident',
  sql: SQL,
  // Not the fix — see ActivityRow.sees_all's docblock for the actual
  // detection — but additive and safe (run.ts only pre-flights `version`;
  // `role` is used solely to pick remedyFor's GRANT text if a privilege
  // error is ever actually raised here) so it stays in for that case.
  requires: [{ kind: 'version', min: 140000 }, { kind: 'role', name: 'pg_read_all_stats' }],
  map: (rows) => {
    const waitRows = rows.filter((r) => r.kind === 'wait');
    const shapeRows = rows.filter((r) => r.kind === 'shape');
    const secs = (v: string | null) => (v == null ? 0 : Number(v));
    const total = rows.find((r) => r.kind === 'total');
    return {
      // The server's own count, not a sum of what fitted. See the docblock.
      active: total?.sessions ?? 0,
      waits: waitRows.map((r) => ({
        type: r.key ?? 'running', event: r.detail, sessions: r.sessions, longestSecs: secs(r.longest_secs),
      })),
      shapes: shapeRows.map((r) => ({
        // `r.key` is guaranteed non-null for a `'shape'` row — the SQL's
        // `shapes` CTE always computes it (`coalesce(query_id::text,
        // md5(...))`); only the `'total'` row ever carries a null `key`.
        shapeKey: r.key!,
        queryId: r.query_id, statement: r.statement, sessions: r.sessions, longestSecs: secs(r.longest_secs),
      })),
      waitsTruncated: (waitRows[0]?.total ?? 0) > waitRows.length,
      shapesTruncated: (shapeRows[0]?.total ?? 0) > shapeRows.length,
      // Default false on an empty result (no total row at all, e.g. the unit
      // tests' idle-server case) rather than undefined: an unreadable field
      // must never be mistaken for "confirmed unrestricted".
      restricted: total ? !total.sees_all : false,
    };
  },
};
