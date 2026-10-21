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
   * pgHero answers 0 for a primary, which reads as "perfectly caught up" on a
   * server that is not replicating at all. `null` means the question does not
   * apply; `0` is reserved for a standby with no lag.
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
   * `standbys: 0` is a finding; a missing row is "we could not look". `??`
   * keeps them apart where `||` would turn a real zero into unknown.
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
    expect(replicationLag.thresholds).toBeUndefined();
  });
});

/**
 * `lag_seconds` is 0 when `pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()`.
 * A dead walreceiver looks the same: nothing arriving, nothing left to
 * replay. `receiving` is what tells a caught-up standby from a disconnected
 * one.
 */
describe('replicationLag — a standby that is not receiving', () => {
  it('reports whether a walreceiver is running, and only on a standby', () => {
    expect(replicationLag.map([{ in_recovery: true, lag_seconds: 0, standbys: 0, receiving: false }]).receiving)
      .toBe(false);
    expect(replicationLag.map([{ in_recovery: true, lag_seconds: 0, standbys: 0, receiving: true }]).receiving)
      .toBe(true);
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
