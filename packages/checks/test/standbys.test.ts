import { describe, expect, it } from 'vitest';
import { standbys, type StandbyRow } from '../src/checks/standbys.js';

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
