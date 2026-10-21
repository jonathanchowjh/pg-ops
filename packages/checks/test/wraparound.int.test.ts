import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { wraparound } from '../src/checks/wraparound.js';
import { withPostgres } from './harness.js';

const HARD_LIMIT = 2_147_483_647;

describe('wraparound', () => {
  it('reports transactions remaining, not a ratio of the autovacuum trigger', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, wraparound);
      if (!r.ok) throw new Error(r.message);
      const worst = r.data.worst[0]!;
      expect(worst.txnsUntilShutdown).toBe(HARD_LIMIT - worst.xactAge);
      expect(worst.txnsUntilShutdown).toBeGreaterThan(2_000_000_000);
    });
  }, 120_000);

  it('every threshold carries a justification', () => {
    for (const t of wraparound.thresholds!) expect(t.because.length).toBeGreaterThan(20);
  });
});
