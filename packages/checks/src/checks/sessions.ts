import type { Check, Threshold } from '../types.js';
import { ownSession, unreadableClient, visibleSchemas } from './shared.js';

export type SessionClass = 'cpu' | 'io' | 'idle' | 'other' | 'lock';

/** Stacking order, bottom up. The band, every strip and the palette test read it. */
export const CLASSES: readonly SessionClass[] = ['cpu', 'io', 'idle', 'other', 'lock'];

/**
 * What a session is doing, or null when it is doing nothing or cannot be
 * seen. Idle in transaction is a state, not a wait: it is its own class
 * whatever the session waits on. CPU is active and not waiting.
 */
export function classOf(state: string | null, waitEventType: string | null): SessionClass | null {
  if (isIdleInTransaction(state)) return 'idle';
  if (state !== 'active' && state !== 'fastpath function call') return null;
  if (waitEventType === null) return 'cpu';
  if (waitEventType === 'IO') return 'io';
  if (waitEventType === 'Lock') return 'lock';
  return 'other';
}

export interface SessionOpts {
  limit?: number;
  /** An exact pid to look up, applied in SQL ahead of the LIMIT. */
  pid?: number;
}

/** The one definition of idle-in-transaction in this package. */
export function isIdleInTransaction(state: string | null | undefined): boolean {
  return state === 'idle in transaction' || state === 'idle in transaction (aborted)';
}

export interface Session {
  pid: number;
  /** As Postgres printed it. With `pid` it is the session. */
  backendStart: string | null;
  user: string | null;
  app: string | null;
  clientAddr: string | null;
  state: string | null;
  /** Null: idle, or not visible to this role. */
  cls: SessionClass | null;
  /** One of pgops's own connections. */
  own: boolean;
  queryId: string | null;
  query: string | null;
  inStateSecs: number | null;
  /** Age of the current query, or of the last one if idle. Not time waiting. */
  queryAgeSecs: number | null;
  /**
   * How long the current transaction has been open; null outside one. For
   * an idle-in-transaction session this is the number that matters:
   * `queryAgeSecs` there is time since its last query ended.
   */
  xactAgeSecs: number | null;
  /** The pids it waits behind. Empty when it waits on nothing. */
  blockedBy: number[];
  /** Tables it holds or wants a lock on, strongest first. */
  relations: string[];
  /** The table whose lock it is waiting for. */
  wanted: string | null;
  /** How long it has waited for that lock. */
  waitSecs: number | null;
}

export interface SessionsData {
  sessions: Session[];
  /** True when the LIMIT dropped rows. */
  truncated: boolean;
  /**
   * Rows this role cannot read. Not a count of sessions: background
   * processes are nulled the same way. Zero or not is all it says.
   */
  hidden: number;
}

export interface SessionRow {
  /** Null on the carrier row: the one row an empty database still returns, for `hidden`. */
  pid: number | null;
  state: string | null;
  usename: string | null;
  app: string | null;
  client_addr: string | null;
  backend_start: string | null;
  wait_event_type: string | null;
  query_id: string | null;
  query: string | null;
  own: boolean | null;
  in_state_secs: string | null;
  query_age_secs: string | null;
  xact_age_secs: string | null;
  blocked_by: number[] | null;
  relations: string[];
  wanted: string | null;
  wait_secs: string | null;
  hidden: number;
  /** `count(a.pid) OVER ()`: sessions matched before LIMIT. Zero on the carrier row. */
  total_matching: number;
}

const DEFAULT_LIMIT = 500;

/**
 * Every client session of this database, with the tables it holds or wants
 * a lock on and the pids it waits behind.
 *
 * `datname = current_database()` and `pg_locks.database`: pg_stat_activity
 * and the lock manager are cluster-wide, and a relation's name resolves
 * only from inside its own database.
 *
 * `held` is one row per session and table, with the strongest mode on it;
 * `placed` orders a session's tables strongest first. A lock the session is
 * still waiting for counts: a DDL statement queued on a table belongs under
 * that table although it holds nothing there yet.
 *
 * `hidden` LEFT JOINs the sessions so an empty database still returns one
 * row. It counts the clients of this database a role without
 * pg_read_all_stats cannot read: their database is visible, their state and
 * query are not, so they are counted and never listed.
 *
 * `pg_blocking_pids` is asked only of a session waiting on a lock: each call
 * takes the lock manager's partition locks, and asking it of two thousand
 * idle connections on every poll is load on the thing an incident is about.
 *
 * `own` marks pgops's connections by the names its pools set.
 */
const SQL = (o: SessionOpts) => ({
  text: `
    WITH me AS (
      SELECT oid AS dbid FROM pg_database WHERE datname = current_database()
    ),
    act AS MATERIALIZED (
      SELECT a.pid, a.backend_start, a.usename, a.application_name AS app,
             a.client_addr, a.state, a.wait_event_type, a.query_id, a.query,
             a.state_change, a.query_start, a.xact_start,
             CASE WHEN a.wait_event_type = 'Lock' THEN pg_blocking_pids(a.pid)
                  ELSE '{}'::int[] END AS blocked_by,
             ${ownSession('a.application_name')} AS own
        FROM pg_stat_activity a
       WHERE a.backend_type = 'client backend'
         AND a.datname = current_database()
         AND a.pid <> pg_backend_pid()
         AND ($2::int IS NULL OR a.pid = $2)
    ),
    held AS (
      SELECT l.pid, n.nspname || '.' || c.relname AS relation,
             bool_or(NOT l.granted) AS wanted,
             max(CASE l.mode
                   WHEN 'AccessShareLock' THEN 1 WHEN 'RowShareLock' THEN 2
                   WHEN 'RowExclusiveLock' THEN 3 WHEN 'ShareUpdateExclusiveLock' THEN 4
                   WHEN 'ShareLock' THEN 5 WHEN 'ShareRowExclusiveLock' THEN 6
                   WHEN 'ExclusiveLock' THEN 7 ELSE 8 END) AS strength
        FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE l.locktype = 'relation'
         AND l.database = (SELECT dbid FROM me)
         AND c.relkind IN ('r', 'p', 'm')
         AND ${visibleSchemas('n.nspname')}
       GROUP BY l.pid, n.nspname, c.relname
    ),
    placed AS (
      SELECT h.pid,
             array_agg(h.relation ORDER BY h.strength DESC, h.relation
             ) AS relations,
             min(h.relation) FILTER (WHERE h.wanted) AS wanted
        FROM held h
       GROUP BY h.pid
    ),
    hidden AS (
      SELECT count(*)::int AS hidden
        FROM pg_stat_activity
       WHERE ${unreadableClient()} AND datname = current_database()
    )
    SELECT a.pid, a.backend_start::text AS backend_start, a.usename, a.app,
           a.client_addr::text AS client_addr, a.state, a.wait_event_type,
           a.query_id::text AS query_id, a.query, a.own,
           EXTRACT(EPOCH FROM (now() - a.state_change))::text AS in_state_secs,
           EXTRACT(EPOCH FROM (now() - a.query_start))::text  AS query_age_secs,
           EXTRACT(EPOCH FROM (now() - a.xact_start))::text   AS xact_age_secs,
           a.blocked_by,
           COALESCE(p.relations, '{}') AS relations,
           p.wanted,
           (SELECT EXTRACT(EPOCH FROM (now() - COALESCE(min(l.waitstart), now())))::text
              FROM pg_locks l
             WHERE l.pid = a.pid AND NOT l.granted
            HAVING count(*) > 0) AS wait_secs,
           h.hidden,
           count(a.pid) OVER ()::int AS total_matching
      FROM hidden h
      LEFT JOIN act a ON true
      LEFT JOIN placed p ON p.pid = a.pid
     ORDER BY
       CASE WHEN a.state LIKE 'idle in transaction%' THEN 0
            WHEN a.state = 'active' THEN 1
            ELSE 2 END,
       CASE WHEN a.state = 'active' THEN a.query_start ELSE a.state_change END ASC NULLS LAST,
       a.pid
     LIMIT $1`,
  values: [o.limit ?? DEFAULT_LIMIT, o.pid ?? null],
});

const num = (s: string | null): number | null => (s == null ? null : Number(s));

export const sessions: Check<SessionRow, SessionsData, SessionOpts> = {
  id: 'sessions',
  home: 'session',
  title: 'Sessions',
  class: 'live',
  /** Under the 5-second poll: a read that cannot answer in time says so, rather than stalling the page and the sampler. */
  timeoutMs: 4_000,
  /** `pg_locks.waitstart` and `pg_stat_activity.query_id` both arrived in 14. */
  requires: [{ kind: 'version', min: 140000 }],
  sql: SQL,
  map: (rows) => {
    const real = rows.filter((r) => r.pid !== null);
    return {
      sessions: real.map((r) => ({
        pid: r.pid!,
        backendStart: r.backend_start,
        user: r.usename,
        app: r.app,
        clientAddr: r.client_addr,
        state: r.state,
        cls: classOf(r.state, r.wait_event_type),
        own: r.own === true,
        queryId: r.query_id,
        query: r.query,
        inStateSecs: num(r.in_state_secs),
        queryAgeSecs: num(r.query_age_secs),
        xactAgeSecs: num(r.xact_age_secs),
        blockedBy: r.blocked_by ?? [],
        relations: r.relations,
        wanted: r.wanted,
        waitSecs: num(r.wait_secs),
      })),
      truncated: (rows[0]?.total_matching ?? 0) > real.length,
      hidden: rows[0]?.hidden ?? 0,
    };
  },
};

/** The lock chain's two marks, moved here with the rows they judge. Wording from locks.ts. */
export const CHAIN_THRESHOLDS: Threshold[] = [
  { level: 'warn', value: 1, unit: 'count',
    because: 'any session waiting on a lock is a query not completing; it is worth '
           + 'seeing even when brief' },
  { level: 'critical', value: 60, unit: 'seconds',
    because: 'a minute of blocking outlives most application timeouts, so the waiters '
           + 'are already being retried and the pile-up is compounding',
    remedy: 'Terminate the root blocker, not a waiter.' },
];

/** Idle in transaction: the two marks the tree's finding is judged by. */
export const IDLE_THRESHOLDS: Threshold[] = [
  { level: 'warn', value: 60, unit: 'seconds',
    because: 'a transaction idle for a minute is holding row locks and pinning the '
           + 'xmin horizon for no reason; almost always an application bug' },
  { level: 'critical', value: 300, unit: 'seconds',
    because: 'five minutes of idle-in-transaction blocks autovacuum from reclaiming '
           + 'anything newer, so bloat starts accumulating on top of the locking' },
];
