import type { Check } from '../types.js';

export interface ReplicationRow {
  in_recovery: boolean;
  /**
   * `EXTRACT(EPOCH FROM ...)` returns `numeric` (OID 1700), which node-pg
   * hands back as a STRING to preserve arbitrary precision — unlike the int4
   * columns in connections.ts. The query below casts it to
   * `double precision` (float8, OID 701), which node-pg does parse to a JS
   * number. Typed as what actually arrives, per this package's convention.
   */
  lag_seconds: number | null;
  standbys: number;
}

export interface ReplicationData {
  /** `null` is "we could not look", never "no". */
  inRecovery: boolean | null;
  /**
   * Seconds behind the primary, or `null`.
   *
   * `null` covers two cases that are both "not a meaningful question": this
   * server is a primary, or it is a standby that has not yet replayed
   * anything (`pg_last_xact_replay_timestamp()` is NULL until the first
   * replayed transaction). It is NEVER used for "caught up" — that is 0.
   *
   * pgHero answers 0 for a primary. On a dashboard that reads as "perfectly
   * caught up", which is a claim about replication health made about a server
   * that is not replicating.
   */
  lagSeconds: number | null;
  /**
   * Walsenders currently streaming from this server, per `pg_stat_replication`.
   *
   * Not verified against Postgres source for the exact row-visibility rule a
   * role lacking `pg_read_all_stats` gets on this view. A low count may
   * therefore reflect restricted visibility rather than a genuine absence of
   * standbys — do not read 0 as proof of "not replicating" without also
   * checking the connecting role's privileges.
   */
  standbys: number | null;
}

/**
 * `pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()` is pgHero's own
 * caught-up test and it is the right one: comparing replay position to the
 * PRIMARY's current LSN would require a connection to the primary, which this
 * check does not have. Both functions are safe on a primary — they return
 * NULL rather than raising, unlike `pg_current_wal_lsn()`, which raises
 * "recovery is in progress" on a standby (see slots.ts's A6 note for the
 * mirror image of this hazard).
 *
 * The whole CASE is guarded by `pg_is_in_recovery()` regardless, so the
 * standby-only functions are never the deciding branch on a primary.
 */
const SQL = `
SELECT pg_is_in_recovery() AS in_recovery,
       (SELECT count(*)::int FROM pg_stat_replication) AS standbys,
       CASE
         WHEN NOT pg_is_in_recovery() THEN NULL
         WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
         ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())
       END::double precision AS lag_seconds`;

export const replicationLag: Check<ReplicationRow, ReplicationData> = {
  id: 'replicationLag',
  gate: 'keep-up',
  title: 'Replication',
  class: 'incident',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    // `??` throughout, never `||`: `false` for in_recovery and `0` for both
    // lag_seconds and standbys are all FINDINGS, and `||` would launder every
    // one of them into "we could not look".
    return {
      inRecovery: r?.in_recovery ?? null,
      lagSeconds: r?.lag_seconds ?? null,
      standbys: r?.standbys ?? null,
    };
  },
};
