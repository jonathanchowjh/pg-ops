import { describe, expect, it } from 'vitest';
import { replicationLag } from '../src/checks/replication.js';

describe('replicationLag', () => {
  const primary = { in_recovery: false, lag_seconds: null, standbys: 2 };

  it('reports a primary with standbys attached', () => {
    expect(replicationLag.map([primary])).toEqual({
      inRecovery: false, lagSeconds: null, standbys: 2,
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
    const caughtUp = { in_recovery: true, lag_seconds: 0, standbys: 0 };
    expect(replicationLag.map([caughtUp]).lagSeconds).toBe(0);
  });

  it('reports a lagging standby in seconds', () => {
    const behind = { in_recovery: true, lag_seconds: 12.5, standbys: 0 };
    expect(replicationLag.map([behind])).toEqual({
      inRecovery: true, lagSeconds: 12.5, standbys: 0,
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
      inRecovery: null, lagSeconds: null, standbys: null,
    });
  });

  it('never escalates — pgHero has no lag threshold and neither do we', () => {
    expect(replicationLag.verdict).toBeUndefined();
    expect(replicationLag.thresholds).toBeUndefined();
  });
});
