import { describe, expect, it } from 'vitest';
import { captureHygiene } from '../src/capture.js';
import { HYGIENE_CHECK_IDS, hygieneAreas } from '../src/checks/areas.js';
import { CAPTURE_LOCK_NS } from '../src/store/lock.js';
import { readCheckResults } from '../src/store/read.js';
import { migrate } from '../src/store/schema.js';
import { withPostgres } from './harness.js';

/**
 * The scheduler's third pass: run every hygiene check and cache what it
 * found, so the triage page can report a finding nobody has opened a page to
 * look for.
 *
 * It is deliberately NOT part of `captureOnce`'s transaction. That one holds
 * the store's write path open across two scans and a prune; adding 21 catalog
 * scans, each allowed ten seconds, would hold it open for minutes.
 */
describe('captureHygiene', () => {
  it('caches every hygiene check, and nothing else', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);

      const outcome = await captureHygiene({ ...ctx, store: pool }, 'prod');
      expect(outcome.ok).toBe(true);

      const stored = await readCheckResults(pool, 'prod');
      expect(stored.map((r) => r.checkId).sort()).toEqual([...HYGIENE_CHECK_IDS].sort());
    });
  });

  /**
   * The end the triage page actually reads: a real database, captured once,
   * rolled up into lines. Every check here succeeds against an empty schema,
   * so the areas are healthy rather than unknown — which is the assertion
   * worth making, since `unknown` is what a broken pass produces too.
   */
  it('produces areas the triage page can render', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await captureHygiene({ ...ctx, store: pool }, 'prod');

      const areas = hygieneAreas(await readCheckResults(pool, 'prod'), {
        now: new Date(), staleAfterMs: 10 * 60_000,
      });
      expect(areas.map((a) => a.id)).toEqual(['indexes', 'tables', 'sequences']);
      expect(areas.map((a) => a.level)).toEqual(['ok', 'ok', 'ok']);
    });
  });

  it('records a verdict a check actually reached', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      // An index nothing has ever read, on a table big enough to pass the
      // check's floor, is what `unusedIndexes` escalates on.
      await pool.query(`
        CREATE TABLE orders (id serial PRIMARY KEY, status text);
        INSERT INTO orders (status) SELECT 'new' FROM generate_series(1, 20000);
        CREATE INDEX orders_status_idx ON orders (status);
        ANALYZE orders;`);

      await captureHygiene({ ...ctx, store: pool }, 'prod');

      const stored = await readCheckResults(pool, 'prod');
      const unused = stored.find((r) => r.checkId === 'unusedIndexes')!;
      expect(unused.ok).toBe(true);
      expect(unused.level).not.toBeNull();
    });
  });

  /**
   * A second pass overwrites the first rather than accumulating history: the
   * question this cache answers is "what did the LAST pass find". The write
   * side is pinned in store.int.test.ts; this is the end-to-end shape of it.
   */
  it('overwrites the previous pass', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      const store = { ...ctx, store: pool };
      await captureHygiene(store, 'prod');
      const first = await readCheckResults(pool, 'prod');
      await captureHygiene(store, 'prod');
      const second = await readCheckResults(pool, 'prod');

      expect(second).toHaveLength(first.length);
      expect(second[0]!.capturedAt.getTime())
        .toBeGreaterThanOrEqual(first[0]!.capturedAt.getTime());
    });
  });

  it('reports missing-store rather than throwing when no store is configured', async () => {
    await withPostgres(async (ctx) => {
      expect(await captureHygiene(ctx, 'prod')).toMatchObject({ ok: false, reason: 'missing-store' });
    });
  });

  /**
   * Same rule as `captureOnce`: one replica per database per pass. Two
   * replicas running 21 catalog scans against the same database at the same
   * moment is exactly the load this console promises not to add.
   */
  it('skips rather than queues when another pass holds the lock', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await captureHygiene({ ...ctx, store: pool }, 'prod');

      const holder = await pool.connect();
      try {
        const { rows } = await holder.query<{ id: number }>(
          "SELECT id FROM pgops.databases WHERE name = 'prod'",
        );
        await holder.query('SELECT pg_try_advisory_lock($1, $2)', [CAPTURE_LOCK_NS, rows[0]!.id]);
        expect(await captureHygiene({ ...ctx, store: pool }, 'prod'))
          .toMatchObject({ ok: 'skipped', reason: 'locked' });
      } finally {
        await holder.query('SELECT pg_advisory_unlock_all()').catch(() => {});
        holder.release();
      }
    });
  });
});
