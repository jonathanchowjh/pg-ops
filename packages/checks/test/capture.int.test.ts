import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { captureOnce } from '../src/capture.js';
import { readDatabaseSpace, readQueryText } from '../src/store/read.js';
import { migrate } from '../src/store/schema.js';
import { withPostgres } from './harness.js';

describe('captureOnce', () => {
  it('NEVER resets pg_stat_statements — the strongest claim in the design', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      const withStore = { ...ctx, store: pool };

      await pool.query('SELECT 1');
      const before = await calls(pool);
      const resetBefore = await lastReset(pool);
      await captureOnce(withStore, 'prod');
      await captureOnce(withStore, 'prod');
      const after = await calls(pool);

      // Two assertions, because the counter one alone is indirect: a reset
      // would drop sum(calls) below the baseline the migration and setup
      // queries established, but so would several other things, and it also
      // passes when capture stores nothing at all.
      //
      // pg_stat_statements_info.stats_reset is the direct evidence. It moves
      // if and only if something reset the view, which is exactly what
      // pgHero's own capture_query_stats does — silently breaking every other
      // consumer on the database.
      expect(await lastReset(pool)).toEqual(resetBefore);
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  it('redacts query text before storing it', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      // Three normalisation facts drive the shape of this statement, each
      // verified against PG 17 rather than assumed, and each one broke an
      // earlier draft of this test:
      //   - LITERALS are replaced with $1 before pgops sees the text, so a
      //     secret in a literal is gone whether redactSecrets runs or not;
      //   - COMMENTS are not in the queryid jumble, so `SELECT 1 /* a */` and
      //     `SELECT 1 /* b */` share one queryid;
      //   - column ALIASES are not in it either — `SELECT 1 AS x` and
      //     `SELECT 1 AS y` also share one.
      // Capture groups by queryid and keeps `max(query)`, so a marker that
      // shares its queryid with another statement can be silently replaced by
      // that statement's text. A distinct RELATION is what actually yields a
      // distinct queryid, so the secret rides in a comment on a select from a
      // uniquely-named table: unique queryid, singleton group, text intact.
      const t = `redact_probe_${Date.now()}`;
      await pool.query(`CREATE TABLE ${t} (id int)`);
      await pool.query(`SELECT id FROM ${t} /* postgres://user:hunter2@db/app */`);
      await captureOnce({ ...ctx, store: pool }, 'prod');

      // POSITIVE CONTROL FIRST. I5 (final review): asserting only that no row
      // matches '%hunter2%' is also satisfied by an EMPTY pgops.queries — so
      // with redactSecrets deleted AND the capture query failing for any
      // reason, the test stayed green while the code under test was gone.
      // Prove the shape reached the store, then prove the secret did not.
      const stored = await pool.query<{ query: string }>(
        `SELECT query FROM pgops.queries WHERE query LIKE '%postgres://%'`,
      );
      expect(stored.rows.length).toBeGreaterThan(0);
      expect(stored.rows.some((r) => r.query.includes('***'))).toBe(true);

      const leaked = await pool.query<{ query: string }>(
        `SELECT query FROM pgops.queries WHERE query LIKE '%hunter2%'`,
      );
      // pgops.queries is durable storage. A secret written there outlives
      // every screenshot; redactSecrets runs before the insert, not only on
      // the render path.
      expect(leaked.rows).toHaveLength(0);
    });
  });

  it('reports missing-store rather than throwing when no store is configured', async () => {
    await withPostgres(async (ctx) => {
      const outcome = await captureOnce(ctx, 'prod');
      expect(outcome).toMatchObject({ ok: false, reason: 'missing-store' });
    });
  });

  it('captures relation sizes', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await pool.query('CREATE TABLE widgets (id int)');
      const outcome = await captureOnce({ ...ctx, store: pool }, 'prod');
      expect(outcome).toMatchObject({ ok: true });
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pgops.space_stats WHERE relation LIKE '%widgets%'`,
      );
      expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    });
  });
});

async function lastReset(pool: import('pg').Pool): Promise<string | null> {
  const { rows } = await pool.query<{ at: string | null }>(
    `SELECT stats_reset::text AS at FROM pg_stat_statements_info`,
  );
  return rows[0]?.at ?? null;
}

async function calls(pool: import('pg').Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT coalesce(sum(calls), 0)::text AS n FROM pg_stat_statements`,
  );
  return Number(rows[0]!.n);
}

describe('captureOnce — what it refuses to lie about', () => {
  it('reports a query-stats read it could not do, rather than shapes: 0 and ok', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await pool.query('CREATE TABLE widgets (id int)');
      // The harness creates pg_stat_statements for every database it hands
      // out, so it has to be removed to reach this path. Dropping it is what
      // a cluster pg_upgraded to 14 without the documented
      // `ALTER EXTENSION pg_stat_statements UPDATE` looks like from here: the
      // view is not readable, for a reason that is not the database's fault.
      await pool.query('DROP EXTENSION IF EXISTS pg_stat_statements');
      const outcome = await captureOnce({ ...ctx, store: pool }, 'prod');
      // Space stats still land — they are independent and still useful.
      expect(outcome).toMatchObject({ ok: true, shapes: 0 });
      // But the failure is NAMED. Reported as a bare shapes:0 it is
      // indistinguishable from a database that genuinely ran nothing.
      expect(outcome.ok === true && outcome.queryStatsError).toBeTruthy();
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pgops.space_stats`,
      );
      expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    });
  });

  it('sums a shape across roles instead of silently keeping one of them', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);

      // pg_stat_statements is keyed by (userid, dbid, queryid, toplevel), so
      // ONE shape run by TWO roles is two rows with the same queryid — the
      // queries page documents this as I3, reproduced on PG 17. A capture
      // that does not aggregate collapses them into one primary key, keeps
      // whichever the scan returned first, and makes the counters jump
      // backwards whenever the survivor changes. A second role is the only
      // way to reach that, which is why this test creates one.
      // A uniquely-named TABLE, not an alias or a comment: only a distinct
      // relation gives the statement a queryid of its own, and without that
      // this test reads some other statement's text (see the redaction test
      // above for the three normalisation facts behind that).
      const t = `shared_shape_${Date.now()}`;
      const stmt = `SELECT id FROM ${t}`;
      await pool.query(`CREATE TABLE ${t} (id int)`);
      // Randomised, and dropped in the `finally` below. `withPostgres` drops
      // the per-test DATABASE, but a role is cluster-level and the whole
      // integration run shares one container — a fixed name survives the test
      // and makes a retry of this file fail with "role already exists".
      const role = `probe_${Date.now()}`;
      await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe'`);
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await pool.query(`GRANT SELECT ON ${t} TO ${role}`);
      await pool.query(stmt);

      // Built from the injected base URI, NOT from current_setting('port'):
      // that reports the port inside the container (5432), not the mapped one
      // testcontainers published on the host.
      const { rows: conn } = await pool.query<{ db: string }>(
        `SELECT current_database() AS db`,
      );
      const probeUri = new URL(inject('pgConnectionUri'));
      probeUri.username = role;
      probeUri.password = 'probe';
      probeUri.pathname = `/${conn[0]!.db}`;
      const asProbe = new pg.Client({ connectionString: probeUri.toString() });
      try {
        await asProbe.connect();
        await asProbe.query(stmt);
        await asProbe.query(stmt);
      } finally {
        await asProbe.end().catch(() => {});
      }

      // Two rows, one queryid — the precondition. Without it this test would
      // pass against an unaggregated capture and prove nothing.
      const raw = await pool.query<{ n: string; calls: string }>(
        `SELECT count(*)::text AS n, sum(calls)::text AS calls
           FROM pg_stat_statements WHERE query LIKE $1`,
        [`%FROM ${t}%`],
      );
      expect(Number(raw.rows[0]!.n)).toBeGreaterThan(1);

      await captureOnce({ ...ctx, store: pool }, 'prod');

      const stored = await pool.query<{ n: string; calls: string }>(
        `SELECT count(*)::text AS n, coalesce(sum(s.calls), 0)::text AS calls
           FROM pgops.query_stats s
           JOIN pgops.queries q ON q.id = s.query_id
          WHERE q.query LIKE $1`,
        [`%FROM ${t}%`],
      );
      // Exactly one stored row for the shape...
      expect(stored.rows[0]!.n).toBe('1');
      // ...carrying the SUM of both roles, not one of them.
      expect(stored.rows[0]!.calls).toBe(raw.rows[0]!.calls);

      await pool.query(`REVOKE ALL ON ${t} FROM ${role}`);
      await pool.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
      await pool.query(`DROP ROLE IF EXISTS ${role}`);
    });
  });

  it('captures only THIS database, not every database on the cluster', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);

      // pg_stat_statements is loaded via shared_preload_libraries, so it
      // records statements from EVERY database on the cluster and the view
      // read from here shows all of them. Run a distinctive statement on a
      // different database, then capture on this one.
      //
      // The marker is a uniquely-named TABLE. Neither a literal, a comment
      // nor a column alias gives a statement its own queryid — capture groups
      // by queryid and keeps `max(query)`, so all three earlier drafts of this
      // marker were silently replaced by another statement's text and the
      // assertion passed against an UNFILTERED capture. See the redaction
      // test above for the three facts.
      const marker = `pgops_other_db_${Date.now()}`;
      const other = new pg.Client({ connectionString: inject('pgConnectionUri') });
      await other.connect();
      try {
        await other.query(`CREATE TABLE ${marker} (id int)`);
        await other.query(`SELECT id FROM ${marker}`);
      } finally {
        await other.query(`DROP TABLE IF EXISTS ${marker}`).catch(() => {});
        await other.end().catch(() => {});
      }

      // Present in the cluster-wide view read from this database...
      const visible = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_statements WHERE query LIKE $1`,
        [`%FROM ${marker}%`],
      );
      expect(Number(visible.rows[0]!.n)).toBeGreaterThan(0);

      await captureOnce({ ...ctx, store: pool }, 'prod');

      // ...and absent from the store, because capture filters on dbid.
      const stored = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pgops.queries WHERE query LIKE $1`,
        [`%FROM ${marker}%`],
      );
      expect(stored.rows[0]!.n).toBe('0');
    });
  });

  it('stores no placeholder text when the role cannot read every row', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);

      const t = `privilege_probe_${Date.now()}`;
      const role = `reader_${Date.now()}`;
      await pool.query(`CREATE TABLE ${t} (id int)`);
      await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe'`);
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await pool.query(`GRANT SELECT ON ${t} TO ${role}`);

      const uri = new URL(inject('pgConnectionUri'));
      uri.username = role;
      uri.password = 'probe';
      uri.pathname = `/${(await pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db}`;
      const asReader = new pg.Pool({ connectionString: uri.toString(), max: 2 });
      try {
        // Run the shape AS THE READER, so it has one row it can read among
        // many it cannot. Without pg_read_all_stats every other role's row
        // comes back as '<insufficient privilege>' with a NULL queryid.
        await asReader.query(`SELECT id FROM ${t}`);
        const seen = await asReader.query<{ hidden: string }>(
          `SELECT count(*) FILTER (WHERE query = '<insufficient privilege>')::text AS hidden
             FROM pg_stat_statements`,
        );
        // The precondition. Without hidden rows present this test would pass
        // against any implementation and prove nothing.
        expect(Number(seen.rows[0]!.hidden)).toBeGreaterThan(0);

        const outcome = await captureOnce({ ...ctx, target: asReader, store: pool }, 'prod');
        expect(outcome).toMatchObject({ ok: true });
      } finally {
        await asReader.end().catch(() => {});
      }

      const stored = await pool.query<{ query: string }>(`SELECT query FROM pgops.queries`);
      // Positive control: the reader's OWN shape reached the store...
      expect(stored.rows.some((r) => r.query.includes(`FROM ${t}`))).toBe(true);
      // ...and nothing it could not read did. pgops.queries is durable, and
      // upsertQuery overwrites `query` on conflict, so one capture by an
      // under-privileged role could otherwise replace a shape's real text
      // with the placeholder for good.
      expect(stored.rows.every((r) => !r.query.includes('insufficient privilege'))).toBe(true);

      await pool.query(`REVOKE ALL ON ${t} FROM ${role}`);
      await pool.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
      await pool.query(`DROP ROLE IF EXISTS ${role}`);
    });
  });

  it('timestamps from the STORE, not from this process', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      // Several replicas capture the same databases — that is what the
      // advisory lock exists for — and a Node-side `new Date()` makes their
      // snapshots sort by whichever clock is fastest. With a skew larger than
      // the capture interval, deltas sees counters decrease and drops every
      // interval as a discontinuity. Asserting the stored instant is the
      // store's transaction time pins the one clock.
      const before = await pool.query<{ now: Date }>('SELECT now() AS now');
      await captureOnce({ ...ctx, store: pool }, 'prod');
      const after = await pool.query<{ now: Date }>('SELECT now() AS now');

      const { rows } = await pool.query<{ captured_at: Date }>(
        'SELECT DISTINCT captured_at FROM pgops.query_stats',
      );
      expect(rows).toHaveLength(1);
      const at = rows[0]!.captured_at.getTime();
      expect(at).toBeGreaterThanOrEqual(before.rows[0]!.now.getTime());
      expect(at).toBeLessThanOrEqual(after.rows[0]!.now.getTime());
    });
  });

  it('still captures every relation it CAN measure', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await pool.query('CREATE TABLE empty_but_real (id int)');
      await pool.query('CREATE TABLE has_rows (id int)');
      await pool.query('INSERT INTO has_rows SELECT generate_series(1, 100)');
      await captureOnce({ ...ctx, store: pool }, 'prod');

      // SPACE_SQL gained `pg_total_relation_size(c.oid) IS NOT NULL`, which
      // returns NULL only for a relation dropped between the pg_class scan
      // and the size call — a race no test can stage deterministically, and
      // deliberately NOT asserted here rather than asserted by something that
      // cannot fail. What IS assertable is the other direction: the filter
      // must not quietly drop measurable relations, and an EMPTY table is the
      // one that would go if `IS NOT NULL` were ever written as `> 0` (an
      // empty heap measures 0 bytes, which is a real measurement, not a
      // missing one).
      const { rows } = await pool.query<{ relation: string }>(
        `SELECT relation FROM pgops.space_stats
          WHERE relation IN ('public.empty_but_real', 'public.has_rows')
          ORDER BY relation`,
      );
      expect(rows.map((r) => r.relation))
        .toEqual(['public.empty_but_real', 'public.has_rows']);
    });
  });

  it('does not unlock a capture lock it never took', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      // Hold the lock from another session, so captureOnce takes the skipped
      // path. Releasing a lock this session never acquired makes Postgres log
      // `WARNING: you don't own a lock of type ExclusiveLock` into the STORE's
      // log on every skipped tick.
      const holder = new pg.Client({ connectionString: inject('pgConnectionUri') });
      const dbName = (await pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
      const uri = new URL(inject('pgConnectionUri'));
      uri.pathname = `/${dbName}`;
      const held = new pg.Client({ connectionString: uri.toString() });
      await held.connect();
      try {
        const id = await held.query<{ id: number }>(
          `INSERT INTO pgops.databases (name) VALUES ('prod')
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
        await held.query('SELECT pg_advisory_lock($1, $2)', [4021976, id.rows[0]!.id]);

        const outcome = await captureOnce({ ...ctx, store: pool }, 'prod');
        expect(outcome).toMatchObject({ ok: 'skipped', reason: 'locked' });

        // The holder still owns exactly one advisory lock: captureOnce did not
        // release someone else's.
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory'`,
        );
        expect(rows[0]!.n).toBe('1');
      } finally {
        await held.end().catch(() => {});
        await holder.end().catch(() => {});
      }
    });
  });
});


/**
 * The load row — the one thing capture writes that is not a copy of what it
 * read. Unit-tested for its arithmetic (capture.test.ts); this pins the two
 * properties that only a real store can show: that the first capture writes
 * nothing, and that retention reaches the table.
 */
describe('readQueryText', () => {
  /**
   * The query detail page identifies its subject by `queryid` alone, so this
   * is the one lookup standing between an operator and a page that names a
   * 19-digit integer and nothing else.
   *
   * THE TYPES DO NOT MATCH ON PAPER: `pgops.queries.queryid` is bigint and
   * the caller passes the string out of the URL, because a 64-bit hash does
   * not survive a JS number. That comparison is the thing worth proving
   * against a real server rather than reasoning about.
   */
  it('finds a shape by the queryid string a URL carries', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      const t = `text_probe_${Date.now()}`;
      await pool.query(`CREATE TABLE ${t} (id int)`);
      await pool.query(`SELECT id FROM ${t}`);
      await captureOnce({ ...ctx, store: pool }, 'prod');

      const { rows } = await pool.query<{ queryid: string; query: string }>(
        `SELECT q.queryid::text AS queryid, q.query
           FROM pgops.queries q WHERE q.query LIKE $1`,
        [`%${t}%`],
      );
      expect(rows.length).toBeGreaterThan(0);
      const row = rows[0]!;

      expect(await readQueryText(pool, 'prod', row.queryid)).toBe(row.query);
    });
  });

  /**
   * A shape the store has never seen is an ordinary state, not an error: the
   * operator may have followed a link to a statement that has since aged out
   * of the retention window. The page falls back to the id it already has.
   */
  it('answers null for a shape this database has never captured', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      await captureOnce({ ...ctx, store: pool }, 'prod');
      expect(await readQueryText(pool, 'prod', '1234567890123456789')).toBeNull();
      // And scoped to the database it was asked about, not to the cluster.
      expect(await readQueryText(pool, 'no-such-db', '1')).toBeNull();
    });
  });
});

describe('readDatabaseSpace', () => {
  /**
   * One row per CAPTURE out of a table that holds one row per relation per
   * capture. Summing in the console would mean thirty days of a 400-relation
   * database — 3.4 million rows — crossing the wire to be added up in JS.
   */
  it('collapses every relation to one total per capture', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await pool.query('CREATE TABLE widgets (id int)');
      await pool.query('CREATE TABLE gadgets (id int)');
      await captureOnce({ ...ctx, store: pool }, 'prod');

      const from = new Date(Date.now() - 3_600_000);
      const to = new Date(Date.now() + 3_600_000);
      const totals = await readDatabaseSpace(pool, 'prod', from, to);
      expect(totals).toHaveLength(1);

      // The total is the sum of what was stored, and the count is the
      // population it was summed over — the pair the surface needs to tell a
      // dropped relation from a capture that saw less of the database.
      const { rows } = await pool.query<{ n: string; total: string }>(
        `SELECT count(*)::text AS n, sum(size_bytes)::text AS total
           FROM pgops.space_stats`,
      );
      expect(totals[0]!.relations).toBe(Number(rows[0]!.n));
      expect(totals[0]!.sizeBytes).toBe(Number(rows[0]!.total));
      expect(totals[0]!.relations).toBeGreaterThan(1);
    });
  });

  /** Scoped to one database and one window, like every other read here. */
  it('answers nothing for another database or a window with no captures', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await pool.query('CREATE TABLE widgets (id int)');
      await captureOnce({ ...ctx, store: pool }, 'prod');

      const wide = { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) };
      expect(await readDatabaseSpace(pool, 'other', wide.from, wide.to)).toEqual([]);
      const past = new Date(Date.now() - 86_400_000);
      expect(await readDatabaseSpace(pool, 'prod', past, new Date(Date.now() - 82_800_000))).toEqual([]);
    });
  });
});

describe('captureOnce and the load series', () => {
  it('writes no row for the first capture and one for the second', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      const withStore = { ...ctx, store: pool };

      await captureOnce(withStore, 'prod');
      // One cumulative snapshot is not an interval. A zero row here would
      // claim the database was idle for five minutes it was never watched.
      expect(await loadRows(pool)).toHaveLength(0);

      // Real work between the two captures, so the interval is not empty.
      for (let i = 0; i < 20; i += 1) await pool.query('SELECT count(*) FROM pg_class');
      await captureOnce(withStore, 'prod');

      const rows = await loadRows(pool);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.calls)).toBeGreaterThan(0);
      expect(rows[0]!.total_exec_time).toBeGreaterThan(0);
    });
  }, 120_000);

  it('prunes the load series on the same retention as the snapshots', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      const withStore = { ...ctx, store: pool };
      await captureOnce(withStore, 'prod');

      // A row older than query_stats' retention, planted directly: the point
      // is that `prune` covers this table, not that time passes.
      await pool.query(
        `INSERT INTO pgops.query_load (database_id, captured_at, total_exec_time, calls)
         SELECT d.id, now() - interval '30 days', 1.0, 1 FROM pgops.databases d WHERE d.name = 'prod'`,
      );
      expect(await loadRows(pool)).toHaveLength(1);

      await captureOnce(withStore, 'prod');
      // The planted row is gone. Anything the second capture wrote is new.
      const rows = await loadRows(pool);
      expect(rows.every((r) => r.captured_at.getTime() > Date.now() - 60_000)).toBe(true);
    });
  }, 120_000);
});

async function loadRows(pool: pg.Pool): Promise<
  { captured_at: Date; total_exec_time: number; calls: string }[]
> {
  const { rows } = await pool.query<{ captured_at: Date; total_exec_time: number; calls: string }>(
    'SELECT captured_at, total_exec_time, calls::text AS calls FROM pgops.query_load ORDER BY captured_at',
  );
  return rows;
}
