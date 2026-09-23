import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { CURRENT_VERSION, migrate } from '../src/store/schema.js';
import { withAdvisoryLock } from '../src/store/lock.js';
import {
  RETENTION, insertQueryStats, insertSpaceStats, prune, recordCheckResults, upsertDatabase,
  upsertQueries,
} from '../src/store/write.js';
import {
  readCheckResults, readQueryStats, readRelationSpace, readSpaceGrowth,
} from '../src/store/read.js';
import { withPostgres } from './harness.js';

/**
 * A migrated store and a checked-out client, released whatever happens.
 *
 * `upsertDatabase`, `insertSpaceStats` and the rest take a `PoolClient`, not a
 * `Pool` — they are written to run inside one transaction — so every test that
 * writes needs this same four-line preamble. It was already repeated five
 * times before P4 added three more.
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
      // `CURRENT_VERSION`, not a literal: the assertion worth making is
      // "migrate brings the store to the version this build knows how to
      // produce". A literal only restates MIGRATIONS.length, and has to be
      // hand-edited by every migration that lands — which is a step someone
      // forgets, on the one test that would otherwise notice.
      const version = await migrate(pool);
      expect(version).toBe(CURRENT_VERSION);

      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'pgops' ORDER BY table_name`,
      );
      // Spelt out rather than derived, deliberately: this is the inventory a
      // migration is supposed to change, so it should be edited by whoever
      // changes it and read by whoever reviews that.
      expect(rows.map((r) => r.table_name)).toEqual([
        'check_results', 'databases', 'queries', 'query_load', 'query_stats',
        'schema_version', 'space_stats',
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

/**
 * The property the runner was written for and nothing exercised, because for
 * two phases there was only ever one migration: a store ALREADY at an older
 * version gets brought forward. `migrate` is called on every dev-server
 * restart and on every replica boot, so the path that matters most in
 * production — "this store is at N, this build is at N+1" — was the one path
 * with no test at all.
 *
 * Rewinding a real store is the only honest way to stage it: dropping what
 * 002 added and setting the recorded version back to 1 IS a version-1 store,
 * where reconstructing one by hand would test a fixture instead.
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

  /**
   * The index is not cosmetic and this records why, so a later change cannot
   * drop it as redundant-looking next to the primary key.
   *
   * `query_stats.query_id` carries an ON DELETE CASCADE foreign key, and
   * `prune`'s orphan sweep over `pgops.queries` anti-joins on it. Neither the
   * PK (database_id, query_id, captured_at) nor
   * query_stats_captured_at_idx (database_id, captured_at DESC) leads with
   * query_id, so before 002 the FK check was one sequential scan PER DELETED
   * ROW: measured at 1,297ms of trigger time to remove 100 orphans from a
   * 290,000-row table, against 0.47ms with the index — inside the
   * transaction capture holds open, every five minutes.
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
      // A relation that shrank is a real reading, not an error and not zero.
      expect(by.get('public.shrank')).toMatchObject({
        firstBytes: 8_000, lastBytes: 2_000, points: 2,
      });
      // One capture is NOT zero growth -- the page has to say "not enough
      // history" rather than draw a flat line through a single point.
      expect(by.get('public.once')).toMatchObject({
        firstBytes: 500, lastBytes: 500, points: 1,
      });
      // The fastest-growing relation leads: the list carries no cap, so
      // ordering is the only thing that puts the relation an operator came
      // for at the top.
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

      // firstBytes 100, not 1: the August capture is outside the window and a
      // reader that ignored `from` would report 299 bytes of growth as 1 -> 300.
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
        // The other database shares the relation name AND captures it at a
        // DIFFERENT instant. Same-instant fixtures cannot catch a bounds
        // aggregate that forgot to filter by database: min, max and count
        // all come back unchanged, and the outer join still lands on our
        // row. Staggering them means an unfiltered aggregate reports
        // first_at = 2026-08-30, which OUR database has no capture at, so
        // `public.t` disappears from the result entirely.
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
   * §5.1. Thirty days at a five-minute cadence is 8,640 points for ONE
   * relation. The bound is what makes the detail page a chart rather than a
   * download, and the MOST RECENT points are the ones kept -- a chart truncated
   * from the wrong end shows the history and hides the present.
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

/**
 * The hygiene cache: one row per check per database, overwritten each pass.
 *
 * Unlike query_stats and space_stats this keeps NO history — nothing reads a
 * hygiene finding from last Tuesday, and 21 checks at a five-minute cadence
 * would be 85,000 rows a fortnight for a table whose only question is "what
 * did the last pass find". So the primary key carries no timestamp and every
 * write is an upsert, which is what these pin.
 */
describe('the hygiene cache', () => {
  const at = (iso: string) => new Date(iso);

  it('keeps one row per check and lets the newest pass win', async () => {
    await withStore(async (client) => {
      const dbId = await upsertDatabase(client, 'prod');
      await recordCheckResults(client, dbId, at('2026-09-23T10:00:00Z'), [
        { checkId: 'unusedIndexes', ok: true, level: 'warn', note: '2 unused', message: null },
        { checkId: 'sequences', ok: true, level: 'ok', note: null, message: null },
      ]);
      await recordCheckResults(client, dbId, at('2026-09-23T10:05:00Z'), [
        { checkId: 'unusedIndexes', ok: true, level: 'ok', note: null, message: null },
      ]);

      const rows = await readCheckResults(client, 'prod');
      expect(rows).toHaveLength(2);
      const unused = rows.find((r) => r.checkId === 'unusedIndexes')!;
      expect(unused.level).toBe('ok');
      expect(unused.note).toBeNull();
      expect(unused.capturedAt).toEqual(at('2026-09-23T10:05:00Z'));
      // Untouched by the second pass, and still readable at its own age.
      expect(rows.find((r) => r.checkId === 'sequences')!.capturedAt)
        .toEqual(at('2026-09-23T10:00:00Z'));
    });
  });

  /**
   * "We could not look" is a reading the triage line has to show, so a check
   * that FAILED is stored rather than skipped. Were it skipped, the previous
   * pass's verdict would sit there going stale while reading as current.
   */
  it('stores a check that could not run, with its message', async () => {
    await withStore(async (client) => {
      const dbId = await upsertDatabase(client, 'prod');
      await recordCheckResults(client, dbId, at('2026-09-23T10:00:00Z'), [
        { checkId: 'indexHitRate', ok: true, level: 'ok', note: null, message: null },
      ]);
      await recordCheckResults(client, dbId, at('2026-09-23T10:05:00Z'), [
        {
          checkId: 'indexHitRate', ok: false, level: null, note: null,
          message: 'permission denied for view pg_statio_user_indexes',
        },
      ]);

      const [row] = await readCheckResults(client, 'prod');
      expect(row).toMatchObject({ ok: false, level: null, message: 'permission denied for view pg_statio_user_indexes' });
    });
  });

  it('reads only the database it was asked about', async () => {
    await withStore(async (client) => {
      const prod = await upsertDatabase(client, 'prod');
      const staging = await upsertDatabase(client, 'staging');
      await recordCheckResults(client, prod, at('2026-09-23T10:00:00Z'), [
        { checkId: 'sequences', ok: true, level: 'critical', note: '1 sequence past 90%', message: null },
      ]);
      await recordCheckResults(client, staging, at('2026-09-23T10:00:00Z'), [
        { checkId: 'sequences', ok: true, level: 'ok', note: null, message: null },
      ]);

      expect((await readCheckResults(client, 'prod'))[0]!.level).toBe('critical');
      expect((await readCheckResults(client, 'staging'))[0]!.level).toBe('ok');
    });
  });

  it('is empty, not an error, for a database that has never been captured', async () => {
    await withStore(async (client) => {
      expect(await readCheckResults(client, 'never-seen')).toEqual([]);
    });
  });

  /** An empty pass writes nothing rather than issuing a VALUES with no rows. */
  it('accepts an empty pass', async () => {
    await withStore(async (client) => {
      const dbId = await upsertDatabase(client, 'prod');
      await expect(recordCheckResults(client, dbId, at('2026-09-23T10:00:00Z'), []))
        .resolves.toBeUndefined();
    });
  });
});
