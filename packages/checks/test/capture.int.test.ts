import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { captureOnce } from '../src/capture.js';
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

      // stats_reset is the direct evidence: it moves if and only if something
      // reset the view. The counter assertion alone is indirect.
      expect(await lastReset(pool)).toEqual(resetBefore);
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  it('redacts query text before storing it', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      // Three normalisation facts shape this statement:
      //   - literals are replaced with $1 before pgops sees the text, so a
      //     secret in a literal is gone whether redactSecrets runs or not;
      //   - comments are not in the queryid jumble;
      //   - column aliases are not in it either.
      // Capture groups by queryid and keeps `max(query)`, so a marker sharing
      // a queryid can be replaced by another statement's text. Only a distinct
      // relation yields a distinct queryid, so the secret rides in a comment
      // on a select from a uniquely-named table.
      const t = `redact_probe_${Date.now()}`;
      await pool.query(`CREATE TABLE ${t} (id int)`);
      await pool.query(`SELECT id FROM ${t} /* postgres://user:hunter2@db/app */`);
      await captureOnce({ ...ctx, store: pool }, 'prod');

      // Positive control first: an empty pgops.queries would also satisfy
      // "no row matches '%hunter2%'".
      const stored = await pool.query<{ query: string }>(
        `SELECT query FROM pgops.queries WHERE query LIKE '%postgres://%'`,
      );
      expect(stored.rows.length).toBeGreaterThan(0);
      expect(stored.rows.some((r) => r.query.includes('***'))).toBe(true);

      const leaked = await pool.query<{ query: string }>(
        `SELECT query FROM pgops.queries WHERE query LIKE '%hunter2%'`,
      );
      // pgops.queries is durable, so redaction must run before the insert,
      // not only on the render path.
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
      // The harness creates pg_stat_statements for every database, so it is
      // dropped to reach this path: an unreadable view.
      await pool.query('DROP EXTENSION IF EXISTS pg_stat_statements');
      const outcome = await captureOnce({ ...ctx, store: pool }, 'prod');
      // Space stats are independent and still land.
      expect(outcome).toMatchObject({ ok: true, shapes: 0 });
      // The failure is named: a bare shapes:0 would look like a database
      // that ran nothing.
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
      // one shape run by two roles is two rows with the same queryid. A
      // capture that does not aggregate keeps whichever the scan returned
      // first, and the counters jump backwards when the survivor changes.
      // A uniquely-named table gives the statement its own queryid (see the
      // redaction test above).
      const t = `shared_shape_${Date.now()}`;
      const stmt = `SELECT id FROM ${t}`;
      await pool.query(`CREATE TABLE ${t} (id int)`);
      // A unique name: a role is cluster-level and the run shares one
      // container, so a fixed name would fail a retry with "role already
      // exists".
      const role = `probe_${Date.now()}`;
      await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe'`);
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await pool.query(`GRANT SELECT ON ${t} TO ${role}`);
      await pool.query(stmt);

      // Built from the injected base URI: current_setting('port') reports the
      // port inside the container, not the one mapped on the host.
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

      // Precondition: two rows, one queryid. Without it an unaggregated
      // capture would pass.
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
      expect(stored.rows[0]!.n).toBe('1');
      // The sum of both roles, not one of them.
      expect(stored.rows[0]!.calls).toBe(raw.rows[0]!.calls);

      await pool.query(`REVOKE ALL ON ${t} FROM ${role}`);
      await pool.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
      await pool.query(`DROP ROLE IF EXISTS ${role}`);
    });
  });

  it('captures only THIS database, not every database on the cluster', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);

      // pg_stat_statements records statements from every database on the
      // cluster, and the view read from here shows all of them. The marker
      // is a uniquely-named table so it has its own queryid (see the
      // redaction test above); otherwise an unfiltered capture would pass.
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
        // Run the shape as the reader, so it has one row it can read among
        // many it cannot. Without pg_read_all_stats every other role's row
        // comes back as '<insufficient privilege>' with a NULL queryid.
        await asReader.query(`SELECT id FROM ${t}`);
        const seen = await asReader.query<{ hidden: string }>(
          `SELECT count(*) FILTER (WHERE query = '<insufficient privilege>')::text AS hidden
             FROM pg_stat_statements`,
        );
        // Precondition: without hidden rows any implementation would pass.
        expect(Number(seen.rows[0]!.hidden)).toBeGreaterThan(0);

        const outcome = await captureOnce({ ...ctx, target: asReader, store: pool }, 'prod');
        expect(outcome).toMatchObject({ ok: true });
      } finally {
        await asReader.end().catch(() => {});
      }

      const stored = await pool.query<{ query: string }>(`SELECT query FROM pgops.queries`);
      // Positive control: the reader's own shape reached the store.
      expect(stored.rows.some((r) => r.query.includes(`FROM ${t}`))).toBe(true);
      // upsertQuery overwrites `query` on conflict, so one under-privileged
      // capture could replace a shape's real text with the placeholder.
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
      // Several replicas capture the same databases. With a Node-side
      // `new Date()` and clock skew larger than the capture interval, deltas
      // sees counters decrease and drops every interval as a discontinuity.
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

      // An empty table measures 0 bytes, which is a real measurement: it must
      // not be dropped along with the relations whose size is NULL.
      const { rows } = await pool.query<{ relation: string }>(
        `SELECT relation FROM pgops.space_stats
          WHERE relation IN ('public.empty_but_real', 'public.has_rows')
          ORDER BY relation`,
      );
      expect(rows.map((r) => r.relation))
        .toEqual(['public.empty_but_real', 'public.has_rows']);
    });
  });

  /**
   * Its size scan once ran with no timeout at all, so a migration holding a
   * table held the capture, its store client and its advisory lock for as
   * long as the migration ran. It writes the tables read as failed instead.
   */
  it('is not held by a table a migration holds', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await pool.query('CREATE TABLE migrating (id int)');
      const holder = await pool.connect();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE migrating IN ACCESS EXCLUSIVE MODE');
        const held = new Promise<'held'>((resolve) => { timer = setTimeout(() => resolve('held'), 15_000); });
        const outcome = await Promise.race([captureOnce({ ...ctx, store: pool }, 'prod'), held]);
        expect(outcome).toMatchObject({ ok: true, relations: 0 });
      } finally {
        clearTimeout(timer);
        await holder.query('ROLLBACK');
        holder.release();
      }
      const { rows } = await pool.query<{ ok: boolean; message: string | null }>(
        "SELECT ok, message FROM pgops.captures WHERE read = 'tables'",
      );
      expect(rows).toEqual([{ ok: false, message: expect.stringMatching(/lock timeout/) }]);
    });
  });

  it('writes the tables read\'s sizes as the space series', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await pool.query('CREATE TABLE has_rows (id int)');
      await pool.query('INSERT INTO has_rows SELECT generate_series(1, 1000)');
      await captureOnce({ ...ctx, store: pool }, 'prod');
      const { rows: space } = await pool.query<{ relation: string; size: number }>(
        'SELECT relation, size_bytes::float8 AS size FROM pgops.space_stats ORDER BY relation',
      );
      const { rows: tables } = await pool.query<{ relation: string; size: number }>(
        `SELECT c.data->>'name' AS relation, (c.data->>'sizeBytes')::float8 AS size
           FROM pgops.captured c WHERE c.read = 'tables' ORDER BY 1`,
      );
      expect(space.length).toBeGreaterThan(0);
      expect(space).toEqual(tables);
    });
  });

  it('does not unlock a capture lock it never took', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      // Hold the lock from another session, so captureOnce takes the skipped
      // path. Releasing a lock it never acquired would log `WARNING: you
      // don't own a lock of type ExclusiveLock` on every skipped tick.
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

        // The holder still owns its advisory lock.
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


/** The two properties of the load row only a real store can show; its arithmetic is in capture.test.ts. */
describe('captureOnce and the load series', () => {
  it('writes no row for the first capture and one for the second', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      const withStore = { ...ctx, store: pool };

      await captureOnce(withStore, 'prod');
      // One cumulative snapshot is not an interval: a zero row would claim
      // the database was idle while it was not being watched.
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

  /**
   * A capture that failed or an outage leaves the snapshot before old, and a
   * reset leaves it measuring from another zero. Differenced anyway, one row
   * would carry hours of work, or a wrong amount, and swell every share.
   */
  it('writes no load row over a long gap or across a reset', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      const withStore = { ...ctx, store: pool };
      await captureOnce(withStore, 'prod');
      await pool.query("UPDATE pgops.query_stats SET captured_at = captured_at - interval '1 hour'");
      for (let i = 0; i < 20; i += 1) await pool.query('SELECT count(*) FROM pg_class');
      await captureOnce(withStore, 'prod');
      expect(await loadRows(pool)).toHaveLength(0);

      await pool.query(
        `INSERT INTO pgops.events (database_id, at, kind, relation)
         SELECT d.id, now(), 'reset', '' FROM pgops.databases d WHERE d.name = 'prod'`,
      );
      for (let i = 0; i < 20; i += 1) await pool.query('SELECT count(*) FROM pg_class');
      await captureOnce(withStore, 'prod');
      expect(await loadRows(pool)).toHaveLength(0);
    });
  }, 120_000);

  it('prunes the load series on the same retention as the snapshots', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
      await migrate(pool);
      const withStore = { ...ctx, store: pool };
      await captureOnce(withStore, 'prod');

      // A row older than query_stats' retention, planted directly.
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
