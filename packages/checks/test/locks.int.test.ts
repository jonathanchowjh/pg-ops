import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { runCheck } from '../src/run.js';
import { locks, type LocksData } from '../src/checks/locks.js';
import type { Threshold } from '../src/types.js';
import { withPostgres } from './harness.js';

/**
 * Open a session that holds an advisory lock and keeps its transaction open.
 *
 * `clients` is pushed to before `connect()`/`BEGIN`/the lock query, any of
 * which can throw. A client that threw unregistered would leak a connection
 * and make the harness's `DROP DATABASE` fail on "database is being accessed
 * by other users".
 */
async function holder(uri: string, app: string, key: number, clients: pg.Client[]): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: uri, application_name: app });
  c.on('error', () => {});
  clients.push(c);
  await c.connect();
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock($1)', [key]);
  return c;
}

describe('locks', () => {
  it('does not name an unrelated advisory-lock holder as a blocker (A2)', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      const clients: pg.Client[] = [];
      try {
        await holder(uri, 'holder-key-1', 1, clients);   // innocent
        await holder(uri, 'holder-key-2', 2, clients);   // the real blocker
        const c = new pg.Client({ connectionString: uri, application_name: 'waiter-key-2' });
        c.on('error', () => {});
        clients.push(c);
        await c.connect();
        void c.query('BEGIN').then(() => c.query('SELECT pg_advisory_xact_lock($1)', [2])).catch(() => {});
        await new Promise((r) => setTimeout(r, 1500));

        const r = await runCheck(ctx, locks);
        if (!r.ok) throw new Error(r.message);
        const rootApps = r.data.roots.map((x) => x.app);
        expect(rootApps).toContain('holder-key-2');
        // A join key without classid/objid matches every advisory lock in the
        // database to every other one, and this name appears.
        expect(rootApps).not.toContain('holder-key-1');
      } finally {
        await Promise.all(clients.map((cl) => cl.end().catch(() => {})));
      }
    });
  }, 120_000);

  it('nests a queued blocker instead of flattening it (A2)', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      await pool.query('CREATE TABLE t (id int)');

      const clients: pg.Client[] = [];
      try {
        const reader = new pg.Client({ connectionString: uri, application_name: 'long-reader' });
        clients.push(reader);
        const migration = new pg.Client({ connectionString: uri, application_name: 'migration' });
        clients.push(migration);
        const tail = new pg.Client({ connectionString: uri, application_name: 'tail-reader' });
        clients.push(tail);
        for (const c of [reader, migration, tail]) { c.on('error', () => {}); await c.connect(); }

        await reader.query('BEGIN');
        await reader.query('SELECT count(*) FROM t');
        void migration.query('BEGIN').then(() => migration.query('LOCK TABLE t IN ACCESS EXCLUSIVE MODE')).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        void tail.query('BEGIN').then(() => tail.query('SELECT count(*) FROM t')).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));

        const r = await runCheck(ctx, locks);
        if (!r.ok) throw new Error(r.message);
        const root = r.data.roots.find((x) => x.app === 'long-reader');
        expect(root, 'long-reader should be the root').toBeDefined();
        // reader -> migration -> tail. Requiring the blocker's own lock to be
        // granted would flatten this to reader -> {migration, tail}.
        expect(root!.waiters).toHaveLength(1);
        expect(root!.waiters[0]!.app).toBe('migration');
        expect(root!.waiters[0]!.waiters[0]!.app).toBe('tail-reader');
        expect(root!.totalWaiters).toBe(2);
      } finally {
        await Promise.all(clients.map((cl) => cl.end().catch(() => {})));
      }
    });
  }, 120_000);

  /**
   * The fixture is a blocker whose transaction is already old, blocking a
   * session that has only just started waiting: the verdict must follow
   * `pg_locks.waitstart` (PG14+), not the blocker's transaction age.
   *
   * The shipped critical threshold is 60 seconds; `fast` runs the real
   * `verdict` against a scaled-down copy so the test takes seconds.
   *
   * `locks` reads pg_locks cluster-wide, so the graph is narrowed to this
   * fixture's own root before the verdict runs.
   */
  it('escalates on how long the waiter has waited, not on the blocker\'s transaction age (I3)', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      const clients: pg.Client[] = [];
      const fast: Threshold[] = [
        { level: 'warn', value: 1, unit: 'count',
          because: 'test-scaled copy of the shipped warn threshold: any waiter is worth seeing' },
        { level: 'critical', value: 3, unit: 'seconds',
          because: 'test-scaled copy of the shipped 60s critical threshold, in the same unit' },
      ];
      const mine = async (): Promise<LocksData | null> => {
        const r = await runCheck(ctx, locks);
        if (!r.ok) throw new Error(r.message);
        const root = r.data.roots.find((x) => x.app === 'i3-blocker');
        return root ? { roots: [root], truncated: r.data.truncated } : null;
      };

      try {
        await holder(uri, 'i3-blocker', 77, clients);
        // The blocker's transaction gets older than the scaled critical
        // threshold before anything waits on it.
        await new Promise((r) => setTimeout(r, 3600));

        const waiter = new pg.Client({ connectionString: uri, application_name: 'i3-waiter' });
        waiter.on('error', () => {});
        clients.push(waiter);
        await waiter.connect();
        void waiter.query('BEGIN')
          .then(() => waiter.query('SELECT pg_advisory_xact_lock($1)', [77]))
          .catch(() => {});

        let d: LocksData | null = null;
        for (let i = 0; i < 12 && !d?.roots[0]?.waiters.length; i += 1) {
          await new Promise((r) => setTimeout(r, 150));
          d = await mine();
        }
        expect(d?.roots[0]?.waiters.length, 'the waiter should register as blocked').toBeGreaterThan(0);

        const root = d!.roots[0]!;
        const waiterNode = root.waiters[0]!;
        // The two quantities must differ here for the verdict assertion to
        // mean anything.
        expect(root.xactAgeSecs!).toBeGreaterThan(fast[1]!.value);
        // A root blocker is not waiting on anything, so it has no waitstart.
        expect(root.waitSecs).toBeNull();
        expect(waiterNode.waitSecs).not.toBeNull();
        expect(waiterNode.waitSecs!).toBeLessThan(fast[1]!.value);
        // Escalating on the blocker's transaction age would report critical.
        expect(locks.verdict!(d!, fast).level).toBe('warn');

        // Let the wait itself grow past the same threshold.
        await new Promise((r) => setTimeout(r, 3400));
        const later = await mine();
        expect(later!.roots[0]!.waiters[0]!.waitSecs!).toBeGreaterThanOrEqual(fast[1]!.value);
        expect(locks.verdict!(later!, fast).level).toBe('critical');
      } finally {
        await Promise.all(clients.map((cl) => cl.end().catch(() => {})));
      }
    });
  }, 120_000);
});
