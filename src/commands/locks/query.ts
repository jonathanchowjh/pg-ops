import { query } from '../../core/connection.js';

/**
 * Incident lock-chain query (plan §A1).
 *
 * Walks the wait graph: every blocked PID joined to whoever is blocking it. The
 * join is pushed entirely to the DB — we never `SELECT * FROM pg_locks` into the
 * client, because pg_locks can be huge on a busy system.
 *
 * `IS NOT DISTINCT FROM` handles the NULLs in pg_locks columns (relation,
 * transactionid, etc.) so the self-join matches correctly.
 */
const LOCK_CHAIN_SQL = `
WITH lock_chain AS (
  SELECT
    blocked.pid                   AS blocked_pid,
    blocking.pid                  AS blocking_pid,
    blocked_act.usename           AS blocked_user,
    blocking_act.usename          AS blocking_user,
    blocked_act.application_name  AS blocked_app,
    blocking_act.application_name AS blocking_app,
    blocked.locktype,
    blocked.mode                  AS waiting_mode,
    blocking.mode                 AS held_mode,
    blocked.relation::regclass    AS table_name,
    blocking_act.query            AS blocking_query,
    blocked_act.query             AS blocked_query,
    blocked_act.state             AS blocked_state,
    blocking_act.state            AS blocking_state,
    EXTRACT(EPOCH FROM (now() - blocked_act.xact_start))  AS blocked_for_secs,
    EXTRACT(EPOCH FROM (now() - blocking_act.xact_start)) AS blocking_for_secs
  FROM pg_locks blocked
  JOIN pg_stat_activity blocked_act ON blocked.pid = blocked_act.pid
  JOIN pg_locks blocking
    ON blocked.locktype       IS NOT DISTINCT FROM blocking.locktype
   AND blocked.database       IS NOT DISTINCT FROM blocking.database
   AND blocked.relation       IS NOT DISTINCT FROM blocking.relation
   AND blocked.transactionid  IS NOT DISTINCT FROM blocking.transactionid
   AND blocked.pid != blocking.pid
  JOIN pg_stat_activity blocking_act ON blocking.pid = blocking_act.pid
  WHERE NOT blocked.granted AND blocking.granted
)
-- Deterministic order so a blocker holding multiple lock modes always renders
-- the same representative edge (buildChains takes the first edge per root).
SELECT * FROM lock_chain ORDER BY blocking_pid, blocked_pid, held_mode;
`;

/** One edge of the wait graph: `blocked_pid` is waiting on `blocking_pid`. */
export interface LockEdge {
  blocked_pid: number;
  blocking_pid: number;
  blocked_user: string | null;
  blocking_user: string | null;
  blocked_app: string | null;
  blocking_app: string | null;
  locktype: string | null;
  waiting_mode: string | null;
  held_mode: string | null;
  table_name: string | null;
  blocking_query: string | null;
  blocked_query: string | null;
  blocked_state: string | null;
  blocking_state: string | null;
  blocked_for_secs: number | null;
  blocking_for_secs: number | null;
}

export async function fetchLockEdges(): Promise<LockEdge[]> {
  // pg returns EXTRACT(EPOCH ...) as a numeric string; coerce to number here.
  const rows = await query<Record<string, unknown>>(LOCK_CHAIN_SQL);
  return rows.map((r) => ({
    blocked_pid: Number(r.blocked_pid),
    blocking_pid: Number(r.blocking_pid),
    blocked_user: (r.blocked_user as string) ?? null,
    blocking_user: (r.blocking_user as string) ?? null,
    blocked_app: (r.blocked_app as string) ?? null,
    blocking_app: (r.blocking_app as string) ?? null,
    locktype: (r.locktype as string) ?? null,
    waiting_mode: (r.waiting_mode as string) ?? null,
    held_mode: (r.held_mode as string) ?? null,
    table_name: (r.table_name as string) ?? null,
    blocking_query: (r.blocking_query as string) ?? null,
    blocked_query: (r.blocked_query as string) ?? null,
    blocked_state: (r.blocked_state as string) ?? null,
    blocking_state: (r.blocking_state as string) ?? null,
    blocked_for_secs: r.blocked_for_secs == null ? null : Number(r.blocked_for_secs),
    blocking_for_secs: r.blocking_for_secs == null ? null : Number(r.blocking_for_secs),
  }));
}
