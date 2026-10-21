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
});
