import type { Pool, PoolClient } from 'pg';
import { anyClient, unreadableClient } from './checks/shared.js';
import { guardClient, messageOf, ownSql } from './run.js';
import { HEALTH_LOCK_NS, withCaptureLock } from './store/lock.js';
import { RETENTION, healthIsFresh, insertHealth, type HealthRow } from './store/write.js';
import type { CheckContext, FailureReason } from './types.js';

/**
 * Per statement. Far longer than any of these should take and far shorter
 * than the next tick.
 */
export const HEALTH_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * The six statements, by the name a failure is reported under, in the order
 * they run. `size` is last: pg_database_size stats every relation file, so
 * it is the one that can time out, and placed last its timeout costs no
 * other part its reading.
 */
export const HEALTH_PARTS = ['database', 'activity', 'wait', 'replication', 'xmin', 'size'] as const;

const QUERY_CANCELED = '57014';

/**
 * This database's cumulative counters and its frozen-xid age, in one row.
 * `pg_stat_wal` is server-wide; it is read here as one more single-row read
 * any role may make.
 *
 * Counters are cast to text: they are 64-bit (wal_bytes is numeric) and a
 * JavaScript number cannot hold them exactly.
 */
const DATABASE_SQL = ownSql(`SELECT s.sessions::text            AS sessions,
       s.sessions_abandoned::text  AS sessions_abandoned,
       s.sessions_fatal::text      AS sessions_fatal,
       s.sessions_killed::text     AS sessions_killed,
       s.idle_in_transaction_time  AS idle_in_transaction_time,
       s.active_time               AS active_time,
       s.deadlocks::text           AS deadlocks,
       s.xact_commit::text         AS xact_commit,
       s.xact_rollback::text       AS xact_rollback,
       s.blks_hit::text            AS blks_hit,
       s.blks_read::text           AS blks_read,
       s.temp_bytes::text          AS temp_bytes,
       s.stats_reset               AS stats_reset,
       age(d.datfrozenxid)::text   AS xid_age,
       (SELECT wal_bytes::text FROM pg_stat_wal) AS wal_bytes
  FROM pg_stat_database s
  JOIN pg_database d ON d.oid = s.datid
 WHERE s.datname = current_database()`);

/**
 * Session counts, per database and server-wide, in one pass.
 *
 * A role without pg_read_all_stats sees another role's session with its
 * state and backend type nulled and its database kept, so the connections
 * are counted whole. What needs a state cannot be: `hidden` counts this
 * database's unreadable clients, and if there is even one, `healthRow`
 * stores active, idle in transaction and the longest query as null.
 *
 * The capturing backend is excluded from `active` and from the longest
 * query: it is always running this statement.
 */
const ACTIVITY_SQL = ownSql(`SELECT count(*) FILTER (WHERE client)::int AS server_connections,
       count(*) FILTER (WHERE client AND mine)::int AS connections,
       count(*) FILTER (WHERE unreadable AND mine)::int AS hidden,
       count(*) FILTER (WHERE client AND mine AND state = 'active' AND NOT self)::int AS active,
       count(*) FILTER (WHERE client AND mine AND state LIKE 'idle in transaction%')::int AS idle_in_txn,
       coalesce(max(EXTRACT(EPOCH FROM now() - query_start))
                  FILTER (WHERE client AND mine AND state = 'active' AND NOT self), 0)::double precision
         AS longest_query_secs,
       current_setting('max_connections')::int
         - current_setting('superuser_reserved_connections')::int
         - COALESCE(NULLIF(current_setting('reserved_connections', true), '')::int, 0) AS max_connections
  FROM (SELECT backend_type, state, query_start,
               ${anyClient()} AS client,
               ${unreadableClient()} AS unreadable,
               datname = current_database()    AS mine,
               pid = pg_backend_pid()          AS self
          FROM pg_stat_activity) a`);

/**
 * Sessions of this database waiting on a lock, and the longest wait.
 *
 * Filtered on datname, unlike the live `blocked` check: this is stored
 * against one database and must not include another database's lock chain.
 * pg_blocking_pids and pg_locks.waitstart are readable by any role.
 */
const WAIT_SQL = ownSql(`SELECT count(*)::int AS blocked,
       coalesce(max(EXTRACT(EPOCH FROM now() - w.waitstart)), 0)::double precision AS longest_wait_secs
  FROM (SELECT (SELECT min(l.waitstart) FROM pg_locks l
                 WHERE l.pid = a.pid AND NOT l.granted) AS waitstart
          FROM pg_stat_activity a
         WHERE a.datname = current_database()
           AND cardinality(pg_blocking_pids(a.pid)) > 0) w`);

/**
 * On a standby, its own replay lag. On a primary, the worst standby's.
 * Null on a primary with no standby, or whose standbys this role cannot
 * read.
 *
 * Postgres nulls `replay_lag` once a caught-up standby has been idle for a
 * moment, so a streaming standby that has replayed everything it was sent is
 * reported as zero. An unprivileged role sees the LSNs as null too, so this
 * cannot invent a zero for a standby it cannot read.
 */
const REPLICATION_SQL = ownSql(`SELECT CASE
         WHEN NOT pg_is_in_recovery()
           THEN (SELECT max(coalesce(EXTRACT(EPOCH FROM replay_lag),
                                     CASE WHEN state = 'streaming' AND sent_lsn = replay_lsn THEN 0 END))
                   FROM pg_stat_replication)
         WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
         ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())
       END::double precision AS replication_lag_secs`);

/** The age of the oldest thing pinning the xmin horizon: a backend, a slot or a prepared transaction. */
const XMIN_SQL = ownSql(`SELECT coalesce(max(a), 0)::text AS xmin_age
  FROM (SELECT age(backend_xmin) AS a FROM pg_stat_activity
         WHERE backend_xmin IS NOT NULL AND pid <> pg_backend_pid()
           AND (datid IS NULL OR datname = current_database())
        UNION ALL
        SELECT greatest(age(xmin), age(catalog_xmin)) FROM pg_replication_slots
         WHERE xmin IS NOT NULL OR catalog_xmin IS NOT NULL
        UNION ALL
        SELECT age(transaction) FROM pg_prepared_xacts) h`);

/** Its own statement and its own timeout: see HEALTH_PARTS. */
const SIZE_SQL = ownSql('SELECT pg_database_size(current_database())::text AS size_bytes');

interface DatabasePart {
  sessions: string | null; sessions_abandoned: string | null; sessions_fatal: string | null;
  sessions_killed: string | null; idle_in_transaction_time: number | null; active_time: number | null;
  deadlocks: string | null; xact_commit: string | null; xact_rollback: string | null;
  blks_hit: string | null; blks_read: string | null; temp_bytes: string | null;
  stats_reset: Date | null; xid_age: string | null; wal_bytes: string | null;
}
interface ActivityPart {
  server_connections: number; connections: number; hidden: number; active: number;
  idle_in_txn: number; longest_query_secs: number; max_connections: number;
}
interface WaitPart { blocked: number; longest_wait_secs: number }
interface ReplicationPart { replication_lag_secs: number | null }
interface XminPart { xmin_age: string }
interface SizePart { size_bytes: string | null }

/** What each statement returned, or null where it failed. */
export interface HealthParts {
  database: DatabasePart | null;
  activity: ActivityPart | null;
  wait: WaitPart | null;
  replication: ReplicationPart | null;
  xmin: XminPart | null;
  size: SizePart | null;
}

/**
 * Lay the parts out as one row. Pure, so the null rules have a unit test.
 *
 * A failed part leaves its own columns null and the rest of the row lands.
 */
export function healthRow(parts: HealthParts, ownStatements: number | null): HealthRow {
  const { database: d, activity: a, wait: w, replication: r, xmin: x, size: z } = parts;
  const seen = a !== null && a.hidden === 0 ? a : null;
  return {
    connections: a?.connections ?? null,
    server_connections: a?.server_connections ?? null,
    max_connections: a?.max_connections ?? null,
    sessions: d?.sessions ?? null,
    sessions_abandoned: d?.sessions_abandoned ?? null,
    sessions_fatal: d?.sessions_fatal ?? null,
    sessions_killed: d?.sessions_killed ?? null,
    blocked: w?.blocked ?? null,
    longest_wait_secs: w?.longest_wait_secs ?? null,
    idle_in_txn: seen?.idle_in_txn ?? null,
    idle_in_transaction_time: d?.idle_in_transaction_time ?? null,
    deadlocks: d?.deadlocks ?? null,
    active: seen?.active ?? null,
    active_time: d?.active_time ?? null,
    longest_query_secs: seen?.longest_query_secs ?? null,
    xact_commit: d?.xact_commit ?? null,
    xact_rollback: d?.xact_rollback ?? null,
    blks_hit: d?.blks_hit ?? null,
    blks_read: d?.blks_read ?? null,
    temp_bytes: d?.temp_bytes ?? null,
    own_statements: ownStatements,
    stats_reset: d?.stats_reset ?? null,
    replication_lag_secs: r?.replication_lag_secs ?? null,
    wal_bytes: d?.wal_bytes ?? null,
    xid_age: d?.xid_age ?? null,
    xmin_age: x?.xmin_age ?? null,
    size_bytes: z?.size_bytes ?? null,
  };
}

/**
 * Run the statements on one connection to the monitored database, not six
 * pool queries.
 *
 * Each statement runs in its own transaction under SET LOCAL. A session-level
 * SET through a transaction-mode pooler lands on a server connection the
 * application shares, and the application's statements then die at five
 * seconds.
 *
 * The first timeout ends the sampling, so a database that has stopped
 * answering costs one timeout rather than one per statement.
 */
export async function sampleHealth(
  target: Pool,
  ownStatements: number | null,
): Promise<{ row: HealthRow; missing: string[] }> {
  const client = await target.connect();
  const release = guardClient(client);
  const missing: string[] = [];
  let timedOut = false;
  const one = async <R>(part: string, sql: string): Promise<R | null> => {
    if (timedOut) {
      missing.push(part);
      return null;
    }
    try {
      await client.query(ownSql('BEGIN'));
      await client.query(ownSql(`SET LOCAL statement_timeout = ${HEALTH_STATEMENT_TIMEOUT_MS}`));
      const row = ((await client.query(sql)).rows[0] as R | undefined) ?? null;
      await client.query(ownSql('COMMIT'));
      return row;
    } catch (err) {
      // If the connection itself is gone this throws, and the outer catch
      // destroys the client rather than handing a broken one back.
      await client.query(ownSql('ROLLBACK'));
      if ((err as { code?: string })?.code === QUERY_CANCELED) timedOut = true;
      missing.push(part);
      return null;
    }
  };
  try {
    const parts: HealthParts = {
      database: await one<DatabasePart>('database', DATABASE_SQL),
      activity: await one<ActivityPart>('activity', ACTIVITY_SQL),
      wait: await one<WaitPart>('wait', WAIT_SQL),
      replication: await one<ReplicationPart>('replication', REPLICATION_SQL),
      xmin: await one<XminPart>('xmin', XMIN_SQL),
      size: await one<SizePart>('size', SIZE_SQL),
    };
    release();
    return { row: healthRow(parts, ownStatements), missing };
  } catch (err) {
    release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

export type HealthOutcome =
  | { ok: true; missing: string[] }
  | { ok: false; reason: FailureReason; message: string }
  | { ok: 'skipped'; reason: 'locked' | 'fresh' };

/**
 * Sample one database and store one row.
 *
 * Lock and freshness are checked before the monitored database is touched,
 * so a replica that loses the race costs that database nothing.
 *
 * A database that cannot be reached writes no row; the gap in the chart is
 * the record.
 *
 * `ownStatements` is the caller's count of what it sent this database since
 * its last row, or null when it does not know (the first tick after boot).
 */
export async function captureHealth(
  ctx: CheckContext,
  name: string,
  ownStatements: number | null = null,
): Promise<HealthOutcome> {
  const sampleAndStore = async (client: PoolClient, databaseId: number): Promise<HealthOutcome> => {
    if (await healthIsFresh(client, databaseId)) return { ok: 'skipped', reason: 'fresh' };

    let sample;
    try {
      sample = await sampleHealth(ctx.target, ownStatements);
    } catch (err) {
      return { ok: false, reason: 'unreachable', message: messageOf(err) };
    }
    if (sample.missing.length === HEALTH_PARTS.length) {
      return { ok: false, reason: 'error', message: 'every health statement failed' };
    }

    await client.query('BEGIN');
    try {
      await insertHealth(client, databaseId, sample.row, RETENTION.healthStatsDays);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    return { ok: true, missing: sample.missing };
  };
  return withCaptureLock(ctx, name, { recording: 'health', ns: HEALTH_LOCK_NS }, sampleAndStore);
}
