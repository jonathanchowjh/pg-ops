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
   * There is no version branch in the code; the SERVER is the branch. We ask
   * for `io_method` on every version and `map` skips it when no row comes
   * back, so this asserts the end result the branch used to produce —
   * from ctx.serverVersion rather than a literal, the only form that covers
   * the whole 14/16/17/18 CI matrix from one test.
   *
   * Verified by hand on both sides: absent from `pg_settings` on 17.11,
   * present on 18.0.6 (`server_version_num` 180006) with the value `worker`,
   * and asking for it on 17 returns no row rather than an error.
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
   * The typo guard, stated as a property rather than carved out as an
   * exception. Every name must exist on every server in the support matrix —
   * `io_method` below 18 is the ONE permitted absence, and naming it exactly
   * is what keeps a real typo from being waved through with it.
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
   * The divergence that matters, and the one a `pg_settings` port walks into.
   *
   * pgHero issues `SHOW shared_buffers` and gets `128MB`. `pg_settings` for
   * the same setting is `setting = '16384'`, `unit = '8kB'` — so a port that
   * reads the obvious column reports a number 8192 times too small, and one
   * that concatenates the two reports `16384 8kB`, which is not a value an
   * operator can paste into postgresql.conf. `current_setting(name)` is the
   * SHOW-equivalent and the only one of the three that is right.
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
   * Presentation order is pgHero's array order, not the server's. `pg_settings`
   * returns rows in catalog order and the obvious fix — `ORDER BY name` — would
   * scatter the memory settings among the planner ones. So `map` orders, and
   * this asserts it against rows the server did not hand back in that order.
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
