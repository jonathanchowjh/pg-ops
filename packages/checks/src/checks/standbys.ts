import type { Check } from '../types.js';

export interface StandbyRow {
  app: string;
  client_addr: string | null;
  state: string | null;
  sync_state: string | null;
  /**
   * The lag and byte columns are `numeric` and arrive as text; `map`
   * converts them. NULL for another user's walsender when the role lacks
   * `pg_monitor`, and for a stage a standby has not reported yet.
   */
  write_secs: string | null;
  flush_secs: string | null;
  replay_secs: string | null;
  sent_bytes: string | null;
  replay_bytes: string | null;
}

export interface Standby {
  app: string;
  clientAddr: string | null;
  state: string | null;
  syncState: string | null;
  /** Null is "we could not read this stage", never "no lag". */
  writeSecs: number | null;
  flushSecs: number | null;
  replaySecs: number | null;
  sentBytes: number | null;
  replayBytes: number | null;
}

export interface StandbysData { standbys: Standby[] }

/**
 * `pg_stat_replication`, one row per walsender: the primary's view of which
 * standby is behind and at which stage (sent, written, flushed, replayed).
 * `replicationLag` is the standby's own view.
 *
 * `pg_current_wal_lsn()` raises "recovery is in progress" on a standby, and
 * a cascading standby runs this check too, so the reference LSN branches on
 * `pg_is_in_recovery()`.
 *
 * Worst replay distance first, unreadable positions last.
 */
const SQL = `
WITH head AS (
  SELECT CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn() ELSE pg_current_wal_lsn() END AS lsn
)
SELECT application_name AS app, client_addr::text AS client_addr, state, sync_state,
       EXTRACT(EPOCH FROM write_lag)::text  AS write_secs,
       EXTRACT(EPOCH FROM flush_lag)::text  AS flush_secs,
       EXTRACT(EPOCH FROM replay_lag)::text AS replay_secs,
       pg_wal_lsn_diff(head.lsn, sent_lsn)::text   AS sent_bytes,
       pg_wal_lsn_diff(head.lsn, replay_lsn)::text AS replay_bytes
FROM pg_stat_replication, head
ORDER BY pg_wal_lsn_diff(head.lsn, replay_lsn) DESC NULLS LAST`;

const num = (s: string | null) => (s == null ? null : Number(s));

export const standbys: Check<StandbyRow, StandbysData> = {
  id: 'standbys',
  home: 'server',
  class: 'live',
  sql: SQL,
  /**
   * Without `pg_monitor` the lag columns read NULL for a walsender this role
   * does not own. Declared so `run.ts` prints the GRANT as the remedy.
   */
  requires: [{ kind: 'role', name: 'pg_monitor' }],
  map: (rows) => ({
    standbys: rows.map((r) => ({
      app: r.app,
      clientAddr: r.client_addr,
      state: r.state,
      syncState: r.sync_state,
      writeSecs: num(r.write_secs),
      flushSecs: num(r.flush_secs),
      replaySecs: num(r.replay_secs),
      sentBytes: num(r.sent_bytes),
      replayBytes: num(r.replay_bytes),
    })),
  }),
  /** Unlike `replicationLag`, which follows pgHero and has no threshold. */
  thresholds: [
    { level: 'warn', value: 30,
      because: 'reads routed to this standby are answering with data half a minute old, '
             + 'and a failover to it would lose that much' },
    { level: 'critical', value: 300,
      because: 'five minutes behind is past most applications\' tolerance for stale reads, and '
             + 'means a failover now would lose five minutes of commits' },
  ],
};
