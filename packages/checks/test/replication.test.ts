import { describe, expect, it } from 'vitest';
import { replicationLag } from '../src/checks/replication.js';

describe('replicationLag', () => {
  // `receiving` is null on a primary: it has no walreceiver to report on.
  const primary = { in_recovery: false, lag_seconds: null, standbys: 2, receiving: null };

  it('reports a primary with standbys attached', () => {
    expect(replicationLag.map([primary])).toEqual({
      inRecovery: false, lagSeconds: null, standbys: 2, receiving: null,
    });
  });

  /**
   * THE divergence from pgHero, and the reason this file exists. pgHero
   * answers 0 for a primary, which reads on a dashboard as "perfectly caught
   * up" — a claim about replication health made about a server that is not
   * replicating at all. `null` is "not a meaningful question here"; `0` is
   * reserved for a standby that genuinely has no lag.
   */
  it('reports no lag figure at all on a primary, rather than zero', () => {
    expect(replicationLag.map([primary]).lagSeconds).toBeNull();
    expect(replicationLag.map([primary]).lagSeconds).not.toBe(0);
  });

  it('reports zero lag on a caught-up standby', () => {
    const caughtUp = { in_recovery: true, lag_seconds: 0, standbys: 0, receiving: true };
    expect(replicationLag.map([caughtUp]).lagSeconds).toBe(0);
  });

  it('reports a lagging standby in seconds', () => {
    const behind = { in_recovery: true, lag_seconds: 12.5, standbys: 0, receiving: true };
    expect(replicationLag.map([behind])).toEqual({
      inRecovery: true, lagSeconds: 12.5, standbys: 0, receiving: true,
    });
  });

  /**
   * `standbys: 0` is "nothing is streaming from me" — a finding. A missing
   * row is "we could not look". Written `?? null` these stay apart; written
   * `|| null` a real zero would launder itself into unknown.
   */
  it('keeps a genuine zero standby count distinct from unknown', () => {
    expect(replicationLag.map([{ ...primary, standbys: 0 }]).standbys).toBe(0);
    expect(replicationLag.map([]).standbys).toBeNull();
  });

  it('reports every field unknown when there is no row at all', () => {
    expect(replicationLag.map([])).toEqual({
      inRecovery: null, lagSeconds: null, standbys: null, receiving: null,
    });
  });

  it('never escalates — pgHero has no lag threshold and neither do we', () => {
    expect(replicationLag.verdict).toBeUndefined();
    expect(replicationLag.thresholds).toBeUndefined();
  });
});

/**
 * B4, standby side. `lag_seconds` is 0 when
 * `pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()` — "I have replayed
 * everything I received", which is pgHero's caught-up test and the right one
 * for a healthy standby.
 *
 * It is also exactly what a DEAD walreceiver looks like: nothing arriving,
 * nothing left to replay, so a standby that lost its connection to the
 * primary hours ago reads 0 seconds behind. Beside a standbys check that now
 * judges lag, that reading is the one remaining way for this gate to call a
 * broken standby perfect.
 */
describe('replicationLag — a standby that is not receiving', () => {
  it('reports whether a walreceiver is running, and only on a standby', () => {
    expect(replicationLag.map([{ in_recovery: true, lag_seconds: 0, standbys: 0, receiving: false }]).receiving)
      .toBe(false);
    expect(replicationLag.map([{ in_recovery: true, lag_seconds: 0, standbys: 0, receiving: true }]).receiving)
      .toBe(true);
    // A primary has no walreceiver to report on, which is not the same as
    // having a dead one.
    expect(replicationLag.map([{ in_recovery: false, lag_seconds: null, standbys: 2, receiving: null }]).receiving)
      .toBeNull();
  });

  it('reads an unreadable row as unknown rather than as not receiving', () => {
    expect(replicationLag.map([]).receiving).toBeNull();
  });

  it('asks the catalog that answers it', () => {
    expect(replicationLag.sql as string).toContain('pg_stat_wal_receiver');
  });
});
