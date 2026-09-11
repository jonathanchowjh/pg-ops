import { describe, expect, it } from 'vitest';
import { runSeries } from '../src/run.js';
import { SERIES } from '../src/registry.js';
import { captureOnce } from '../src/capture.js';
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
