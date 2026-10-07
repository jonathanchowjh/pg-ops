import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { withConsole } from './harness.js';

async function until(what: string, fn: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The only test that runs the health feature the way it ships: a production
 * build, the real instrumentation hook, a real store. Everything else tests
 * a layer with the layers around it mocked, and until this existed nothing
 * would have noticed the boot wiring, the migration or either page failing
 * in a built console.
 */
describe('health over time, in a built console', () => {
  it('captures at boot, charts both pages, and stays out of the statement ranking', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      const store = new Client({ connectionString: url });
      await store.connect();
      try {
        await store.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
        await until('the boot tick to store a health row', async () => {
          const { rows } = await store.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM information_schema.tables
              WHERE table_schema = 'pgops' AND table_name = 'health_stats'`,
          );
          if (rows[0]!.n === '0') return false;
          const { rows: h } = await store.query<{ n: string }>('SELECT count(*)::text AS n FROM pgops.health_stats');
          return Number(h[0]!.n) > 0;
        });
        const { rows: first } = await store.query<{ connections: number | null; size_bytes: string | null }>(
          'SELECT connections, size_bytes FROM pgops.health_stats LIMIT 1',
        );
        expect(first[0]!.connections).toBeGreaterThan(0);
        expect(Number(first[0]!.size_bytes)).toBeGreaterThan(0);

        // One row is "collecting". A second, a minute older, makes a chart
        // without this test waiting a minute for the next tick.
        await store.query(
          `INSERT INTO pgops.health_stats (database_id, captured_at, connections, server_connections, max_connections, blocked)
           SELECT database_id, captured_at - interval '60 seconds', connections, server_connections, max_connections, blocked
             FROM pgops.health_stats LIMIT 1`,
        );

        const fleet = await fetch(`${baseUrl}/health`);
        expect(fleet.status).toBe(200);
        const fleetHtml = await fleet.text();
        expect(fleetHtml).toContain('href="/db/primary/health"');
        expect(fleetHtml).toContain('<svg');
        expect(fleetHtml).not.toContain('Collecting');

        const one = await fetch(`${baseUrl}/db/primary/health?window=6h`);
        expect(one.status).toBe(200);
        const html = await one.text();
        for (const heading of ['Sessions', 'Locks', 'Queries', 'Replication &amp; cleanup']) {
          expect(html, heading).toContain(`>${heading}</h2>`);
        }
        expect(html).toContain('<svg');
        expect(html).toContain('server-wide');

        // A URL nobody could mean still renders.
        expect((await fetch(`${baseUrl}/db/primary/health?from=banana&to=1`)).status).toBe(200);

        expect((await fetch(`${baseUrl}/db/primary/queries`)).status).toBe(200);
        expect((await fetch(`${baseUrl}/db/primary`)).status).toBe(200);

        // The pages above ran timed checks through the layout. None of the
        // transaction control pgops sent may be left bare in the ranking.
        const { rows: bare } = await store.query<{ query: string }>(
          `SELECT query FROM pg_stat_statements WHERE query ~* '^\\s*(BEGIN|COMMIT|ROLLBACK)\\s*$'`,
        );
        expect(bare).toEqual([]);
        // And the test is looking at a ranking that does hold pgops's marked ones.
        const { rows: marked } = await store.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_statements WHERE query ~* '^\\s*BEGIN\\s*/\\* pgops \\*/'`,
        );
        expect(Number(marked[0]!.n)).toBeGreaterThan(0);
      } finally {
        await store.end().catch(() => {});
      }
    }, (url) => ({ PGOPS_STORE_URL: url }));
  });
});
