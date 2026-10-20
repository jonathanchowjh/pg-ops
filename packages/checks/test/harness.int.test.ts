import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { withPostgres } from './harness.js';
import type { Check } from '../src/types.js';

const version: Check<{ v: string }, number> = {
  id: 'version', home: 'database', title: 'Server version', class: 'live',
  // No bind parameter on purpose: a plain-string `check.sql` gets no `values`
  // array from runCheck, so a literal `$1` would be rejected with 42P02.
  sql: "SELECT current_setting('server_version_num')::text AS v",
  map: (rows) => Number(rows[0]?.v ?? 0),
};

describe('the integration harness', () => {
  it('gives every test a live Postgres and a real CheckContext', async () => {
    await withPostgres(async (ctx) => {
      expect(ctx.serverVersion).toBeGreaterThanOrEqual(140000);
      const r = await runCheck(ctx, version);
      expect(r.ok).toBe(true);
    });
  }, 120_000);

  // Every integration test relies on a withPostgres() call getting a database
  // no other call can see.
  it('gives two withPostgres() calls non-interfering databases', async () => {
    await withPostgres(async (_ctx, pool) => {
      await pool.query('CREATE TABLE only_in_first (id int)');
    });

    await withPostgres(async (_ctx, pool) => {
      const { rows } = await pool.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'only_in_first') AS exists",
      );
      expect(rows[0]?.exists).toBe(false);
    });
  }, 120_000);
});
