import { describe, expect, it } from 'vitest';
import { runSeries } from '../src/run.js';
import { relationSpace } from '../src/series/space.js';
import { insertSpaceStats, upsertDatabase } from '../src/store/write.js';
import { migrate } from '../src/store/schema.js';
import { withPostgres } from './harness.js';

/**
 * The space series through `runSeries`, the way a page reaches them. `read`
 * holds `ctx.store!` and the `maxPoints` hand-off, which mapper tests cannot
 * see.
 */
describe('the space series', () => {
  it('reports missing-store when no store is configured', async () => {
    await withPostgres(async (ctx) => {
      const r = await runSeries(ctx, relationSpace,
        { from: new Date(0), to: new Date() },
        { databaseName: 'prod', relation: 'public.t' });
      expect(r).toMatchObject({ ok: false, reason: 'missing-store' });
    });
  });

  it('bound relationSpace to the most recent maxPoints captures', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      const base = Date.parse('2026-09-01T00:00:00Z');
      const client = await pool.connect();
      try {
        const dbId = await upsertDatabase(client, 'prod');
        await insertSpaceStats(client, Array.from({ length: 10 }, (_, i) => ({
          databaseId: dbId, relation: 'public.t',
          capturedAt: new Date(base + i * 60_000), sizeBytes: i,
        })));
      } finally { client.release(); }

      const range = { from: new Date(base), to: new Date(base + 10 * 60_000) };
      const r = await runSeries({ ...ctx, store: pool }, relationSpace, range,
        { databaseName: 'prod', relation: 'public.t', maxPoints: 3 });

      expect(r.ok).toBe(true);
      expect(r.ok && r.points.map((p) => p.sizeBytes)).toEqual([7, 8, 9]);
    });
  });

});

