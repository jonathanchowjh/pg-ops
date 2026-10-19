import type { Check } from '../types.js';
import { ownSession } from './shared.js';

export interface ActivityRow {
  kind: 'total' | 'wait' | 'shape';
  key: string | null;
  detail: string | null;
  sessions: number;
  longest_secs: string | null;
  query_id: string | null;
  statement: string | null;
  /** Buckets this grouping had before its cap; null on the total row. */
  total: number | null;
  /**
   * Whether this role has `pg_read_all_stats`. Without it, another role's
   * backend has NULL `state`, so `state = 'active'` excludes it and a
   * saturated server reads the same as an idle one (horizon.int.test.ts).
   * Set only on the `'total'` row, which exists even when `act` is empty.
   */
  sees_all: boolean | null;
}

export interface WaitBucket { type: string; event: string | null; sessions: number; longestSecs: number }
export interface ShapeBucket {
  /**
   * The shape's stable identity: the server's `query_id`, or an md5 of the
   * statement text. Never the statement itself; the Sessions page uses it as
   * a React key.
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
   * True when this role lacks `pg_read_all_stats`: the reading covers only
   * sessions this role owns, not the server. A zero here means "could not
   * fully look" and must not render as the ordinary empty state.
   */
  restricted: boolean;
}

/**
 * Three readings of the same rows in one statement, so all three describe the
 * same instant. A NULL `wait_event_type` is a backend that is not waiting; it
 * is reported as `running` rather than dropped.
 *
 * Shapes group by `query_id` when the server computes one (14+, with
 * compute_query_id on or pg_stat_statements loaded) and by a hash of the text
 * otherwise. `min(query)` is one representative text.
 *
 * Each grouping is capped by its own `row_number()`, not by one LIMIT over
 * the union: `'shape'` sorts before `'wait'`, so a shared LIMIT lets shapes
 * starve the wait buckets. Rows are bounded at 1 + 30 + 30.
 *
 * `active` comes from `count(*)` over the CTE, not from summing the wait
 * buckets, which is only the true count when nothing was capped.
 *
 * The ranking CTEs keep each `ORDER BY` on its own line inside `OVER ( … )`
 * so the boundaries.test.ts guard on sorting by a `::text` alias can find
 * where the clause ends.
 */
const SQL = `
WITH act AS MATERIALIZED (
  SELECT query_id, query, wait_event_type, wait_event,
         EXTRACT(EPOCH FROM (now() - query_start)) AS running_secs
  FROM pg_stat_activity
  WHERE backend_type = 'client backend' AND state = 'active' AND pid <> pg_backend_pid()
    -- pgops's own backends are excluded: one page render runs about six checks
    -- in parallel, each an active client backend. Matched on application_name,
    -- not the SQL marker, because a role without pg_read_all_stats cannot read
    -- another role's query.
    AND NOT ${ownSession('application_name')}
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
  home: 'session',
  title: 'Active now',
  class: 'live',
  sql: SQL,
  // `role` is not pre-flighted (run.ts only pre-flights `version`); it picks
  // the GRANT remedy text if a privilege error is raised. `sees_all` is what
  // detects the missing role.
  requires: [{ kind: 'version', min: 140000 }, { kind: 'role', name: 'pg_read_all_stats' }],
  map: (rows) => {
    const waitRows = rows.filter((r) => r.kind === 'wait');
    const shapeRows = rows.filter((r) => r.kind === 'shape');
    const secs = (v: string | null) => (v == null ? 0 : Number(v));
    const total = rows.find((r) => r.kind === 'total');
    return {
      active: total?.sessions ?? 0,
      waits: waitRows.map((r) => ({
        type: r.key ?? 'running', event: r.detail, sessions: r.sessions, longestSecs: secs(r.longest_secs),
      })),
      shapes: shapeRows.map((r) => ({
        // Only the `'total'` row has a null `key`.
        shapeKey: r.key!,
        queryId: r.query_id, statement: r.statement, sessions: r.sessions, longestSecs: secs(r.longest_secs),
      })),
      waitsTruncated: (waitRows[0]?.total ?? 0) > waitRows.length,
      shapesTruncated: (shapeRows[0]?.total ?? 0) > shapeRows.length,
      // False, not undefined, when there is no total row at all.
      restricted: total ? !total.sees_all : false,
    };
  },
};
