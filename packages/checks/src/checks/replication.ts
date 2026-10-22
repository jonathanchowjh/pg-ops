import type { Check } from '../types.js';

export interface ReplicationRow {
  in_recovery: boolean;
  /**
   * Cast to `double precision`, which node-pg parses to a JS number;
   * `EXTRACT(EPOCH ...)` alone is `numeric` and would arrive as a string.
   */
  lag_seconds: number | null;
  standbys: number;
  /** Whether a walreceiver process exists; NULL on a primary. */
  receiving: boolean | null;
}

export interface ReplicationData {
  /** `null` is "we could not look", never "no". */
  inRecovery: boolean | null;
  /**
   * Seconds behind the primary. `null` on a primary, and on a standby that
   * has not yet replayed anything. Never `null` for "caught up": that is 0.
   * pgHero answers 0 for a primary; this does not.
   */
  lagSeconds: number | null;
  /**
   * Walsenders currently streaming from this server, per `pg_stat_replication`.
   *
   * Not verified against Postgres source for the exact row-visibility rule a
   * role lacking `pg_read_all_stats` gets on this view. A low count may
   * therefore reflect restricted visibility rather than a genuine absence of
   * standbys.
   */
  standbys: number | null;
  /**
   * Whether a walreceiver is running. `null` on a primary, and when the row
   * could not be read.
   *
   * `lagSeconds` is 0 when this standby has replayed everything it received,
   * which is also what a dead walreceiver looks like. This field tells the
   * two apart. It has no threshold.
   */
  receiving: boolean | null;
}

/**
 * Caught up means `pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()`:
 * comparing against the primary's current LSN would need a connection to
 * the primary. Both functions return NULL on a primary and do not raise,
 * unlike `pg_current_wal_lsn()` on a standby.
 */
const SQL = `
SELECT pg_is_in_recovery() AS in_recovery,
       (SELECT count(*)::int FROM pg_stat_replication) AS standbys,
       CASE WHEN pg_is_in_recovery()
            THEN (SELECT count(*) > 0 FROM pg_stat_wal_receiver)
            ELSE NULL
       END AS receiving,
       CASE
         WHEN NOT pg_is_in_recovery() THEN NULL
         WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
         ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())
       END::double precision AS lag_seconds`;

export const replicationLag: Check<ReplicationRow, ReplicationData> = {
  id: 'replicationLag',
  home: 'server',
  class: 'live',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    // `??`, never `||`: `false` and `0` are findings and must not become
    // `null`.
    return {
      inRecovery: r?.in_recovery ?? null,
      lagSeconds: r?.lag_seconds ?? null,
      standbys: r?.standbys ?? null,
      receiving: r?.receiving ?? null,
    };
  },
};
