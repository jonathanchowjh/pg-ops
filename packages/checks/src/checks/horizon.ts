import type { Check } from '../types.js';
import { ownSession } from './shared.js';

export interface HorizonRow {
  kind: 'backend' | 'slot' | 'prepared';
  who: string;
  xmin_age: number;
  age_secs: string | null;
  detail: string;
  /** A backend's, as Postgres printed it, so Terminate can guard the pid. Null for a slot or a prepared transaction. */
  backend_start: string | null;
  /** A backend waiting on another's lock: a waiter, which ending frees nothing. */
  waiting: boolean;
  /** Holders that existed before the limit. */
  total: number;
}
export interface HorizonHolder {
  kind: 'backend' | 'slot' | 'prepared'; who: string; xminAge: number; ageSecs: number | null; detail: string; backendStart: string | null;
  waiting: boolean;
}
export interface HorizonData { holders: HorizonHolder[]; truncated: boolean }

/**
 * Vacuum cannot remove a row version some snapshot might still need. The
 * oldest such snapshot, the xmin horizon, is held by a backend with an open
 * transaction, a replication slot, or a prepared transaction. A backend holds
 * it with its snapshot or with its own transaction ID: a writer idle in
 * transaction has the second and may have no snapshot at all. This lists the
 * holders furthest-back first.
 *
 * Judged on transactions, not seconds: `age(xid)` decides how much garbage
 * cannot be reclaimed, and wall-clock age does not. A slot has no start
 * time, so seconds could not order one, and a logical slot with a stuck
 * `catalog_xmin` can keep its retained WAL near zero. Seconds are reported
 * for information only.
 */
const SQL = `
SELECT kind, who, xmin_age, age_secs, detail, backend_start, waiting, count(*) OVER ()::int AS total
FROM (
  SELECT 'backend'::text AS kind, pid::text AS who, greatest(age(backend_xmin), age(backend_xid))::int AS xmin_age,
         EXTRACT(EPOCH FROM (now() - xact_start))::text AS age_secs,
         coalesce(nullif(application_name, ''), '—') || ' · ' || coalesce(state, 'unknown') AS detail,
         backend_start::text AS backend_start,
         -- Asked only of a backend waiting on a lock, as in sessions.ts: each
         -- call takes the lock manager's partition locks.
         CASE WHEN wait_event_type = 'Lock' THEN cardinality(pg_blocking_pids(pid)) > 0 ELSE false END AS waiting
  FROM pg_stat_activity
  WHERE (backend_xmin IS NOT NULL OR backend_xid IS NOT NULL) AND pid <> pg_backend_pid()
    -- A backend in another database does not hold this one's tables back;
    -- one with no database, a walsender, does.
    AND (datid IS NULL OR datname = current_database())
    -- pgops's own backends are excluded: otherwise pgops names one of its own
    -- parallel checks as pinning the xmin horizon.
    AND NOT ${ownSession('application_name')}
  UNION ALL
  SELECT 'slot', slot_name::text, greatest(age(xmin), age(catalog_xmin))::int, NULL,
         CASE WHEN active THEN 'active' ELSE 'inactive' END, NULL, false
  FROM pg_replication_slots
  WHERE xmin IS NOT NULL OR catalog_xmin IS NOT NULL
  UNION ALL
  SELECT 'prepared', gid, age(transaction)::int,
         EXTRACT(EPOCH FROM (now() - prepared))::text, owner::text, NULL, false
  FROM pg_prepared_xacts
) h
-- On a tie the one holding it first: a chain's root before the waiters queued behind it.
ORDER BY xmin_age DESC NULLS LAST, waiting
LIMIT 10`;

export const horizon: Check<HorizonRow, HorizonData> = {
  id: 'horizon',
  home: 'server',
  class: 'live',
  sql: SQL,
  map: (rows) => ({
    holders: rows.map((r) => ({
      kind: r.kind, who: r.who, xminAge: r.xmin_age,
      ageSecs: r.age_secs == null ? null : Number(r.age_secs), detail: r.detail, backendStart: r.backend_start ?? null,
      waiting: r.waiting === true,
    })),
    truncated: (rows[0]?.total ?? 0) > rows.length,
  }),
};
