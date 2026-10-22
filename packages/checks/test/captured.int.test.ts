import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { captureOnce } from '../src/capture.js';
import type { IndexRead, TableRead } from '../src/checks/catalog.js';
import type { SequenceEntry } from '../src/checks/sequences.js';
import { readCaptured, readEvents, readHourly, readIndexScans, readTableHours, readWritten } from '../src/store/read.js';
import { migrate } from '../src/store/migrate.js';
import { RETENTION, prune, upsertDatabase, writeCaptured, type CapturedWrite } from '../src/store/write.js';
import { withPostgres } from './harness.js';

/** The start of the hour before this one, so every `T(n)` below falls in one hour. */
const HOUR = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
const T = (min: number): Date => new Date(HOUR + (2 + min) * 60_000);

const table = (over: Partial<TableRead> = {}): TableRead => ({
  name: 'public.users', kind: 'table', sizeBytes: 100, heapBytes: 80, indexBytes: 20, liveRows: 10, deadRows: 1,
  vacuumTrigger: 52, inserted: 100, updated: 10, deleted: 1, seqScans: 0, seqRows: 0, idxScans: 5, idxRows: 50,
  hitRate: null, lastVacuum: null, lastAnalyze: null, xidAge: 5, indexes: 1, unvalidated: 0, vacuuming: null, ...over,
});
const index = (name: string, scans: number): IndexRead => ({
  name, table: 'public.users', columns: 'id', sizeBytes: 8192, scans, hitRate: null, unique: false, primary: false, valid: true, duplicateOf: null,
});
const write = (read: CapturedWrite['read'], rows: CapturedWrite['rows'], over: Partial<CapturedWrite> = {}): CapturedWrite =>
  ({ read, ok: true, message: null, rows, total: rows.length, statsReset: null, freezeMaxAge: 2e8, ...over });

/** A migrated store, one client, the database's id. */
async function withStore(fn: (pool: pg.Pool, client: pg.PoolClient, db: number) => Promise<void>): Promise<void> {
  await withPostgres(async (_ctx, pool) => {
    await migrate(pool);
    const client = await pool.connect();
    try {
      await fn(pool, client, await upsertDatabase(client, 'prod'));
    } finally { client.release(); }
  });
}
const days = RETENTION.rollupDays;
const hours = (pool: pg.Pool) => readTableHours(pool, 'prod', 'public.users', new Date(HOUR - 3_600_000), new Date(HOUR + 7_200_000));

describe('writeCaptured', () => {
  it('differences two captures into the hour, and keeps the newest gauges', async () => {
    await withStore(async (pool, client, db) => {
      await writeCaptured(client, db, T(0), write('tables', [table()]), days);
      expect(await hours(pool)).toEqual([{
        at: HOUR, inserted: 0, updated: 0, deleted: 0, indexRows: 0, scanRows: 0, liveRows: 10, deadRows: 1, vacuumTrigger: 52,
      }]);
      await writeCaptured(client, db, T(5), write('tables', [
        table({ inserted: 130, deleted: 4, idxRows: 80, seqRows: 7, liveRows: 40, deadRows: 9 }),
      ]), days);
      expect(await hours(pool)).toEqual([{
        at: HOUR, inserted: 30, updated: 0, deleted: 3, indexRows: 30, scanRows: 7, liveRows: 40, deadRows: 9, vacuumTrigger: 52,
      }]);
      expect(await readWritten(pool, 'prod', new Date(HOUR), new Date(HOUR + 3_600_000))).toEqual(new Map([['public.users', 33]]));
      // A quarter of the hour counts a quarter of it.
      const quarter = await readWritten(pool, 'prod', new Date(HOUR + 900_000), new Date(HOUR + 1_800_000));
      expect(quarter.get('public.users')).toBeCloseTo(33 / 4);
    });
  }, 120_000);

  /** Found by review: a store in a half-hour zone keyed every hour at :30, and a fall-back merged two. */
  it('keys an hour by the UTC hour, whatever zone the store runs in', async () => {
    await withStore(async (pool, client, db) => {
      await client.query("SET TimeZone = 'Asia/Kolkata'");
      await writeCaptured(client, db, T(0), write('tables', [table()]), days);
      expect((await hours(pool)).map((h) => h.at)).toEqual([HOUR]);
    });
  }, 120_000);

  // Review Focus 4.
  it('adds nothing for a reset between two captures, or a counter that went backwards', async () => {
    await withStore(async (pool, client, db) => {
      await writeCaptured(client, db, T(0), write('tables', [table()]), days);
      await writeCaptured(client, db, T(5), write('tables', [table({ inserted: 130 })]), days);
      const reset = T(7).getTime();
      // Reset, then five rows: the counter reads 5, which is not "125 fewer".
      await writeCaptured(client, db, T(10), write('tables', [table({ inserted: 5 })], { statsReset: reset }), days);
      expect((await hours(pool))[0]!.inserted).toBe(30);
      // Backwards with no reset to explain it: one table's counters were cleared.
      await writeCaptured(client, db, T(15), write('tables', [table({ inserted: 3 })], { statsReset: reset }), days);
      expect((await hours(pool))[0]!.inserted).toBe(30);
      await writeCaptured(client, db, T(20), write('tables', [table({ inserted: 13 })], { statsReset: reset }), days);
      expect((await hours(pool))[0]!.inserted).toBe(40);
    });
  }, 120_000);

  it('adds nothing across a gap it cannot account for', async () => {
    await withStore(async (pool, client, db) => {
      await writeCaptured(client, db, T(0), write('tables', [table()]), days);
      await writeCaptured(client, db, T(40), write('tables', [table({ inserted: 9_000 })]), days);
      expect((await hours(pool))[0]!.inserted).toBe(0);
    });
  }, 120_000);

  it('marks a vacuum and an analyze once each, at the catalog\'s own moment', async () => {
    await withStore(async (pool, client, db) => {
      const vacuumed = T(-3).getTime();
      const marks = async () => (await readEvents(pool, 'prod', new Date(HOUR - 3_600_000), new Date(HOUR + 7_200_000), 'public.users'))
        .map((e) => [e.kind, e.relation, e.at]);
      await writeCaptured(client, db, T(0), write('tables', [table({ lastVacuum: vacuumed })]), days);
      await writeCaptured(client, db, T(5), write('tables', [table({ lastVacuum: vacuumed })]), days);
      expect(await marks()).toEqual([['vacuum', 'public.users', vacuumed]]);
      await writeCaptured(client, db, T(10), write('tables', [table({ lastVacuum: T(8).getTime(), lastAnalyze: T(9).getTime() })]), days);
      expect(await marks()).toEqual([
        ['vacuum', 'public.users', vacuumed], ['vacuum', 'public.users', T(8).getTime()], ['analyze', 'public.users', T(9).getTime()],
      ]);
      // The database's page does not draw a table's vacuums: a busy one has several a minute.
      expect(await readEvents(pool, 'prod', new Date(HOUR - 3_600_000), new Date(HOUR + 7_200_000))).toEqual([]);
    });
  }, 120_000);

  it('marks a statistics reset when its moment advances, on the database', async () => {
    await withStore(async (pool, client, db) => {
      const all = async () => (await readEvents(pool, 'prod', new Date(HOUR - 3_600_000), new Date(HOUR + 7_200_000))).map((e) => [e.kind, e.at]);
      await writeCaptured(client, db, T(0), write('tables', [table()]), days);
      expect(await all()).toEqual([]);
      const reset = T(3).getTime();
      await writeCaptured(client, db, T(5), write('tables', [table()], { statsReset: reset }), days);
      await writeCaptured(client, db, T(10), write('tables', [table()], { statsReset: reset }), days);
      expect(await all()).toEqual([['reset', reset]]);
    });
  }, 120_000);

  it('keeps the last rows, with their own age, when a read fails', async () => {
    await withStore(async (pool, client, db) => {
      await writeCaptured(client, db, T(0), write('tables', [table()], { total: 9 }), days);
      await writeCaptured(client, db, T(5), { read: 'tables', ok: false, message: 'statement timeout', rows: [], total: 0, statsReset: null, freezeMaxAge: null }, days);
      const read = await readCaptured<TableRead>(pool, 'prod', 'tables');
      expect(read).toMatchObject({ ok: false, message: 'statement timeout', at: T(0).getTime(), total: 9, freezeMaxAge: 2e8 });
      expect(read!.rows.map((t) => t.name)).toEqual(['public.users']);
    });
  }, 120_000);

  // Review Focus 2.
  it('drops a table that is gone at the next capture', async () => {
    await withStore(async (pool, client, db) => {
      await writeCaptured(client, db, T(0), write('tables', [table(), table({ name: 'public.orders' })]), days);
      await writeCaptured(client, db, T(5), write('tables', [table()]), days);
      expect((await readCaptured<TableRead>(pool, 'prod', 'tables'))!.rows.map((t) => t.name)).toEqual(['public.users']);
    });
  }, 120_000);

  // Review Focus 4.
  it('records only the indexes that were scanned, and nothing across a reset', async () => {
    await withStore(async (pool, client, db) => {
      const scans = () => readIndexScans(pool, 'prod', new Date(HOUR), new Date(HOUR + 3_600_000));
      await writeCaptured(client, db, T(0), write('indexes', [index('public.a', 5), index('public.b', 0)]), days);
      await writeCaptured(client, db, T(5), write('indexes', [index('public.a', 9), index('public.b', 0)]), days);
      expect(await scans()).toEqual(new Map([['public.a', 4]]));
      await writeCaptured(client, db, T(10), write('indexes', [index('public.a', 2), index('public.b', 1)], { statsReset: T(7).getTime() }), days);
      expect(await scans()).toEqual(new Map([['public.a', 4]]));
    });
  }, 120_000);

  it('is never anything of a database the store has not seen', async () => {
    await withStore(async (pool) => {
      expect(await readCaptured(pool, 'nobody', 'tables')).toBeNull();
      expect(await readWritten(pool, 'nobody', new Date(HOUR), new Date(HOUR + 3_600_000))).toEqual(new Map());
    });
  }, 120_000);

  it('prunes the hours with the other rollups', async () => {
    await withStore(async (pool, client, db) => {
      const old = new Date(Date.now() - (days + 1) * 86_400_000);
      await writeCaptured(client, db, old, write('tables', [table()]), days);
      await writeCaptured(client, db, T(0), write('tables', [table()]), days);
      await writeCaptured(client, db, new Date(old.getTime() - 60_000), write('indexes', [index('public.a', 1)]), days);
      await writeCaptured(client, db, old, write('indexes', [index('public.a', 5)]), days);
      await writeCaptured(client, db, T(0), write('indexes', [index('public.a', 5)]), days);
      await writeCaptured(client, db, T(5), write('indexes', [index('public.a', 6)]), days);
      await prune(client, db, RETENTION);
      const { rows } = await pool.query<{ t: string; i: string }>(
        `SELECT (SELECT count(*) FROM pgops.table_hours)::text AS t, (SELECT count(*) FROM pgops.index_hours)::text AS i`,
      );
      expect(rows[0]).toEqual({ t: '1', i: '1' });
    });
  }, 120_000);

  it('writes a header and no rows when the first read of all fails', async () => {
    await withStore(async (pool, client, db) => {
      await writeCaptured(client, db, T(0), { read: 'indexes', ok: false, message: 'permission denied', rows: [], total: 0, statsReset: null, freezeMaxAge: null }, days);
      expect(await readCaptured(pool, 'prod', 'indexes')).toEqual({
        rows: [], at: T(0).getTime(), ok: false, message: 'permission denied', total: 0, statsReset: null, freezeMaxAge: null,
      });
      // The next good read replaces the header whole.
      await writeCaptured(client, db, T(5), write('indexes', [index('public.a', 1)], { statsReset: T(-60).getTime() }), days);
      expect(await readCaptured(pool, 'prod', 'indexes')).toMatchObject({
        at: T(5).getTime(), ok: true, message: null, total: 1, statsReset: T(-60).getTime(), freezeMaxAge: 2e8,
      });
    });
  }, 120_000);

  it('does not mark a reset the reset route already marked', async () => {
    await withStore(async (pool, client, db) => {
      await writeCaptured(client, db, T(0), write('tables', [table()]), days);
      await pool.query("INSERT INTO pgops.events (database_id, at, kind) VALUES ($1, $2, 'reset')", [db, T(3)]);
      await writeCaptured(client, db, T(5), write('tables', [table()], { statsReset: T(3).getTime() + 20_000 }), days);
      const events = await readEvents(pool, 'prod', new Date(HOUR - 3_600_000), new Date(HOUR + 7_200_000));
      expect(events.map((e) => [e.kind, e.at])).toEqual([['reset', T(3).getTime()]]);
    });
  }, 120_000);

  it('keeps the store\'s rows apart by database', async () => {
    await withStore(async (pool, client, db) => {
      const other = await upsertDatabase(client, 'staging');
      await writeCaptured(client, db, T(0), write('tables', [table()]), days);
      await writeCaptured(client, other, T(0), write('tables', [table({ name: 'public.orders' })]), days);
      await writeCaptured(client, other, T(5), write('tables', [table({ name: 'public.orders', inserted: 150 })]), days);
      expect((await readCaptured<TableRead>(pool, 'prod', 'tables'))!.rows.map((t) => t.name)).toEqual(['public.users']);
      expect(await readWritten(pool, 'prod', new Date(HOUR), new Date(HOUR + 3_600_000))).toEqual(new Map([['public.users', 0]]));
      expect(await readWritten(pool, 'staging', new Date(HOUR), new Date(HOUR + 3_600_000))).toEqual(new Map([['public.orders', 50]]));
    });
  }, 120_000);
});

describe('readHourly', () => {
  it('is one node\'s mean sessions for each hour with load, oldest first', async () => {
    await withStore(async (pool, _client, db) => {
      // Thirty minutes of one session on public.users, then an hour of none, then a minute of three.
      await pool.query(
        `INSERT INTO pgops.load_minutes (database_id, minute, kind, key, class, sessions)
         SELECT $1::int, $2::timestamptz + g * interval '1 minute', 't', 'public.users', 'active', 1
           FROM generate_series(0, 29) g
         UNION ALL
         SELECT $1, $2::timestamptz + interval '2 hours', 't', 'public.users', 'lock', 3
         UNION ALL
         SELECT $1, $2::timestamptz, 't', 'public.orders', 'active', 9`,
        [db, new Date(HOUR - 3_600_000)],
      );
      expect(await readHourly(pool, 'prod', 't', 'public.users', new Date(HOUR - 3_600_000), new Date(HOUR + 7_200_000)))
        .toEqual([{ at: HOUR - 3_600_000, sessions: 0.5 }, { at: HOUR + 3_600_000, sessions: 0.05 }]);
    });
  }, 120_000);

  it('takes the hour the window ends in over the minutes it has had, not all sixty', async () => {
    await withStore(async (pool, _client, db) => {
      // A whole hour of two sessions, then the first fifteen minutes of the next at two again.
      await pool.query(
        `INSERT INTO pgops.load_minutes (database_id, minute, kind, key, class, sessions)
         SELECT $1::int, $2::timestamptz + g * interval '1 minute', 't', 'public.users', 'active', 2
           FROM generate_series(0, 74) g`,
        [db, new Date(HOUR - 3_600_000)],
      );
      expect(await readHourly(pool, 'prod', 't', 'public.users', new Date(HOUR - 3_600_000), new Date(HOUR + 15 * 60_000)))
        .toEqual([{ at: HOUR - 3_600_000, sessions: 2 }, { at: HOUR, sessions: 2 }]);
      // Twenty seconds into the sixteenth minute is sixteen minutes begun.
      expect(await readHourly(pool, 'prod', 't', 'public.users', new Date(HOUR - 3_600_000), new Date(HOUR + 15 * 60_000 + 20_000)))
        .toEqual([{ at: HOUR - 3_600_000, sessions: 2 }, { at: HOUR, sessions: 30 / 16 }]);
    });
  }, 120_000);
});

describe('captureOnce', () => {
  it('stores the catalog it read, beside the query and space statistics', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await pool.query('CREATE TABLE widgets (id serial PRIMARY KEY, n int)');
      expect(await captureOnce({ ...ctx, store: pool }, 'prod')).toMatchObject({ ok: true });
      const tables = await readCaptured<TableRead>(pool, 'prod', 'tables');
      expect(tables).toMatchObject({ ok: true, total: 1 });
      expect(tables!.rows.map((t) => t.name)).toEqual(['public.widgets']);
      expect((await readCaptured<IndexRead>(pool, 'prod', 'indexes'))!.rows.map((i) => i.name)).toEqual(['public.widgets_pkey']);
      expect((await readCaptured<SequenceEntry>(pool, 'prod', 'sequences'))!.rows.map((s) => [s.name, s.table]))
        .toEqual([['public.widgets_id_seq', 'public.widgets']]);
    });
  }, 120_000);
});
