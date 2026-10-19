import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { CURRENT_VERSION, migrate } from '../src/store/schema.js';
import { SQL as M003 } from '../src/store/migrations/003-check-results.js';
import { SQL as M007 } from '../src/store/migrations/007-captured.js';
import { SQL as M008 } from '../src/store/migrations/008-drop-check-results.js';
import { HEALTH_LOCK_NS, releaseCaptureLock, tryCaptureLock, withAdvisoryLock } from '../src/store/lock.js';
import {
  HEALTH_COLUMNS, RETENTION, healthIsFresh, insertHealth, insertQueryLoad, insertQueryStats, insertSpaceStats, prune,
  upsertDatabase, upsertQueries, type HealthRow,
} from '../src/store/write.js';
import {
  readQueryStats, readRelationSpace, readSpaceGrowth, readWindowStats,
} from '../src/store/read.js';
import { withPostgres } from './harness.js';

/**
 * A migrated store and a checked-out client, released whatever happens. The
 * store writers take a `PoolClient`, not a `Pool`.
 */
async function withStore(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  await withPostgres(async (_ctx, pool) => {
    await migrate(pool);
    const client = await pool.connect();
    try {
      await fn(client);
    } finally {
      client.release();
    }
  });
}

describe('migrate', () => {
  it('creates the pgops schema and records the version', async () => {
    await withPostgres(async (_ctx, pool) => {
      const version = await migrate(pool);
      expect(version).toBe(CURRENT_VERSION);

      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'pgops' ORDER BY table_name`,
      );
      // Spelt out rather than derived: a migration that changes the inventory
      // should have to edit this list.
      expect(rows.map((r) => r.table_name)).toEqual([
        'captured', 'captures', 'databases', 'events', 'health_stats', 'index_hours', 'load_minutes',
        'queries', 'query_load', 'query_stats', 'sample_buckets', 'sample_statements', 'schema_version',
        'session_samples', 'space_stats', 'table_hours',
      ]);
    });
  });

  it('is idempotent — a second run is a no-op at the same version', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      expect(await migrate(pool)).toBe(CURRENT_VERSION);
    });
  });

  it('creates nothing outside the pgops schema', async () => {
    await withPostgres(async (_ctx, pool) => {
      // Baseline, not zero: withPostgres already ran `CREATE EXTENSION
      // pg_stat_statements`, which plants views in `public`.
      const before = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables
          WHERE table_schema = 'public'`,
      );
      await migrate(pool);
      const after = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables
          WHERE table_schema = 'public'`,
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    });
  });
});

/**
 * A store already at an older version gets brought forward. Staged by
 * rewinding a real store: dropping what migration 002 added and setting the
 * recorded version back to 1.
 */
describe('migrate, forward from an older store', () => {
  it('applies a migration a store has not seen yet', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);

      const indexed = async (): Promise<boolean> => {
        const { rows } = await pool.query<{ present: string | null }>(
          `SELECT to_regclass('pgops.query_stats_query_id_idx')::text AS present`,
        );
        return rows[0]!.present !== null;
      };
      expect(await indexed()).toBe(true);

      // Rewind to a version-1 store.
      await pool.query('DROP INDEX pgops.query_stats_query_id_idx');
      await pool.query('UPDATE pgops.schema_version SET version = 1');
      expect(await indexed()).toBe(false);

      expect(await migrate(pool)).toBe(CURRENT_VERSION);
      expect(await indexed()).toBe(true);
    });
  });

  it('brings a version-6 store forward with its rows kept, and 007 a second time changes nothing', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      // Rewind to a version-6 store that has been in use.
      await pool.query('DROP TABLE pgops.captured, pgops.captures, pgops.table_hours, pgops.index_hours');
      await pool.query('UPDATE pgops.schema_version SET version = 6');
      await pool.query("INSERT INTO pgops.databases (name) VALUES ('prod')");
      await pool.query(
        "INSERT INTO pgops.events (database_id, at, kind) SELECT id, now(), 'reset' FROM pgops.databases",
      );

      expect(await migrate(pool)).toBe(CURRENT_VERSION);
      const shape = async (): Promise<string[]> => (await pool.query<{ d: string }>(
        `SELECT c.relname || ' ' || pg_get_constraintdef(k.oid) AS d
           FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
          WHERE c.relname IN ('captures', 'captured', 'table_hours', 'index_hours')
            AND c.relnamespace = 'pgops'::regnamespace
         UNION ALL
         SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relname IN ('captures', 'captured', 'table_hours', 'index_hours')
            AND c.relnamespace = 'pgops'::regnamespace AND a.attnum > 0
          ORDER BY 1`,
      )).rows.map((r) => r.d);
      const before = await shape();
      expect(before.filter((d) => / PRIMARY KEY /.test(d))).toHaveLength(4);

      await pool.query(M007);
      expect(await shape()).toEqual(before);
      const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM pgops.events');
      expect(rows[0]!.n).toBe('1');
    });
  });

  it('drops the old findings table from a version-7 store that holds rows, and 008 a second time changes nothing', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      // Rewind to a version-7 store in use: the table as 003 made it, a row in it.
      await pool.query(M003);
      await pool.query('UPDATE pgops.schema_version SET version = 7');
      await pool.query("INSERT INTO pgops.databases (name) VALUES ('prod')");
      await pool.query(
        `INSERT INTO pgops.check_results (database_id, check_id, captured_at, ok)
         SELECT id, 'unusedIndexes', now(), true FROM pgops.databases`,
      );

      expect(await migrate(pool)).toBe(CURRENT_VERSION);
      const present = async (): Promise<string | null> => (await pool.query<{ present: string | null }>(
        `SELECT to_regclass('pgops.check_results')::text AS present`)).rows[0]!.present;
      expect(await present()).toBeNull();
      // The database it cascaded from is kept.
      const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM pgops.databases');
      expect(rows[0]!.n).toBe('1');

      await pool.query(M008);
      expect(await present()).toBeNull();
    });
  });

  it('migrates under a pool whose bounds are a page\'s, and hands the client back with them', async () => {
    await withPostgres(async (_ctx, pool) => {
      const bounded = new Pool({ connectionString: pool.options.connectionString, max: 1, statement_timeout: 1, lock_timeout: 1 });
      try {
        expect(await migrate(bounded)).toBe(CURRENT_VERSION);
        const { rows } = await bounded.query<{ statement_timeout: string }>('SHOW statement_timeout');
        expect(rows[0]!.statement_timeout).toBe('1ms');
      } finally {
        await bounded.end();
      }
    });
  });

  it('deletes the statement texts a version-8 store kept with their literals, and keeps the samples', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      await pool.query('UPDATE pgops.schema_version SET version = 8');
      await pool.query("INSERT INTO pgops.databases (name) VALUES ('prod')");
      await pool.query(
        `INSERT INTO pgops.sample_statements (database_id, key, query, relations)
         SELECT id, 't1', 'SELECT * FROM u WHERE email = ''jo@x.com''', '{}' FROM pgops.databases`,
      );
      await pool.query(
        `INSERT INTO pgops.sample_buckets (database_id, bucket, hidden, truncated)
         SELECT id, to_timestamp(0), false, false FROM pgops.databases`,
      );
      expect(await migrate(pool)).toBe(CURRENT_VERSION);
      const count = async (table: string): Promise<string> =>
        (await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM pgops.${table}`)).rows[0]!.n;
      expect(await count('sample_statements')).toBe('0');
      expect(await count('sample_buckets')).toBe('1');
    });
  });

  /**
   * `query_stats.query_id` carries an ON DELETE CASCADE foreign key, and
   * `prune`'s orphan sweep anti-joins on it. Neither the primary key nor
   * query_stats_captured_at_idx leads with query_id, so without this index
   * the FK check is one sequential scan per deleted row.
   */
  it('gives the cascading foreign key an index to use', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'pgops' AND tablename = 'query_stats'
          ORDER BY indexname`,
      );
      expect(rows.some((r) => /\(query_id\)/.test(r.indexdef))).toBe(true);
    });
  });
});

describe('withAdvisoryLock', () => {
  it('runs the body and releases the lock', async () => {
    await withPostgres(async (_ctx, pool) => {
      const ran = await withAdvisoryLock(pool, 42, async () => 'ran');
      expect(ran).toBe('ran');
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory'`,
      );
      expect(rows[0]!.n).toBe('0');
    });
  });

  it('releases the lock when the body throws', async () => {
    await withPostgres(async (_ctx, pool) => {
      await expect(withAdvisoryLock(pool, 43, async () => { throw new Error('boom'); }))
        .rejects.toThrow('boom');
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory'`,
      );
      expect(rows[0]!.n).toBe('0');
    });
  });
});

describe('store writes', () => {
  it('upserts a database once and returns a stable id', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const a = await upsertDatabase(client, 'prod');
        const b = await upsertDatabase(client, 'prod');
        expect(b).toBe(a);
      } finally { client.release(); }
    });
  });

  it('stores query text once per shape and advances last_seen', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const db = await upsertDatabase(client, 'prod');
        const a = (await upsertQueries(client, db, [{ queryid: '123', query: 'SELECT 1' }])).get('123')!;
        const b = (await upsertQueries(client, db, [{ queryid: '123', query: 'SELECT 1' }])).get('123')!;
        expect(b).toBe(a);
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pgops.queries`,
        );
        expect(rows[0]!.n).toBe('1');
      } finally { client.release(); }
    });
  });

  it('prunes query_stats past the retention window in the same call', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const db = await upsertDatabase(client, 'prod');
        const q = (await upsertQueries(client, db, [{ queryid: '123', query: 'SELECT 1' }])).get('123')!;
        const old = new Date(Date.now() - (RETENTION.queryStatsDays + 1) * 86_400_000);
        const now = new Date();
        await insertQueryStats(client, [
          { databaseId: db, queryId: q, capturedAt: old, calls: 1, totalExecTime: 1,
            rows: 1, sharedBlksHit: 1, sharedBlksRead: 0, statsReset: null },
          { databaseId: db, queryId: q, capturedAt: now, calls: 2, totalExecTime: 2,
            rows: 2, sharedBlksHit: 2, sharedBlksRead: 0, statsReset: null },
        ]);
        await prune(client, db, RETENTION);
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pgops.query_stats`,
        );
        expect(rows[0]!.n).toBe('1');
      } finally { client.release(); }
    });
  });
});

describe('store writes at scale', () => {
  it('stores more shapes than one Bind can carry', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const db = await upsertDatabase(client, 'prod');
        const q = (await upsertQueries(client, db, [{ queryid: '123', query: 'SELECT 1' }])).get('123')!;
        // 8,000 > 65,535/9 = 7,281, the wire protocol's parameter ceiling for
        // this table's nine columns. Unchunked, the server rejects the insert.
        const rows = Array.from({ length: 8_000 }, (_, i) => ({
          databaseId: db, queryId: q, capturedAt: new Date(Date.now() - i * 1_000),
          calls: i, totalExecTime: i, rows: i, sharedBlksHit: i, sharedBlksRead: 0,
          statsReset: null,
        }));
        await insertQueryStats(client, rows);
        const { rows: n } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pgops.query_stats`,
        );
        expect(n[0]!.n).toBe('8000');
      } finally { client.release(); }
    });
  });

  it('stores more relations than one Bind can carry', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const db = await upsertDatabase(client, 'prod');
        // 20,000 > 65,535/4 = 16,383. A schema-per-tenant database with 200
        // tenants x 100 tables reaches this.
        const at = new Date();
        await insertSpaceStats(client, Array.from({ length: 20_000 }, (_, i) => ({
          databaseId: db, relation: `public.t${i}`, capturedAt: at, sizeBytes: i,
        })));
        const { rows: n } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pgops.space_stats`,
        );
        expect(n[0]!.n).toBe('20000');
      } finally { client.release(); }
    });
  });
});

describe('readQueryStats bounds', () => {
  it('returns only the N most recent captures, and only the shapes asked for', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const db = await upsertDatabase(client, 'prod');
        const a = (await upsertQueries(client, db, [{ queryid: '111', query: 'SELECT a' }])).get('111')!;
        const b = (await upsertQueries(client, db, [{ queryid: '222', query: 'SELECT b' }])).get('222')!;
        const base = Date.now();
        const at = (i: number) => new Date(base - i * 60_000);
        await insertQueryStats(client, [0, 1, 2, 3].flatMap((i) =>
          [a, b].map((queryId) => ({
            databaseId: db, queryId, capturedAt: at(i), calls: 10 * (4 - i),
            totalExecTime: 1, rows: 1, sharedBlksHit: 1, sharedBlksRead: 0,
            statsReset: null,
          }))));

        const all = await readQueryStats(client, 'prod', at(9), new Date(base));
        expect(all).toHaveLength(2);
        expect(all[0]!.points).toHaveLength(4);

        // The queries page reads this way: two captures, and only the shapes
        // it is about to render.
        const bounded = await readQueryStats(client, 'prod', at(9), new Date(base),
          { maxSnapshots: 2, queryids: ['111'] });
        expect(bounded).toHaveLength(1);
        expect(bounded[0]!.queryid).toBe('111');
        expect(bounded[0]!.points).toHaveLength(2);

        // An empty shape list means "nothing to ask about", not "no filter".
        expect(await readQueryStats(client, 'prod', at(9), new Date(base),
          { queryids: [] })).toEqual([]);
      } finally { client.release(); }
    });
  });
});

describe('readWindowStats', () => {
  const at = (min: number) => new Date(Date.parse('2026-10-12T08:00:00Z') + min * 60_000);

  it('returns each shape\'s own first and last capture in the window, costliest first', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const db = await upsertDatabase(client, 'prod');
        const ids = await upsertQueries(client, db, [
          { queryid: '1', query: 'SELECT busy' }, { queryid: '2', query: 'SELECT idle' },
          { queryid: '3', query: 'SELECT ours /* pgops */' }, { queryid: '4', query: 'SELECT late' },
          { queryid: '5', query: 'SELECT new' }, { queryid: '6', query: 'SELECT gone' },
        ]);
        const snap = (q: string, min: number, calls: number, ms: number) => ({
          databaseId: db, queryId: ids.get(q)!, capturedAt: at(min), calls, totalExecTime: ms,
          rows: calls, sharedBlksHit: calls, sharedBlksRead: 0, statsReset: null,
        });
        await insertQueryStats(client, [
          snap('1', 0, 10, 100), snap('1', 5, 20, 150), snap('1', 10, 40, 400),
          snap('2', 0, 7, 70), snap('2', 5, 7, 70), snap('2', 10, 7, 70),
          snap('3', 0, 1, 1), snap('3', 10, 9, 900),
          // In one capture only: a counter of unknown age, not an interval.
          snap('4', 10, 50, 500),
          // First run mid-window: an interval from its own first capture to the last.
          snap('5', 5, 3, 30), snap('5', 10, 33, 330),
          // Stopped mid-window: an interval up to its own last capture.
          snap('6', 0, 1, 10), snap('6', 5, 6, 60),
        ]);
        await insertQueryLoad(client, db, at(0), { totalExecTime: 999, calls: 1 });
        await insertQueryLoad(client, db, at(5), { totalExecTime: 50, calls: 10 });
        await insertQueryLoad(client, db, at(10), { totalExecTime: 1149, calls: 28 });

        const read = await readWindowStats(client, 'prod', at(-1), at(11), { limit: 10, notLike: '%/* pgops */' });
        expect(read.shapes.map((s) => [s.queryid, s.points.map((p) => p.calls)])).toEqual([
          ['1', [10, 40]], ['5', [3, 33]], ['6', [1, 6]],
        ]);
        // The load rows after the first capture, up to the last: 50 + 1149.
        expect(read.allMs).toBeCloseTo(1199);

        const all = await readWindowStats(client, 'prod', at(-1), at(11), { limit: 1 });
        expect(all.shapes.map((s) => s.queryid)).toEqual(['3']);
        const one = await readWindowStats(client, 'prod', at(-1), at(11), { limit: 10, queryids: ['3'] });
        expect(one.shapes.map((s) => s.queryid)).toEqual(['3']);
      } finally { client.release(); }
    });
  });

  it('holds nothing for a window with one capture, or a database never seen', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const db = await upsertDatabase(client, 'prod');
        const id = (await upsertQueries(client, db, [{ queryid: '1', query: 'SELECT 1' }])).get('1')!;
        await insertQueryStats(client, [{
          databaseId: db, queryId: id, capturedAt: at(0), calls: 1, totalExecTime: 1,
          rows: 1, sharedBlksHit: 1, sharedBlksRead: 0, statsReset: null,
        }]);
        expect(await readWindowStats(client, 'prod', at(-1), at(1), { limit: 10 })).toEqual({ shapes: [], allMs: null });
        expect(await readWindowStats(client, 'nobody', at(-1), at(1), { limit: 10 })).toEqual({ shapes: [], allMs: null });
      } finally { client.release(); }
    });
  });
});

describe('prune, and the third growing table', () => {
  it('deletes a shape whose every snapshot has aged out', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const db = await upsertDatabase(client, 'prod');
        const ids = await upsertQueries(client, db, [
          { queryid: '111', query: 'SELECT gone' },
          { queryid: '222', query: 'SELECT stays' },
        ]);
        const old = new Date(Date.now() - (RETENTION.queryStatsDays + 1) * 86_400_000);
        await insertQueryStats(client, [
          { databaseId: db, queryId: ids.get('111')!, capturedAt: old, calls: 1,
            totalExecTime: 1, rows: 1, sharedBlksHit: 1, sharedBlksRead: 0, statsReset: null },
          { databaseId: db, queryId: ids.get('222')!, capturedAt: new Date(), calls: 1,
            totalExecTime: 1, rows: 1, sharedBlksHit: 1, sharedBlksRead: 0, statsReset: null },
        ]);
        await prune(client, db, RETENTION);

        // Orphans in pgops.queries are invisible to every read, which joins
        // through query_stats, so the table is checked directly.
        const { rows } = await client.query<{ query: string }>(
          `SELECT query FROM pgops.queries ORDER BY query`,
        );
        expect(rows.map((r) => r.query)).toEqual(['SELECT stays']);
      } finally { client.release(); }
    });
  });
});

describe('upsertQueries', () => {
  it('returns an id for every shape in ONE round trip', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const db = await upsertDatabase(client, 'prod');
        const shapes = Array.from({ length: 2_500 }, (_, i) => ({
          queryid: String(i + 1), query: `SELECT ${i}`,
        }));
        const ids = await upsertQueries(client, db, shapes);
        expect(ids.size).toBe(2_500);
        // A second pass must return the same ids, or every stored snapshot
        // would point at a new shape row.
        const again = await upsertQueries(client, db, shapes);
        expect([...again]).toEqual([...ids]);
      } finally { client.release(); }
    });
  });

  it('tolerates a duplicated queryid in its input', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const db = await upsertDatabase(client, 'prod');
        // ON CONFLICT DO UPDATE raises "cannot affect row a second time" when
        // one statement touches the same row twice.
        const ids = await upsertQueries(client, db, [
          { queryid: '7', query: 'SELECT a' },
          { queryid: '7', query: 'SELECT b' },
        ]);
        expect(ids.size).toBe(1);
      } finally { client.release(); }
    });
  });
});

describe('readSpaceGrowth', () => {
  it('reports growth between the first and last capture in the window, per relation', async () => {
    await withStore(async (store) => {
      const dbId = await upsertDatabase(store, 'growthdb');
      const t0 = new Date('2026-09-01T00:00:00Z');
      const t1 = new Date('2026-09-04T00:00:00Z');
      const t2 = new Date('2026-09-07T00:00:00Z');
      await insertSpaceStats(store, [
        { databaseId: dbId, relation: 'public.grew',   capturedAt: t0, sizeBytes: 1_000 },
        { databaseId: dbId, relation: 'public.grew',   capturedAt: t1, sizeBytes: 4_000 },
        { databaseId: dbId, relation: 'public.grew',   capturedAt: t2, sizeBytes: 9_000 },
        { databaseId: dbId, relation: 'public.shrank', capturedAt: t0, sizeBytes: 8_000 },
        { databaseId: dbId, relation: 'public.shrank', capturedAt: t2, sizeBytes: 2_000 },
        { databaseId: dbId, relation: 'public.once',   capturedAt: t2, sizeBytes: 500 },
      ]);

      const rows = await readSpaceGrowth(store, 'growthdb', t0, t2);
      const by = new Map(rows.map((r) => [r.relation, r]));

      expect(by.get('public.grew')).toMatchObject({
        firstBytes: 1_000, lastBytes: 9_000, points: 3,
      });
      expect(by.get('public.shrank')).toMatchObject({
        firstBytes: 8_000, lastBytes: 2_000, points: 2,
      });
      // One capture is not zero growth; `points: 1` is what lets the page say
      // "not enough history".
      expect(by.get('public.once')).toMatchObject({
        firstBytes: 500, lastBytes: 500, points: 1,
      });
      // The fastest-growing relation leads.
      expect(rows[0]!.relation).toBe('public.grew');
    });
  });

  it('excludes captures outside the window rather than clamping to it', async () => {
    await withStore(async (store) => {
      const dbId = await upsertDatabase(store, 'windowdb');
      const before = new Date('2026-08-01T00:00:00Z');
      const from = new Date('2026-09-01T00:00:00Z');
      const to = new Date('2026-09-07T00:00:00Z');
      await insertSpaceStats(store, [
        { databaseId: dbId, relation: 'public.t', capturedAt: before, sizeBytes: 1 },
        { databaseId: dbId, relation: 'public.t', capturedAt: from,   sizeBytes: 100 },
        { databaseId: dbId, relation: 'public.t', capturedAt: to,     sizeBytes: 300 },
      ]);

      const rows = await readSpaceGrowth(store, 'windowdb', from, to);

      // firstBytes 100, not 1: a reader that ignored `from` would start from
      // the August capture.
      expect(rows).toHaveLength(1);
      expect(rows[0]!).toMatchObject({ firstBytes: 100, lastBytes: 300, points: 2 });
    });
  });

  it('reads only the database it was asked for', async () => {
    await withStore(async (store) => {
      const mine = await upsertDatabase(store, 'mine');
      const other = await upsertDatabase(store, 'other');
      const earlier = new Date('2026-08-30T00:00:00Z');
      const at = new Date('2026-09-01T00:00:00Z');
      await insertSpaceStats(store, [
        { databaseId: mine,  relation: 'public.t', capturedAt: at,      sizeBytes: 10 },
        // The other database shares the relation name and captures it at a
        // different instant. With same-instant fixtures a bounds aggregate
        // that forgot to filter by database returns the same min and max;
        // staggered, it reports first_at = 2026-08-30, where our database
        // has no capture, and `public.t` disappears from the result.
        { databaseId: other, relation: 'public.t', capturedAt: earlier, sizeBytes: 999 },
        { databaseId: other, relation: 'public.t', capturedAt: at,      sizeBytes: 999 },
      ]);

      const rows = await readSpaceGrowth(store, 'mine', earlier, at);

      expect(rows).toHaveLength(1);
      expect(rows[0]!).toMatchObject({ lastBytes: 10, points: 1 });
    });
  });
});

describe('readRelationSpace', () => {
  it('reads one relation\u2019s sizes in order, oldest first', async () => {
    await withStore(async (store) => {
      const dbId = await upsertDatabase(store, 'relspace');
      const t = (d: number) => new Date(`2026-09-0${d}T00:00:00Z`);
      await insertSpaceStats(store, [
        { databaseId: dbId, relation: 'public.t', capturedAt: t(3), sizeBytes: 300 },
        { databaseId: dbId, relation: 'public.t', capturedAt: t(1), sizeBytes: 100 },
        { databaseId: dbId, relation: 'public.t', capturedAt: t(2), sizeBytes: 200 },
        { databaseId: dbId, relation: 'public.other', capturedAt: t(1), sizeBytes: 999 },
      ]);

      const points = await readRelationSpace(store, 'relspace', 'public.t', t(1), t(3));

      expect(points.map((p) => p.sizeBytes)).toEqual([100, 200, 300]);
    });
  });

  /**
   * Thirty days at a five-minute cadence is 8,640 points for one relation.
   * The most recent points are the ones kept.
   */
  it('keeps the most recent N points when the caller bounds the read', async () => {
    await withStore(async (store) => {
      const dbId = await upsertDatabase(store, 'boundspace');
      const base = Date.parse('2026-09-01T00:00:00Z');
      await insertSpaceStats(store, Array.from({ length: 10 }, (_, i) => ({
        databaseId: dbId, relation: 'public.t',
        capturedAt: new Date(base + i * 60_000), sizeBytes: i,
      })));

      const points = await readRelationSpace(
        store, 'boundspace', 'public.t',
        new Date(base), new Date(base + 10 * 60_000), { maxPoints: 3 });

      expect(points.map((p) => p.sizeBytes)).toEqual([7, 8, 9]);
    });
  });
});

function blankHealth(over: Partial<HealthRow> = {}): HealthRow {
  const row = Object.fromEntries(HEALTH_COLUMNS.map((c) => [c, null])) as HealthRow;
  return { ...row, ...over };
}

describe('health_stats', () => {
  it('stores a row whose every column is null, because null is not zero', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const id = await upsertDatabase(client, 'prod');
        await insertHealth(client, id, blankHealth(), RETENTION.healthStatsDays);
        const { rows } = await client.query(
          'SELECT connections, xact_commit, wal_bytes FROM pgops.health_stats WHERE database_id = $1', [id]);
        expect(rows).toEqual([{ connections: null, xact_commit: null, wal_bytes: null }]);
      } finally {
        client.release();
      }
    });
  });

  it('keeps a counter larger than a 32-bit integer', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const id = await upsertDatabase(client, 'prod');
        await insertHealth(client, id,
          blankHealth({ xact_commit: '9000000000', wal_bytes: '123456789012345678901' }),
          RETENTION.healthStatsDays);
        const { rows } = await client.query<{ c: string; w: string }>(
          'SELECT xact_commit::text AS c, wal_bytes::text AS w FROM pgops.health_stats WHERE database_id = $1', [id]);
        expect(rows[0]).toEqual({ c: '9000000000', w: '123456789012345678901' });
      } finally {
        client.release();
      }
    });
  });

  it('prunes rows past retention in the same call that inserts', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const id = await upsertDatabase(client, 'prod');
        await client.query(
          `INSERT INTO pgops.health_stats (database_id, captured_at, blocked)
           VALUES ($1, now() - interval '91 days', 1), ($1, now() - interval '89 days', 2)`, [id]);
        await insertHealth(client, id, blankHealth({ blocked: 3 }), 90);
        const { rows } = await client.query<{ blocked: number }>(
          'SELECT blocked FROM pgops.health_stats WHERE database_id = $1 ORDER BY captured_at', [id]);
        expect(rows.map((r) => r.blocked)).toEqual([2, 3]);
      } finally {
        client.release();
      }
    });
  });

  it('calls a row fresh for 45 seconds and not after', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const client = await pool.connect();
      try {
        const id = await upsertDatabase(client, 'prod');
        expect(await healthIsFresh(client, id)).toBe(false);
        await client.query(
          `INSERT INTO pgops.health_stats (database_id, captured_at) VALUES ($1, now() - interval '50 seconds')`, [id]);
        expect(await healthIsFresh(client, id)).toBe(false);
        await client.query(
          `INSERT INTO pgops.health_stats (database_id, captured_at) VALUES ($1, now() - interval '40 seconds')`, [id]);
        expect(await healthIsFresh(client, id)).toBe(true);
      } finally {
        client.release();
      }
    });
  });

  it('locks health apart from capture, so neither tick starves the other', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        const id = await upsertDatabase(a, 'prod');
        expect(await tryCaptureLock(a, id)).toBe(true);                    // capture namespace
        expect(await tryCaptureLock(b, id, HEALTH_LOCK_NS)).toBe(true);    // health namespace: still free
        const c = await pool.connect();
        try {
          expect(await tryCaptureLock(c, id, HEALTH_LOCK_NS)).toBe(false); // health is held by b
          expect(await tryCaptureLock(c, id)).toBe(false);                 // capture is held by a
        } finally {
          c.release();
        }
        await releaseCaptureLock(a, id);
        await releaseCaptureLock(b, id, HEALTH_LOCK_NS);
      } finally {
        a.release();
        b.release();
      }
    });
  });
});
