import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { settings, settingNames } from '../src/checks/settings.js';
import { withPostgres } from './harness.js';

describe('settings against a real server', () => {
  it('reads every group in one round trip', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, settings);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.main.find((s) => s.name === 'max_connections')?.value).toBeTruthy();
      expect(result.data.autovacuum.length).toBeGreaterThan(0);
      expect(result.data.vacuum.length).toBeGreaterThan(0);
      expect(result.verdict).toBeNull();
    });
  });

  /**
   * There is no version branch in the code: `io_method` is asked for on every
   * version and `map` skips it when no row comes back (below 18 the query
   * returns no row rather than an error). Asserted from ctx.serverVersion so
   * one test covers the whole version matrix.
   */
  it('includes io_method exactly when the server is 18 or newer', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, settings);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const present = result.data.main.some((s) => s.name === 'io_method');
      expect(present).toBe(ctx.serverVersion >= 180_000);
    });
  });

  /**
   * Every name must exist on every supported server. `io_method` below 18 is
   * the one permitted absence, named exactly so a real typo is not waved
   * through with it.
   */
  it('names every setting it asks for, so a typo fails here rather than rendering blank', async () => {
    await withPostgres(async (ctx, pool) => {
      const asked = settingNames();
      const { rows } = await pool.query<{ name: string }>(
        'SELECT name FROM pg_settings WHERE name = ANY($1)', [asked]);
      const missing = asked.filter((n) => !rows.some((r) => r.name === n));
      expect(missing).toEqual(ctx.serverVersion >= 180_000 ? [] : ['io_method']);
    });
  });

  /**
   * `SHOW shared_buffers` gives `128MB`; `pg_settings` gives
   * `setting = '16384'`, `unit = '8kB'`. Reading `setting` reports a number
   * 8192 times too small. `current_setting(name)` is the SHOW-equivalent.
   */
  it('reports the value an operator would paste back, not the raw block count', async () => {
    await withPostgres(async (ctx, pool) => {
      const result = await runCheck(ctx, settings);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { rows } = await pool.query<{ setting: string; shown: string }>(
        "SELECT setting, current_setting(name) AS shown FROM pg_settings WHERE name = 'shared_buffers'");
      const { setting, shown } = rows[0]!;
      // Guard the fixture: on a server where the two happen to agree, the
      // assertion below could not tell the columns apart.
      expect(shown).not.toBe(setting);

      const buffers = result.data.main.find((s) => s.name === 'shared_buffers');
      expect(buffers?.value).toBe(shown);
    });
  });

  /**
   * `pg_settings` returns rows in catalog order and `ORDER BY name` would
   * scatter the memory settings among the planner ones, so `map` orders.
   */
  it('renders in pgHero group order rather than however the catalog answered', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, settings);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.main.slice(0, 4).map((s) => s.name)).toEqual([
        'max_connections', 'shared_buffers', 'effective_cache_size', 'maintenance_work_mem',
      ]);
      expect(result.data.vacuum.map((s) => s.name)).toEqual(['vacuum_cost_limit']);
    });
  });
});
