import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { replicationLag } from '../src/checks/replication.js';
import { withPostgres } from './harness.js';

describe('replicationLag', () => {
  /**
   * The harness runs a single-node primary, so this proves the primary branch
   * and the divergence that matters: `lagSeconds` is NULL, not 0. It cannot
   * prove the standby branch — there is no second node to stream to — and
   * that limitation is stated rather than papered over with a structural
   * assertion about the SQL text.
   */
  it('reads a real primary as a primary, with no lag figure', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, replicationLag);
      if (!r.ok) throw new Error(r.message);
      expect(r.data.inRecovery).toBe(false);
      expect(r.data.lagSeconds).toBeNull();
      expect(r.data.standbys).toBe(0);
    });
  }, 120_000);
});

/**
 * B4, standby side. The rig is a primary, so `receiving` must be NULL here —
 * a primary has no walreceiver to report on, which is a different fact from
 * having a dead one. That distinction is the whole point of the column, and
 * this is the only assertion a single-node rig can make about it.
 */
describe('replicationLag — the walreceiver column', () => {
  it('reports no walreceiver state at all on a primary', async () => {
    await withPostgres(async (ctx) => {
      const res = await runCheck(ctx, replicationLag);
      if (!res.ok) throw new Error(res.message);
      expect(res.data.inRecovery).toBe(false);
      expect(res.data.receiving).toBeNull();
    });
  }, 120_000);
});
