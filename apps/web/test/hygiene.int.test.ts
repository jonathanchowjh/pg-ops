import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { withConsole } from './harness.js';

/**
 * The hygiene roll-up, end to end, against a real console and a real store.
 *
 * The unit tests pin the rules; this pins the wiring nobody else touches —
 * the scheduler's hygiene pass, the cache, and the triage page reading it.
 * The thing it proves is the whole point of the phase: a finding an operator
 * never opened a page to look for appears on the page they do open.
 *
 * ONE console per block, several assertions inside it: starting a console
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

describe('hygiene findings reach the triage page', () => {
  it('caches the checks at boot, shows them with their age, and refreshes on a visit', async () => {
    await withConsole(async ({ baseUrl, url }) => {
      const store = new Client({ connectionString: url });
      await store.connect();
      try {
        // The scheduler captures once at boot rather than waiting out the
        // five-minute interval — which is exactly why this is testable.
        await until('the hygiene pass to fill the cache', async () => {
          const { rows } = await store.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM pgops.check_results',
          );
          return Number(rows[0]!.n) > 0;
        });

        const triage = await (await fetch(`${baseUrl}/db/primary`)).text();
        // The three areas that can escalate, and ONLY those. Space,
        // Maintenance and Settings judge nothing — every member reports a
        // reading — so a line for them would have to invent a verdict.
        expect(triage).toContain('Indexes');
        expect(triage).toContain('Tables');
        expect(triage).toContain('Sequences');
        expect(triage).not.toContain('/db/primary/cleanup/maintenance');
        // The age is what stops a cached reading claiming to be current.
        expect(triage).toMatch(/\d+[smh][^<]*ago/);

        // The line is a LINK into the page that explains it.
        expect(triage).toContain('/db/primary/queries/indexes');

        // Write-through: the page runs its checks on visit and writes what
        // it found, so the line and the page agree the moment anyone looks.
        const before = await capturedAt(store, 'indexHitRate');
        await new Promise((r) => setTimeout(r, 1_000));
        expect((await fetch(`${baseUrl}/db/primary/queries/indexes`)).status).toBe(200);
        await until('the page visit to refresh the cache', async () => (
          (await capturedAt(store, 'indexHitRate')) > before
        ), 20_000);
      } finally {
        await store.end().catch(() => {});
      }
      // The store IS the monitored database here, which is the documented
      // single-database dev setup — and the case where pgops's own schema
      // shows up in the checks it runs.
    }, (url) => ({ PGOPS_STORE_URL: url }));
  }, 300_000);

  /**
   * A console with no store still triages. It says so once, at the foot of
   * the page, naming the one variable that changes it — rather than drawing
   * grey rows that look like findings.
   */
  it('says history is off, once, when no store is configured', async () => {
    await withConsole(async ({ baseUrl }) => {
      const triage = await (await fetch(`${baseUrl}/db/primary`)).text();
      // Counted in the unit test, which reads rendered TEXT. This is raw
      // HTML: every string appears twice, once in the markup and once in the
      // RSC payload the page ships beside it.
      expect(triage).toContain('PGOPS_STORE_URL');
      // And the incident half is untouched: the bands still render.
      expect(triage).toContain('Sessions');
      expect(triage).toContain('Locks');
    });
  }, 300_000);
});

async function capturedAt(store: Client, checkId: string): Promise<number> {
  const { rows } = await store.query<{ at: Date }>(
    'SELECT captured_at AS at FROM pgops.check_results WHERE check_id = $1',
    [checkId],
  );
  return rows[0]?.at.getTime() ?? 0;
}
