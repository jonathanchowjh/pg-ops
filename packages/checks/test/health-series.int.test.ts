import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { readHealthHistory } from '../src/series/health.js';
import { migrate } from '../src/store/schema.js';
import { upsertDatabase } from '../src/store/write.js';
import { withPostgres } from './harness.js';

const T0 = Date.parse('2026-09-01T00:00:00Z');
const MIN = 60_000;
const RESET_A = '2026-08-01T00:00:00Z';
const RESET_B = '2026-09-01T00:10:30Z';

/** One row at T0 + minute·60s + 30s, so no row sits on a bucket edge. */
async function put(pool: pg.Pool, id: number, minute: number, cols: Record<string, unknown>) {
  const names = Object.keys(cols);
  await pool.query(
    `INSERT INTO pgops.health_stats (database_id, captured_at${names.map((n) => `, ${n}`).join('')})
     VALUES ($1, $2${names.map((_, i) => `, $${i + 3}`).join('')})`,
    [id, new Date(T0 + minute * MIN + 30_000), ...names.map((n) => cols[n])],
  );
}

async function setup(pool: pg.Pool, name = 'prod'): Promise<number> {
  await migrate(pool);
  const c = await pool.connect();
  try {
    return await upsertDatabase(c, name);
  } finally {
    c.release();
  }
}

/** Twenty minutes in ten two-minute buckets: bucket i holds minutes 2i and 2i+1. */
const WINDOW = { from: new Date(T0), to: new Date(T0 + 20 * MIN), points: 10 };

describe('readHealthHistory', () => {
  it('derives a steady rate from a counter that only climbs', async () => {
    await withPostgres(async (_ctx, pool) => {
      const id = await setup(pool);
      for (let m = 0; m < 20; m += 1) {
        await put(pool, id, m, { xact_commit: 1000 + m * 600, stats_reset: RESET_A, blocked: 0 });
      }
      const [h] = await readHealthHistory(pool, { names: ['prod'], ...WINDOW });
      expect(h!.rows).toBe(20);
      expect(h!.points).toHaveLength(10);
      for (const p of h!.points) expect(p.commitsPerSec).toBeCloseTo(10, 6);
    });
  });

  /**
   * Review Focus 4. The counter is HIGHER after the reset than before it, on
   * purpose. In the first version of this test it fell, so the "went
   * backwards" rule alone passed it and the `stats_reset` comparison could
   * be deleted with the test still green (final review; confirmed by
   * deleting it). A reset onto a busier node, or a failover behind one URL,
   * is exactly a counter that jumps UP across a reset.
   */
  it('makes a statistics reset one empty interval, even when the counter jumps up', async () => {
    await withPostgres(async (_ctx, pool) => {
      const id = await setup(pool);
      for (let m = 0; m < 20; m += 1) {
        const afterReset = m >= 10;
        await put(pool, id, m, {
          xact_commit: afterReset ? 900_000_000 + m * 600 : 1_000 + m * 600,
          stats_reset: afterReset ? RESET_B : RESET_A,
        });
      }
      const [h] = await readHealthHistory(pool, { names: ['prod'], ...WINDOW });
      // Bucket 5 holds minutes 10 and 11. 9→10 crosses the reset and is dropped; 10→11 is valid.
      for (const p of h!.points) expect(p.commitsPerSec).toBeCloseTo(10, 6);
    });
  });

  it('drops an interval where a counter fell without a reset being recorded', async () => {
    await withPostgres(async (_ctx, pool) => {
      const id = await setup(pool);
      for (let m = 0; m < 20; m += 1) {
        await put(pool, id, m, { xact_commit: m >= 14 ? (m - 14) * 600 : 500_000 + m * 600, stats_reset: RESET_A });
      }
      const [h] = await readHealthHistory(pool, { names: ['prod'], ...WINDOW });
      for (const p of h!.points) {
        expect(p.commitsPerSec).not.toBeNull();
        expect(p.commitsPerSec!).toBeGreaterThanOrEqual(0);
        expect(p.commitsPerSec!).toBeCloseTo(10, 6);
      }
    });
  });

  it('leaves a missing stretch empty and does not join across it', async () => {
    await withPostgres(async (_ctx, pool) => {
      const id = await setup(pool);
      for (let m = 0; m < 20; m += 1) {
        if (m >= 4 && m <= 7) continue; // pgops was down for four minutes
        await put(pool, id, m, { xact_commit: 1000 + m * 600, stats_reset: RESET_A, blocked: 1 });
      }
      const [h] = await readHealthHistory(pool, { names: ['prod'], ...WINDOW });
      expect(h!.points[2]!.blocked).toBeNull();
      expect(h!.points[2]!.commitsPerSec).toBeNull();
      expect(h!.points[3]!.blocked).toBeNull();
      // Bucket 4 holds minutes 8 and 9. 3→8 is five minutes and is not joined; 8→9 is.
      expect(h!.points[4]!.commitsPerSec).toBeCloseTo(10, 6);
      expect(h!.points[4]!.blocked).toBe(1);
    });
  });

  it('returns null for a column nothing ever filled, across the whole window', async () => {
    await withPostgres(async (_ctx, pool) => {
      const id = await setup(pool);
      for (let m = 0; m < 20; m += 1) await put(pool, id, m, { blocked: 0 });
      const [h] = await readHealthHistory(pool, { names: ['prod'], ...WINDOW });
      expect(h!.points.every((p) => p.replicationLagSecs === null)).toBe(true);
      expect(h!.points.every((p) => p.commitsPerSec === null)).toBe(true);
      expect(h!.points.every((p) => p.blocked === 0)).toBe(true);
    });
  });

  it('keeps a one-minute spike visible in a 90-day window', async () => {
    await withPostgres(async (_ctx, pool) => {
      const id = await setup(pool);
      const day = 24 * 60;
      for (const m of [10 * day, 10 * day + 1, 10 * day + 2, 40 * day, 80 * day]) {
        await put(pool, id, m, { blocked: m === 10 * day + 1 ? 7 : 0 });
      }
      const [h] = await readHealthHistory(pool, {
        names: ['prod'], from: new Date(T0), to: new Date(T0 + 90 * day * MIN), points: 180,
      });
      expect(h!.points).toHaveLength(180);
      expect(Math.max(...h!.points.map((p) => p.blocked ?? 0))).toBe(7);
    });
  });

  it('never makes a bucket narrower than two minutes, whatever is asked', async () => {
    await withPostgres(async (_ctx, pool) => {
      await setup(pool);
      const [h] = await readHealthHistory(pool, { names: ['prod'], ...WINDOW, points: 5_000 });
      expect(h!.points).toHaveLength(10);
    });
  });

  it('answers for every name asked, in order, including one with no rows', async () => {
    await withPostgres(async (_ctx, pool) => {
      const a = await setup(pool, 'a');
      await setup(pool, 'b');
      await put(pool, a, 1, { blocked: 2 });
      const out = await readHealthHistory(pool, { names: ['b', 'a', 'never-seen'], ...WINDOW });
      expect(out.map((h) => [h.name, h.rows])).toEqual([['b', 0], ['a', 1], ['never-seen', 0]]);
      expect(out[0]!.points).toHaveLength(10);
      expect(out[1]!.points[0]!.blocked).toBe(2);
    });
  });

  it('counts pgops\'s own statements as a rate without differencing them', async () => {
    await withPostgres(async (_ctx, pool) => {
      const id = await setup(pool);
      for (let m = 0; m < 20; m += 1) await put(pool, id, m, { own_statements: 120, stats_reset: RESET_A });
      const [h] = await readHealthHistory(pool, { names: ['prod'], ...WINDOW });
      for (const p of h!.points) expect(p.ownPerSec).toBeCloseTo(2, 6);
    });
  });

  /**
   * Final review. An unreachable database writes no rows, so after a few
   * hours down its window is empty and the page said "Collecting. The first
   * chart appears in a minute." above ninety days of history. The newest row
   * EVER, not in the window, is what tells the two apart.
   */
  it('reports the newest row ever stored, which may be far outside the window', async () => {
    await withPostgres(async (_ctx, pool) => {
      const id = await setup(pool);
      await setup(pool, 'new');
      await put(pool, id, -5_000, { blocked: 1 });
      const out = await readHealthHistory(pool, { names: ['prod', 'new', 'never-seen'], ...WINDOW });
      expect(out.map((h) => h.rows)).toEqual([0, 0, 0]);
      expect(out[0]!.lastAt).toBe(T0 - 5_000 * MIN + 30_000);
      expect(out[1]!.lastAt).toBeNull();
      expect(out[2]!.lastAt).toBeNull();
    });
  });
});
