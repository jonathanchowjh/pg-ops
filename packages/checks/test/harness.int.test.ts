import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { withPostgres } from './harness.js';
import type { Check } from '../src/types.js';

const version: Check<{ v: string }, number> = {
  id: 'version', gate: 'work', title: 'Server version', class: 'incident',
  // No bind parameter here on purpose: `check.sql` as a plain string never gets a
  // `values` array from runCheck, so a literal `$1` sent this way is unbound and
  // Postgres rejects it with "there is no parameter $1" (42P02) — a real SQL
  // defect that only a live server, not a fake pool, can catch.
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

  // Tasks 6-13 lean on every withPostgres() call getting a database no other
  // call can see — that's the property that keeps one task's fixtures from
  // leaking into another's assertions. Assert it directly rather than taking
  // it on faith: create a table inside the first call, then prove a second,
  // independent call never sees it.
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
