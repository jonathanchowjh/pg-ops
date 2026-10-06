import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { standbys } from '../src/checks/standbys.js';
import { withPostgres } from './harness.js';

describe('standbys', () => {
  /**
   * The container is a primary with nothing streaming from it, so this proves
   * the statement PARSES and returns an empty set — which is the whole of
   * what a single-node test rig can prove about a replication view, and is
   * worth proving: every column here is either a lag interval or a
   * `pg_wal_lsn_diff`, and both are easy to get wrong in ways only the
   * server rejects.
   *
   * It also pins the verdict on an empty set to `ok`. The alternative
   * reading — no standbys means nothing to judge, so stay silent — would be
   * `verdict: null`, and the overview would then count this check as
   * unjudged on every primary in the fleet.
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
   * `pg_current_wal_lsn()` RAISES "recovery is in progress" on a standby
   * rather than returning null, so the reference LSN has to branch. The test
   * rig has no standby to run this check on, so the branch is asserted
   * textually — the same compromise the plan specified, and worth stating:
   * this is the one claim in this file the rig cannot actually exercise.
   */
  it('branches on recovery, so a cascading standby does not raise', () => {
    expect(standbys.sql as string).toContain('pg_is_in_recovery()');
  });
});
