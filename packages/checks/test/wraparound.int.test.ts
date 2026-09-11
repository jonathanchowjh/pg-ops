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
      // `wraparound` carries a verdict function, so this is never null in practice.
      expect(r.verdict!.level).toBe('ok');
    });
  }, 120_000);

  it('does NOT escalate at the forced-autovacuum trigger — that is routine (A1)', () => {
    const t = wraparound.thresholds!;
    // 180M transactions of age is 90% of the default autovacuum_freeze_max_age.
    // The shipped code called this `critical`. It is 8.38% of the real horizon.
    const at180M = wraparound.verdict!(
      { worst: [{ database: 'app', xactAge: 180_000_000,
                  txnsUntilShutdown: HARD_LIMIT - 180_000_000,
                  pctToForcedVacuum: 90 }] }, t);
    expect(at180M.level).toBe('ok');
  });

  it('escalates on transactions remaining, at the documented boundary', () => {
    const t = wraparound.thresholds!;
    const warn = t.find((x) => x.level === 'warn')!.value;
    const crit = t.find((x) => x.level === 'critical')!.value;
    const at = (remaining: number) => wraparound.verdict!(
      { worst: [{ database: 'app', xactAge: HARD_LIMIT - remaining,
                  txnsUntilShutdown: remaining, pctToForcedVacuum: 0 }] }, t).level;

    // `txnsUntilShutdown` counts DOWN — fewer transactions remaining is
    // worse — so the safe side of each boundary is one transaction MORE.
    // Spec §9 wants the value itself and one unit either side of it.
    expect(at(warn + 1)).toBe('ok');
    expect(at(warn)).toBe('warn');
    expect(at(warn - 1)).toBe('warn');
    expect(at(crit + 1)).toBe('warn');
    expect(at(crit)).toBe('critical');
    expect(at(crit - 1)).toBe('critical');
  });

  it('every threshold carries a justification', () => {
    for (const t of wraparound.thresholds!) expect(t.because.length).toBeGreaterThan(20);
  });
});
