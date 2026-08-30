import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { connections } from '../src/checks/connections.js';
import { withPostgres } from './harness.js';

describe('connections', () => {
  it('subtracts the reserved pool from headroom (A3)', async () => {
    await withPostgres(async (ctx, pool) => {
      const r = await runCheck(ctx, connections);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const { rows } = await pool.query<{ max: string; su: string }>(
        `SELECT current_setting('max_connections') AS max,
                current_setting('superuser_reserved_connections') AS su`,
      );
      const max = Number(rows[0]!.max);
      const su = Number(rows[0]!.su);

      expect(r.data.max).toBe(max);
      expect(r.data.reserved).toBeGreaterThanOrEqual(su);
      // The defect: headroom used to be max - used, ignoring the reserved pool.
      expect(r.data.headroom).toBe(max - r.data.reserved - r.data.used);
    });
  }, 120_000);

  it('escalates on the boundary, in the database, not on the constant', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, connections);
      if (!r.ok) throw new Error(r.message);
      // An idle test database has almost all of its pool free.
      expect(r.verdict.level).toBe('ok');

      // Drive the verdict directly at each documented boundary.
      const t = connections.thresholds!;
      const warnAt = t.find((x) => x.level === 'warn')!.value;
      const critAt = t.find((x) => x.level === 'critical')!.value;
      const at = (pct: number) => connections.verdict!(
        { max: 100, used: 100 - pct, reserved: 0, headroom: pct }, t,
      ).level;

      // `headroom` counts DOWN — smaller is worse — so "one unit either
      // side" (spec §9) means one percent MORE headroom is the safe side
      // here, the mirror of the rising-quantity checks' `>=`.
      expect(at(warnAt + 1)).toBe('ok');
      expect(at(warnAt)).toBe('ok');        // exactly at the line is not over it
      expect(at(warnAt - 1)).toBe('warn');
      expect(at(critAt + 1)).toBe('warn');
      expect(at(critAt)).toBe('warn');
      expect(at(critAt - 1)).toBe('critical');
    });
  }, 120_000);

  // Pure — no container needed. Locks the over-committed case: reserved
  // exceeding what actually remains (headroom goes negative). Nothing else
  // pins this down, and it is the one shape a "never show a negative number"
  // display fix is likely to touch first.
  it('still escalates to critical when reserved exceeds what remains (over-committed)', () => {
    const t = connections.thresholds!;
    // max 100, used 95 -> only 5 slots physically remain, but 10 are
    // reserved: headroom = 100 - 10 - 95 = -5.
    const v = connections.verdict!({ max: 100, used: 95, reserved: 10, headroom: -5 }, t);
    expect(v.level).toBe('critical');
  });
});
