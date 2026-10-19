import { describe, expect, it } from 'vitest';
import { standbys, type StandbyRow } from '../src/checks/standbys.js';

const t = standbys.thresholds!;

/** One streaming standby, `replaySecs` behind. */
const sb = (replaySecs: number | null, app = 'replica-1') => ({
  app, clientAddr: '10.0.0.2', state: 'streaming', syncState: 'async',
  writeSecs: 0.1, flushSecs: 0.2, replaySecs, sentBytes: 0, replayBytes: 1024,
});

const row = (over: Partial<StandbyRow> = {}): StandbyRow => ({
  app: 'replica-1', client_addr: '10.0.0.2', state: 'streaming', sync_state: 'async',
  write_secs: '0.1', flush_secs: '0.2', replay_secs: '1',
  sent_bytes: '0', replay_bytes: '1024', ...over,
});

describe('standbys.map', () => {
  it('converts every text-cast column and keeps the order the SQL chose', () => {
    const d = standbys.map([row(), row({ app: 'replica-2', replay_secs: '45' })]);
    expect(d.standbys.map((s) => s.app)).toEqual(['replica-1', 'replica-2']);
    expect(d.standbys[0]!.replaySecs).toBe(1);
    expect(d.standbys[1]!.replaySecs).toBe(45);
    expect(d.standbys[0]!.replayBytes).toBe(1024);
  });

  /**
   * A role without pg_monitor reads another user's walsender lag columns as
   * NULL, and a standby whose lag cannot be read must never render as caught
   * up.
   */
  it('maps an unreadable lag to null, never to zero', () => {
    const d = standbys.map([row({ write_secs: null, flush_secs: null, replay_secs: null, replay_bytes: null })]);
    expect(d.standbys[0]!.replaySecs).toBeNull();
    expect(d.standbys[0]!.writeSecs).toBeNull();
    expect(d.standbys[0]!.replayBytes).toBeNull();
  });

  it('is empty, not broken, on a server with no standbys', () => {
    expect(standbys.map([])).toEqual({ standbys: [] });
  });
});

describe('standbys.verdict', () => {
  const warnAt = t.find((x) => x.level === 'warn')!.value;
  const critAt = t.find((x) => x.level === 'critical')!.value;

  it('is ok with no standbys and with a caught-up one', () => {
    expect(standbys.verdict!({ standbys: [] }, t)).toEqual({ level: 'ok' });
    expect(standbys.verdict!({ standbys: [sb(1)] }, t)).toEqual({ level: 'ok' });
  });

  it('judges the worst standby and names it, not the first one it read', () => {
    const v = standbys.verdict!({ standbys: [sb(2), sb(45, 'replica-2')] }, t);
    expect(v.level).toBe('warn');
    expect(v.note).toContain('replica-2');
    expect(v.note).not.toContain('replica-1');
  });

  it('flips at each threshold itself, not one unit past it', () => {
    expect(standbys.verdict!({ standbys: [sb(warnAt - 1)] }, t).level).toBe('ok');
    expect(standbys.verdict!({ standbys: [sb(warnAt)] }, t).level).toBe('warn');
    expect(standbys.verdict!({ standbys: [sb(critAt - 1)] }, t).level).toBe('warn');
    expect(standbys.verdict!({ standbys: [sb(critAt)] }, t).level).toBe('critical');
  });

  /**
   * A standby whose lag this role cannot read is not judged, and must not
   * drag a readable standby's verdict down with it.
   */
  it('does not judge a standby whose lag it cannot read', () => {
    expect(standbys.verdict!({ standbys: [sb(null)] }, t)).toEqual({ level: 'ok' });
    const mixed = standbys.verdict!({ standbys: [sb(null), sb(critAt, 'replica-2')] }, t);
    expect(mixed.level).toBe('critical');
    expect(mixed.note).toContain('replica-2');
  });

  // The threshold lookups must not use a non-null assertion.
  it('does not throw, and stays visible, when a threshold level is absent', () => {
    const warnOnly = t.filter((x) => x.level === 'warn');
    expect(standbys.verdict!({ standbys: [sb(99999)] }, warnOnly).level).toBe('warn');
    expect(standbys.verdict!({ standbys: [sb(99999)] }, []).level).toBe('ok');
  });
});

describe('standbys.requires', () => {
  /**
   * Without this role the lag columns read NULL for another user's
   * walsender. Declared so a privilege failure prints the GRANT.
   */
  it('names the role its lag columns need', () => {
    expect(standbys.requires).toEqual([{ kind: 'role', name: 'pg_monitor' }]);
  });

  /**
   * `pg_current_wal_lsn()` raises "recovery is in progress" on a standby, so
   * the reference LSN has to branch. A cascading standby runs this check too.
   */
  it('branches on recovery rather than assuming it is a primary', () => {
    expect(standbys.sql as string).toContain('pg_is_in_recovery()');
  });
});
