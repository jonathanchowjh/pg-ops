import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { connections } from '../src/checks/connections.js';
import pg from 'pg';
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
      expect(r.data.headroom).toBe(max - r.data.reserved - r.data.used);
    });
  }, 120_000);

  it('counts the clients a role without pg_read_all_stats cannot read', async () => {
    await withPostgres(async (ctx, pool) => {
      const url = new URL(pool.options.connectionString!);
      const role = `r_${Math.random().toString(36).slice(2, 8)}`;
      await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'x'`);
      url.username = role; url.password = 'x';
      const restricted = new pg.Pool({ connectionString: url.toString(), max: 1 });
      try {
        // The restricted read first, so its own connection is open when the superuser counts.
        const blind = await runCheck({ ...ctx, target: restricted }, connections);
        const seeing = await runCheck(ctx, connections);
        if (!blind.ok || !seeing.ok) throw new Error('read failed');
        // It counts the superuser's connection, which it cannot read, as well as its own.
        expect(blind.data.used).toBeGreaterThan(1);
        // Within a backend that came or went between the two reads.
        expect(Math.abs(blind.data.used - seeing.data.used)).toBeLessThanOrEqual(1);
      } finally {
        await restricted.end();
        await pool.query(`DROP ROLE ${role}`);
      }
    });
  }, 120_000);

  it('escalates on the boundary, in the database, not on the constant', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, connections);
      if (!r.ok) throw new Error(r.message);
      // An idle test database has almost all of its pool free.
      // `connections` carries a verdict function, so this is never null in practice.
      expect(r.verdict!.level).toBe('ok');

      // Drive the verdict directly at each documented boundary.
      const t = connections.thresholds!;
      const warnAt = t.find((x) => x.level === 'warn')!.value;
      const critAt = t.find((x) => x.level === 'critical')!.value;
      const at = (pct: number) => connections.verdict!(
        { max: 100, used: 100 - pct, reserved: 0, headroom: pct }, t,
      ).level;

      // `headroom` counts down — smaller is worse — so one percent more
      // headroom is the safe side, the mirror of the rising checks' `>=`.
      expect(at(warnAt + 1)).toBe('ok');
      expect(at(warnAt)).toBe('ok');        // exactly at the line is not over it
      expect(at(warnAt - 1)).toBe('warn');
      expect(at(critAt + 1)).toBe('warn');
      expect(at(critAt)).toBe('warn');
      expect(at(critAt - 1)).toBe('critical');
    });
  }, 120_000);

  // Pure — no container needed. Pins the over-committed case, where reserved
  // exceeds what remains and headroom goes negative.
  it('still escalates to critical when reserved exceeds what remains (over-committed)', () => {
    const t = connections.thresholds!;
    // max 100, used 95 -> only 5 slots physically remain, but 10 are
    // reserved: headroom = 100 - 10 - 95 = -5.
    const v = connections.verdict!({ max: 100, used: 95, reserved: 10, headroom: -5 }, t);
    expect(v.level).toBe('critical');
  });
});
