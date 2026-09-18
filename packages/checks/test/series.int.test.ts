import { describe, expect, it } from 'vitest';
import { runSeries } from '../src/run.js';
import { SERIES } from '../src/registry.js';
import { captureOnce } from '../src/capture.js';
import { relationSpace, spaceGrowth } from '../src/series/space.js';
import { queryShapeHistory } from '../src/series/query-stats.js';
import { insertSpaceStats, upsertDatabase } from '../src/store/write.js';
import { migrate } from '../src/store/schema.js';
import { withPostgres } from './harness.js';

describe('historicalQueryStats', () => {
  it('reports missing-store when no store is configured', async () => {
    await withPostgres(async (ctx) => {
      const r = await runSeries(ctx, SERIES.historicalQueryStats,
        { from: new Date(0), to: new Date() }, { databaseName: 'prod' });
      expect(r).toMatchObject({ ok: false, reason: 'missing-store' });
      expect(r.ok === false && r.remedy).toMatch(/PGOPS_STORE_URL/);
    });
  });

  it('returns intervals between two captures', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      const withStore = { ...ctx, store: pool };

      await captureOnce(withStore, 'prod');
      // Do measurable work so the second snapshot differs from the first.
      for (let i = 0; i < 20; i += 1) await pool.query('SELECT 1');
      await captureOnce(withStore, 'prod');

      const r = await runSeries(withStore, SERIES.historicalQueryStats,
        { from: new Date(Date.now() - 3_600_000), to: new Date() },
        { databaseName: 'prod' });
      expect(r.ok).toBe(true);
      expect(r.ok && r.points.length).toBeGreaterThan(0);
    });
  });
});

/**
 * The bound that spec §5.1 requires, proved against a real store rather than
 * against `readQueryStats` in isolation.
 *
 * store.int.test.ts already covers `readQueryStats`'s own handling of
 * `maxSnapshots`; what that cannot see — and did not — is whether the series
 * the queries page actually calls ever hands them over. It did not, so the
 * page's `maxSnapshots: 2` was inert and every 5-second poll read the whole
 * window. Three captures is the smallest number that tells the two apart: an
 * unbounded read yields two intervals per shape, a bounded one exactly one.
 */
describe('historicalQueryStats — the read is bounded', () => {
  it('keeps only the N most recent captures the caller asked for', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      const withStore = { ...ctx, store: pool };

      // Three captures with measurable work between them, so the counters
      // climb and no interval is dropped as a discontinuity.
      for (let pass = 0; pass < 3; pass += 1) {
        for (let i = 0; i < 20; i += 1) await pool.query('SELECT 1');
        await captureOnce(withStore, 'prod');
      }

      // Built AFTER the captures, and with margin on both ends. `captured_at`
      // is stamped by the STORE's clock, not this process's — that is
      // capture.ts's deliberate rule, so that several replicas cannot sort
      // their snapshots out of order — which means a host-side `to` of
      // "now" can legitimately sit BEHIND a snapshot the store has just
      // written, and the window then excludes every row. A first draft of
      // this test built the range before the loop and read back nothing at
      // all.
      const range = {
        from: new Date(Date.now() - 3_600_000),
        to: new Date(Date.now() + 3_600_000),
      };

      const all = await runSeries(withStore, SERIES.historicalQueryStats, range,
        { databaseName: 'prod' });
      expect(all.ok).toBe(true);
      // Unbounded: three snapshots difference into more than one interval.
      // `> 1` rather than `=== 2` so the assertion states the property under
      // test — the bound reduces what is read — instead of pinning a count
      // that any extra snapshot in the window would move.
      expect(all.ok && all.points.some((s) => s.intervals.length > 1)).toBe(true);

      const bounded = await runSeries(withStore, SERIES.historicalQueryStats, range,
        { databaseName: 'prod', maxSnapshots: 2 });
      expect(bounded.ok).toBe(true);
      expect(bounded.ok && bounded.points.length).toBeGreaterThan(0);
      // Two snapshots can only ever difference into one interval. Before the
      // fix this read the same three snapshots the unbounded call did.
      expect(bounded.ok && bounded.points.every((s) => s.intervals.length === 1)).toBe(true);

      // ...and the shape filter, on the same call the page makes.
      const one = bounded.ok ? bounded.points[0]!.queryid : '';
      const single = await runSeries(withStore, SERIES.historicalQueryStats, range,
        { databaseName: 'prod', maxSnapshots: 2, queryids: [one] });
      expect(single.ok && single.points.map((s) => s.queryid)).toEqual([one]);
    });
  });
});

/**
 * The space series through `runSeries`, which is the only way a page reaches
 * them. `read` is where `ctx.store!` and the `maxPoints` hand-off live, and
 * neither is visible from a mapper test.
 */
describe('the space series', () => {
  it('report missing-store when no store is configured', async () => {
    await withPostgres(async (ctx) => {
      const g = await runSeries(ctx, spaceGrowth,
        { from: new Date(0), to: new Date() }, { databaseName: 'prod' });
      expect(g).toMatchObject({ ok: false, reason: 'missing-store' });
      const r = await runSeries(ctx, relationSpace,
        { from: new Date(0), to: new Date() },
        { databaseName: 'prod', relation: 'public.t' });
      expect(r).toMatchObject({ ok: false, reason: 'missing-store' });
    });
  });

  /**
   * §5.1's bound, proved to reach the reader rather than assumed from the
   * option being present in the type. Dropping `maxPoints` on the way through
   * `relationSpace.read` is invisible to every mapper test and to
   * `readRelationSpace`'s own tests, which call the reader directly -- the
   * series is the only layer that can lose it, so it is the layer that has to
   * be asked.
   */
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

  it('report one relation\u2019s growth across the window', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const dbId = await upsertDatabase(client, 'prod');
        await insertSpaceStats(client, [
          { databaseId: dbId, relation: 'public.t',
            capturedAt: new Date('2026-09-01T00:00:00Z'), sizeBytes: 1_000 },
          { databaseId: dbId, relation: 'public.t',
            capturedAt: new Date('2026-09-07T00:00:00Z'), sizeBytes: 9_000 },
        ]);
      } finally { client.release(); }

      const r = await runSeries({ ...ctx, store: pool }, spaceGrowth,
        { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-07T00:00:00Z') },
        { databaseName: 'prod' });

      expect(r.ok).toBe(true);
      expect(r.ok && r.points[0]).toMatchObject({
        relation: 'public.t', growthBytes: 8_000, points: 2,
      });
    });
  });
});

describe('queryShapeHistory', () => {
  it('returns one shape\u2019s intervals over the window, and nothing else\u2019s', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      const withStore = { ...ctx, store: pool };

      // Two captures with measurable work between them, so the counters climb
      // and no interval is dropped as a discontinuity (§3.5).
      await captureOnce(withStore, 'prod');
      for (let i = 0; i < 20; i += 1) await pool.query('SELECT 1');
      await captureOnce(withStore, 'prod');

      const range = { from: new Date(Date.now() - 3_600_000), to: new Date() };
      const all = await runSeries(withStore, SERIES.historicalQueryStats, range,
        { databaseName: 'prod' });
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      const shapes = all.points.filter((p) => p.intervals.length > 0);
      // EVERY shape, not the first one with intervals. A reader that dropped
      // the queryid filter returns whichever shape sorts first -- which is
      // exactly the shape a `find(...)` picks, so asserting on one target
      // passes against a filter that is not there at all. Asking for each
      // shape in turn means at least one request must get back somebody
      // else's intervals.
      expect(shapes.length).toBeGreaterThan(1);

      for (const shape of shapes) {
        const one = await runSeries(withStore, queryShapeHistory, range,
          { databaseName: 'prod', queryid: shape.queryid });
        expect(one.ok).toBe(true);
        if (!one.ok) return;
        expect(one.points).toEqual(shape.intervals);
      }
    });
  });

  it('returns no points for a shape the store has never seen', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      const result = await runSeries(
        { ...ctx, store: pool }, queryShapeHistory,
        { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z') },
        { databaseName: 'prod', queryid: '404' });

      // ok:true with no points, NOT ok:false. "We looked and there is no
      // history" is a reading; "we could not look" is a failure, and a page
      // that confuses them tells an operator their store is broken.
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.points).toEqual([]);
    });
  });
});
