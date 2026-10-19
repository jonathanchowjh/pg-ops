import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { standbys } from '../src/checks/standbys.js';
import { withPostgres } from './harness.js';

describe('standbys', () => {
  /**
   * The container is a primary with nothing streaming from it, so this proves
   * only that the statement parses and returns an empty set. It also pins the
   * verdict on an empty set to `ok`: `verdict: null` would make the overview
   * count this check as unjudged on every primary.
   */
  it('runs on a primary with no standbys and judges it ok', async () => {
    await withPostgres(async (ctx) => {
      const res = await runCheck(ctx, standbys);
      if (!res.ok) throw new Error(res.message);
      expect(res.data.standbys).toEqual([]);
      expect(res.verdict).toEqual({ level: 'ok' });
    });
  }, 120_000);

  /**
   * `pg_current_wal_lsn()` raises "recovery is in progress" on a standby, so
   * the reference LSN has to branch. The rig has no standby, so the branch is
   * asserted textually.
   */
  it('branches on recovery, so a cascading standby does not raise', () => {
    expect(standbys.sql as string).toContain('pg_is_in_recovery()');
  });
});
