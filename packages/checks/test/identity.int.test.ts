import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { identity } from '../src/checks/identity.js';
import { withPostgres } from './harness.js';

/** `map` is covered by identity.test.ts; this file is about the SQL against a real server. */
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
   * The container has no `sslinfo` extension, so a non-null answer proves
   * the check needs none. Asserts the type, not the value: whether the
   * fixture negotiated TLS is not this check's business.
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

  /** `contextFor` probes the version independently for gating; the two readings must not drift. */
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
