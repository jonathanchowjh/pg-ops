import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { identity } from '../src/checks/identity.js';
import { withPostgres } from './harness.js';

/**
 * `map` is covered by identity.test.ts. Everything here is about the SQL,
 * because the SQL is the part that can only be wrong against a real server:
 * whether `pg_stat_ssl` yields a row for our own backend without
 * `pg_read_all_stats`, and whether the four facts survive the PG 14-18
 * matrix CI runs this file under.
 */
describe('identity (integration)', () => {
  it('reports the server we are actually connected to', async () => {
    await withPostgres(async (ctx, pool) => {
      const { rows } = await pool.query<{ db: string; usr: string }>(
        'SELECT current_database() AS db, current_user AS usr',
      );
      const expected = rows[0]!;

      const result = await runCheck(ctx, identity);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.database).toBe(expected.db);
      expect(result.data.user).toBe(expected.usr);
      expect(result.data.replica).toBe(false);
    });
  });

  /**
   * The divergence from pgHero, exercised. pgHero needs the `sslinfo`
   * extension for this and reports nothing without it; the container this
   * runs against has no such extension installed, so a non-null answer here
   * is the whole claim in the check's docblock. Deliberately asserts the
   * TYPE rather than the value: whether the test container negotiated TLS
   * is not this check's business, and pinning `false` would make the test
   * fail the day someone turns SSL on in the fixture.
   */
  it('reads its own SSL status from the core catalog, with no extension', async () => {
    await withPostgres(async (ctx, pool) => {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_extension WHERE extname = 'sslinfo'`,
      );
      expect(rows[0]!.n, 'fixture must not have sslinfo installed').toBe('0');

      const result = await runCheck(ctx, identity);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(typeof result.data.ssl).toBe('boolean');
    });
  });

  /**
   * The formatted version must agree with the number `contextFor` probes
   * independently for version gating — two readings of the same fact by two
   * different code paths, which is exactly where they drift.
   */
  it('formats a version that agrees with the context probe', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, identity);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const major = Math.floor(ctx.serverVersion / 10000);
      expect(result.data.serverVersion).toBe(`${major}.${ctx.serverVersion % 10000}`);
      expect(major).toBeGreaterThanOrEqual(14);
    });
  });
});
