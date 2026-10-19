import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { withConsole } from './harness.js';

/**
 * What the scheduler writes, end to end: the captured catalog, and the
 * sampler's buckets under the tree. The unit
 * tests pin the rules.
 *
 * One console per block, several assertions inside it: starting a console
 * means a production build plus a container (see harness.ts).
 */

/** Poll until `fn` returns true, or fail with what was last seen. */
async function until(
  what: string,
  fn: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe('what the scheduler stores', () => {
  it('stores the catalog at boot, and samples the sessions', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      const store = new Client({ connectionString: url });
      await store.connect();
      try {
        // The scheduler captures once at boot, not only on the five-minute interval.
        await until('the capture to store the catalog', async () => {
          const { rows } = await store.query<{ n: string }>('SELECT count(*)::text AS n FROM pgops.captures WHERE ok');
          return Number(rows[0]!.n) === 3;
        });

        // The sampler ticks at boot too, and a visit to the tree is a sample
        // if its bucket is free: either way the clock has something to draw.
        expect((await fetch(`${baseUrl}/db/primary`)).status).toBe(200);
        await until('a sample bucket to be written', async () => {
          const { rows } = await store.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM pgops.sample_buckets',
          );
          return Number(rows[0]!.n) > 0;
        }, 30_000);
      } finally {
        await store.end().catch(() => {});
      }
      // The store is the monitored database here, so pgops's own schema shows
      // up in the checks it runs.
    }, (url) => ({ PGOPS_STORE_URL: url }));
  }, 300_000);

  /** A console with no store still draws the tree, and says how far back its clock goes. */
  it('holds fifteen minutes in memory when no store is configured, and says so on a wider window', async () => {
    await withConsole(async ({ baseUrl, sql }) => {
      // A table, so the tree is not the empty-database line.
      await sql('CREATE TABLE kept_in_memory (v int)');
      const live = await (await fetch(`${baseUrl}/db/primary`)).text();
      expect(live).toContain('nothing needs attention');
      expect(live).not.toContain('No store is configured');
      const hour = await (await fetch(`${baseUrl}/db/primary?win=3600`)).text();
      expect(hour).toContain('No store is configured');
    });
  }, 300_000);
});
