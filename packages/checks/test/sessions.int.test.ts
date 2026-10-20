import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { sessions } from '../src/checks/sessions.js';
import { withPostgres } from './harness.js';

describe('sessions', () => {
  it('is bounded (A7) and excludes its own backend', async () => {
    await withPostgres(async (ctx, pool) => {
      const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const ownPid = rows[0]!.pid;

      const r = await runCheck(ctx, sessions, { limit: 500 });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.sessions.length).toBeLessThanOrEqual(500);
      expect(r.data.sessions.some((x) => x.pid === ownPid)).toBe(false);
      // Well under the cap, with nothing else connected: nothing was dropped.
      expect(r.data.truncated).toBe(false);
    });
  }, 120_000);

  // Three sleeping backends give pg_stat_activity more 'active'
  // client-backend rows than the limit.
  it('caps the result set and reports truncation once more sessions exist than the cap', async () => {
    await withPostgres(async (ctx, pool) => {
      const sleepers = Promise.all([
        pool.query('SELECT pg_sleep(2)'),
        pool.query('SELECT pg_sleep(2)'),
        pool.query('SELECT pg_sleep(2)'),
      ]);
      // Let the sleepers register as 'active' before the check's own query.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const r = await runCheck(ctx, sessions, { limit: 1 });
      await sleepers;
      if (!r.ok) throw new Error(r.message);

      expect(r.data.sessions.length).toBeLessThanOrEqual(1);
      expect(r.data.truncated).toBe(true);
    });
  }, 120_000);

  // A client-side filter over the LIMITed page cannot find a session the cap
  // dropped; `SessionOpts.pid` must retrieve it server-side. `filler` is
  // 'active' and `idleClient` is 'idle', the lowest triage priority, so with
  // `limit: 1` the cap would keep `filler` and drop `idleClient`. Both are
  // dedicated connections, not `pool`, and `idleClient` connects after
  // `filler` so it gets the higher pid.
  it('finds a session by pid even when it would fall outside the truncation cap (A7 vs A10)', async () => {
    await withPostgres(async (ctx, pool) => {
      const connectionString = pool.options.connectionString;
      const filler = new pg.Client({ connectionString, application_name: 'pgops-test-filler' });
      await filler.connect();
      const fillerQuery = filler.query('SELECT pg_sleep(2)');

      const idleClient = new pg.Client({ connectionString, application_name: 'pgops-test-idle' });
      await idleClient.connect();
      const { rows } = await idleClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const idlePid = rows[0]!.pid;

      // Let `filler`'s sleep register as 'active' before the check runs.
      await new Promise((resolve) => setTimeout(resolve, 200));

      try {
        const r = await runCheck(ctx, sessions, { limit: 1, pid: idlePid });
        if (!r.ok) throw new Error(r.message);

        expect(r.data.sessions.map((x) => x.pid)).toEqual([idlePid]);
        expect(r.data.sessions[0]?.state).toBe('idle');
      } finally {
        await fillerQuery.catch(() => {});
        await filler.end();
        await idleClient.end();
      }
    });
  }, 120_000);

  it('reports the transaction age of an open transaction, and none for a session outside one', async () => {
    await withPostgres(async (ctx, pool) => {
      await pool.query('CREATE TABLE s_t (id int primary key)');
      await pool.query('INSERT INTO s_t VALUES (1)');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('UPDATE s_t SET id = id WHERE id = 1');
        await new Promise((r) => setTimeout(r, 300));

        const res = await runCheck(ctx, sessions, {});
        if (!res.ok) throw new Error(res.message);
        const open = res.data.sessions.find((s) => s.state === 'idle in transaction');
        expect(open).toBeDefined();
        expect(open!.xactAgeSecs).not.toBeNull();
        expect(open!.xactAgeSecs!).toBeGreaterThanOrEqual(0);
        const idle = res.data.sessions.find((s) => s.state === 'idle');
        if (idle) expect(idle.xactAgeSecs).toBeNull();
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });
  }, 120_000);
});

const client = async (connectionString: string, app: string) => {
  const c = new pg.Client({ connectionString, application_name: app });
  c.on('error', () => {});
  await c.connect();
  const { rows } = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return { c, pid: rows[0]!.pid };
};
const settle = () => new Promise((r) => setTimeout(r, 400));

describe('the fused sessions read', () => {
  it('places a holder and its waiter on the table, and classes both', async () => {
    await withPostgres(async (ctx, pool) => {
      const url = pool.options.connectionString!;
      await pool.query('CREATE TABLE t (id int primary key, n int)');
      await pool.query('INSERT INTO t VALUES (1, 0)');
      const holder = await client(url, 'holder');
      const waiter = await client(url, 'waiter');
      try {
        await holder.c.query('BEGIN');
        await holder.c.query('UPDATE t SET n = n + 1 WHERE id = 1');
        const blocked = waiter.c.query('UPDATE t SET n = n + 1 WHERE id = 1').catch(() => {});
        await settle();

        const r = await runCheck(ctx, sessions, {});
        if (!r.ok) throw new Error(r.message);
        const h = r.data.sessions.find((s) => s.pid === holder.pid)!;
        const w = r.data.sessions.find((s) => s.pid === waiter.pid)!;
        expect(h).toMatchObject({ cls: 'idle', relations: ['public.t'], blockedBy: [] });
        expect(w.wanted).toBeNull();          // a row lock: it waits on a transaction, not on the table
        expect(w).toMatchObject({ cls: 'lock', relations: ['public.t'], blockedBy: [holder.pid] });
        expect(w.waitSecs).not.toBeNull();
        expect(w.queryId).toBe(h.queryId);          // the same shape

        await holder.c.query('ROLLBACK');
        await blocked;
      } finally {
        await holder.c.end(); await waiter.c.end();
      }
    });
  }, 120_000);

  it('puts a statement queued for a table lock under that table', async () => {
    await withPostgres(async (ctx, pool) => {
      const url = pool.options.connectionString!;
      await pool.query('CREATE TABLE t (id int)');
      const reader = await client(url, 'reader');
      const ddl = await client(url, 'ddl');
      try {
        await reader.c.query('BEGIN');
        await reader.c.query('SELECT * FROM t');
        const queued = ddl.c.query('ALTER TABLE t ADD COLUMN x int').catch(() => {});
        await settle();
        const r = await runCheck(ctx, sessions, {});
        if (!r.ok) throw new Error(r.message);
        expect(r.data.sessions.find((s) => s.pid === ddl.pid)).toMatchObject({
          cls: 'lock', wanted: 'public.t', relations: ['public.t'],
        });
        await reader.c.query('ROLLBACK');
        await queued;
      } finally {
        await reader.c.end(); await ddl.c.end();
      }
    });
  }, 120_000);

  it('classes an aborted transaction, a sleep and a busy loop, and places a session that locks nothing nowhere', async () => {
    await withPostgres(async (ctx, pool) => {
      const url = pool.options.connectionString!;
      const aborted = await client(url, 'aborted');
      const bare = await client(url, 'bare');
      const sleeper = await client(url, 'sleeper');
      const busy = await client(url, 'busy');
      try {
        await aborted.c.query('BEGIN');
        await aborted.c.query('SELECT 1/0').catch(() => {});
        await bare.c.query('BEGIN');
        await bare.c.query('SELECT 1');
        const sleeping = sleeper.c.query('SELECT pg_sleep(3)');
        // A loop, not a big generate_series: that one spills to a temp file and
        // is sampled now and then in an IO wait.
        const working = busy.c.query('DO $$ DECLARE i int := 0; BEGIN WHILE i < 40000000 LOOP i := i + 1; END LOOP; END $$');
        await settle();
        const r = await runCheck(ctx, sessions, {});
        if (!r.ok) throw new Error(r.message);
        const of = (pid: number) => r.data.sessions.find((s) => s.pid === pid)!;
        expect(of(aborted.pid)).toMatchObject({ cls: 'idle', state: 'idle in transaction (aborted)' });
        expect(of(bare.pid)).toMatchObject({ cls: 'idle', relations: [] });
        expect(of(sleeper.pid).cls).toBe('other');
        expect(of(busy.pid).cls).toBe('cpu');
        await Promise.all([sleeping, working]);
      } finally {
        for (const x of [aborted, bare, sleeper, busy]) await x.c.end();
      }
    });
  }, 120_000);

  it('sees nothing of a second database on the same server', async () => {
    await withPostgres(async (ctx) => {
      const other = await client(inject('pgConnectionUri'), 'elsewhere');
      try {
        await other.c.query('BEGIN');
        await other.c.query('SELECT 1');
        const r = await runCheck(ctx, sessions, {});
        if (!r.ok) throw new Error(r.message);
        expect(r.data.sessions.some((s) => s.pid === other.pid)).toBe(false);
      } finally {
        await other.c.end();
      }
    });
  }, 120_000);

  it('lists an application\'s sessions though pgops connected under the same name', async () => {
    await withPostgres(async (ctx, pool) => {
      const url = new URL(pool.options.connectionString!);
      const app = await client(url.toString(), 'api');
      // A DSN carrying `?application_name=api` names pgops's own connection the same.
      const named = new pg.Pool({ connectionString: url.toString(), max: 1, application_name: 'api' });
      try {
        await app.c.query('BEGIN');
        await app.c.query('SELECT 1');
        const r = await runCheck({ ...ctx, target: named }, sessions, {});
        if (!r.ok) throw new Error(r.message);
        expect(r.data.sessions.find((x) => x.pid === app.pid)?.own).toBe(false);
      } finally {
        await named.end();
        await app.c.end();
      }
    });
  }, 120_000);

  it('counts what a restricted role cannot see and lists none of it', async () => {
    await withPostgres(async (ctx, pool) => {
      const url = new URL(pool.options.connectionString!);
      const role = `r_${Math.random().toString(36).slice(2, 8)}`;
      await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'x'`);
      const visible = await client(url.toString(), 'someone-else');
      url.username = role; url.password = 'x';
      const restricted = new pg.Pool({ connectionString: url.toString(), max: 1 });
      try {
        await visible.c.query('BEGIN');
        await visible.c.query('SELECT 1');
        const r = await runCheck({ ...ctx, target: restricted }, sessions, {});
        if (!r.ok) throw new Error(r.message);
        // Exactly this database's clients of other roles: no background process, no other database.
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE backend_type = 'client backend' AND datname = current_database() AND usename <> $1`, [role]);
        expect(r.data.hidden).toBe(rows[0]!.n);
        expect(r.data.sessions.some((s) => s.pid === visible.pid)).toBe(false);
      } finally {
        await visible.c.end(); await restricted.end();
        await pool.query(`DROP ROLE ${role}`);
      }
    });
  }, 120_000);
});
