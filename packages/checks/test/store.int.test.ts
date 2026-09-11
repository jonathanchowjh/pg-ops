import { describe, expect, it } from 'vitest';
import { migrate } from '../src/store/schema.js';
import { withAdvisoryLock } from '../src/store/lock.js';
import {
  RETENTION, insertQueryStats, insertSpaceStats, prune, upsertDatabase, upsertQueries,
} from '../src/store/write.js';
import { readQueryStats } from '../src/store/read.js';
import { withPostgres } from './harness.js';

describe('migrate', () => {
  it('creates the pgops schema and records the version', async () => {
    await withPostgres(async (_ctx, pool) => {
      const version = await migrate(pool);
      expect(version).toBe(1);

      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'pgops' ORDER BY table_name`,
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        'databases', 'queries', 'query_stats', 'schema_version', 'space_stats',
      ]);
    });
  });

  it('is idempotent — a second run is a no-op at the same version', async () => {
    await withPostgres(async (_ctx, pool) => {
      await migrate(pool);
      expect(await migrate(pool)).toBe(1);
    });
  });

  it('creates nothing outside the pgops schema', async () => {
    await withPostgres(async (_ctx, pool) => {
      // Baseline, not zero: withPostgres already ran `CREATE EXTENSION
      // pg_stat_statements` on this database (every other integration file
      // needs it queryable), which plants `pg_stat_statements` and
      // `pg_stat_statements_info` as views in `public` before this test
      // body ever runs. Asserting an absolute-zero count — as a first draft
      // of this test did — fails against every implementation, correct or
      // not, since it fails before `migrate` runs at all. Comparing before
      // vs. after isolates what THIS migration adds, which is the actual
      // thing under test.
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
        // this table's nine columns. Unchunked this is not slow, it is a hard
        // server-side rejection — and because captureOnce swallows it into one
        // stderr line, an operator who raised pg_stat_statements.max would
        // simply stop having history, with the page still rendering.
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
        // tenants x 100 tables reaches this with no tuning at all.
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

        // The queries page reads exactly this way: two captures, and only the
        // shapes it is about to render. Spec §5.1 — one indexed lookup, on a
        // page that polls at 5s.
        const bounded = await readQueryStats(client, 'prod', at(9), new Date(base),
          { maxSnapshots: 2, queryids: ['111'] });
        expect(bounded).toHaveLength(1);
        expect(bounded[0]!.queryid).toBe('111');
        expect(bounded[0]!.points).toHaveLength(2);

        // An empty shape list is not "no filter" — it is "nothing to ask about".
        expect(await readQueryStats(client, 'prod', at(9), new Date(base),
          { queryids: [] })).toEqual([]);
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

        // pgops.queries was the one growing table pruning never touched, and
        // the orphans were invisible because every read joins through
        // query_stats — which is exactly what made it silent.
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
        // Idempotent, and stable: a second pass must return the same ids or
        // every stored snapshot would point at a new shape row.
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
        // one statement touches the same row twice. Capture groups by queryid
        // so it cannot happen from there, but the guarantee belongs to the
        // function that depends on it.
        const ids = await upsertQueries(client, db, [
          { queryid: '7', query: 'SELECT a' },
          { queryid: '7', query: 'SELECT b' },
        ]);
        expect(ids.size).toBe(1);
      } finally { client.release(); }
    });
  });
});
