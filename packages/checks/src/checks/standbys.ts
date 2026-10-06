import type { Check, Verdict } from '../types.js';

export interface StandbyRow {
  app: string;
  client_addr: string | null;
  state: string | null;
  sync_state: string | null;
  /**
   * The four lag columns and both byte columns arrive as text.
   *
   * `EXTRACT(EPOCH FROM interval)` is `numeric`, which node-pg hands back as
   * a string to preserve precision, and `pg_wal_lsn_diff` is `numeric` for
   * the same reason. Typed as what actually arrives, per this package's
   * convention; converted once in `map`.
   *
   * NULL is the case this check exists to render honestly: a role without
   * `pg_monitor` reads another user's walsender lag as NULL, and so does a
   * standby that has not reported a given stage yet.
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
 * `pg_stat_replication`, one row per walsender, as the PRIMARY sees its
 * standbys.
 *
 * This is not `replicationLag` under another name. That check answers the
 * standby's own question — "how far behind am I" — and can only be asked on
 * the standby. This answers the primary's: which of my standbys is behind,
 * and WHERE in the pipeline. The four stages are the diagnosis: sent, then
 * written, then flushed, then replayed. Replay lag climbing while flush lag
 * sits near zero is the standby struggling to apply what it already has;
 * both climbing together is the link between them.
 *
 * The three lag columns are NULL for another user's walsender unless the
 * role holds `pg_monitor`, which is why that is declared below and why null
 * renders as unknown rather than as caught up.
 *
 * On a standby this view is empty (cascading aside) and `pg_current_wal_lsn()`
 * RAISES "recovery is in progress" rather than returning null — the mirror
 * of the hazard slots.ts documents — so the reference LSN branches on
 * `pg_is_in_recovery()`. A cascading standby runs this check too.
 *
 * `ORDER BY` the replay distance in bytes, worst first, so a cap added later
 * keeps the standby that matters. `NULLS LAST` keeps a standby whose
 * position cannot be read from displacing one whose can.
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
  gate: 'keep-up',
  title: 'Standbys',
  class: 'incident',
  sql: SQL,
  /**
   * Without `pg_monitor` the lag columns read NULL for a walsender this role
   * does not own, which is indistinguishable from a standby with nothing to
   * report. Declared so `run.ts` prints the GRANT as the remedy rather than
   * a bare permission error.
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
  /**
   * `replicationLag` carries no threshold, because pgHero has none and that
   * check is pgHero's capability. This check is not that capability, and the
   * reasoning does not carry across: a standby five minutes behind is an
   * incident by any DBA's definition, and a console that will not say so on
   * the gate titled "can the server keep up" is not an on-call console.
   */
  thresholds: [
    { level: 'warn', value: 30, unit: 'seconds',
      because: 'reads routed to this standby are answering with data half a minute old, '
             + 'and a failover to it would lose that much',
      remedy: 'Work out which half is starved: replay lag climbing while flush lag stays near '
            + 'zero is the standby applying slowly, both climbing together is the link between '
            + 'them. Replay is single-threaded and waits on its own IO and on conflicting '
            + 'queries.' },
    { level: 'critical', value: 300, unit: 'seconds',
      because: 'five minutes behind is past most applications\' tolerance for stale reads, and '
             + 'means a failover now would lose five minutes of commits',
      remedy: 'Take the standby out of the read pool until it catches up. If replay is blocked '
            + 'by a long query on the standby, cancel that query or raise '
            + 'max_standby_streaming_delay knowingly.' },
  ],
  verdict: (d, t): Verdict => {
    // The WORST readable standby, named. A standby whose lag this role
    // cannot read is skipped rather than counted as caught up — and
    // skipping it must not suppress a readable one beside it, which is what
    // a `d.standbys[0]` reading would have done given the SQL's NULLS LAST.
    let worst: { app: string; secs: number } | null = null;
    for (const s of d.standbys) {
      if (s.replaySecs === null) continue;
      if (worst === null || s.replaySecs > worst.secs) worst = { app: s.app, secs: s.replaySecs };
    }
    if (worst === null) return { level: 'ok' };
    const note = `${worst.app} is ${Math.round(worst.secs)}s behind`;
    // Convention 3: a level's threshold is data this check may not have been
    // given, not a guarantee the type system can see.
    const crit = t.find((x) => x.level === 'critical');
    if (crit && worst.secs >= crit.value) return { level: 'critical', note };
    const warn = t.find((x) => x.level === 'warn');
    if (warn && worst.secs >= warn.value) return { level: 'warn', note };
    return { level: 'ok' };
  },
};
