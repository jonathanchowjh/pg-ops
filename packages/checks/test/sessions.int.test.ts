import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { sessions, sessionStates } from '../src/checks/sessions.js';
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

  // A7: proves the truncation signal is real against Postgres, not just the
  // pure `map` unit test. Three concurrently-sleeping backends give
  // pg_stat_activity more 'active' client-backend rows than the limit, so a
  // regression to a bare `LIMIT $1` (no truncation signal) would make this
  // pass with `truncated` silently `false`.
  it('caps the result set and reports truncation once more sessions exist than the cap', async () => {
    await withPostgres(async (ctx, pool) => {
      const sleepers = Promise.all([
        pool.query('SELECT pg_sleep(2)'),
        pool.query('SELECT pg_sleep(2)'),
        pool.query('SELECT pg_sleep(2)'),
      ]);
      // Let the sleeping backends actually register as 'active' before the
      // check's own query (on the pool's 4th connection) runs.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const r = await runCheck(ctx, sessions, { limit: 1 });
      await sleepers;
      if (!r.ok) throw new Error(r.message);

      expect(r.data.sessions.length).toBeLessThanOrEqual(1);
      expect(r.data.truncated).toBe(true);
    });
  }, 120_000);

  // Fix-round 1 (A7 vs A10): before this fix, `SessionOpts` had no `pid`
  // field at all, and the only way to "find" a session was
  // `prepareSessions`'s client-side filter over whatever page `LIMIT`
  // returned. `filler` and `idleClient` are dedicated, sequentially-awaited
  // raw connections (deliberately NOT sharing `pool`, whose internal
  // connection reuse would make relative pid order non-deterministic) —
  // `idleClient` connects strictly after `filler` finishes connecting, so
  // Postgres's monotonic backend-pid assignment guarantees it gets the
  // HIGHER pid. `filler` stays 'active' (a real pg_sleep in flight);
  // `idleClient` is genuinely 'idle' (connected, no query running) — the
  // lowest triage priority under both the OLD `ORDER BY pid ASC` and the
  // fixed severity-first ordering. With `limit: 1`, `ORDER BY pid ASC
  // LIMIT 1` (the pre-fix SQL) keeps `filler`'s row and drops `idleClient`'s
  // — this is the exact historical bug shape, verified by temporarily
  // running this test against the pre-fix `sessions.ts` during the fix
  // round (see the fix report). `SessionOpts.pid` must retrieve
  // `idleClient`'s row directly, regardless.
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

      // Give `filler`'s sleep a moment to actually register as 'active'
      // before the check's own query runs.
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

  it('censuses states', async () => {
    await withPostgres(async (ctx) => {
      const r = await runCheck(ctx, sessionStates);
      if (!r.ok) throw new Error(r.message);
      expect(r.data.byState.length).toBeGreaterThan(0);
    });
  }, 120_000);

  /**
   * B12. The unit tests pin what `map` does with an `oldest` row; only a real
   * server proves the second branch of the statement produces one, that its
   * LIMIT 1 is scoped to that branch rather than to the whole UNION (which
   * would return a one-row census), and that the pid it names is really
   * idle in transaction.
   */
  it('names the oldest idle-in-transaction session, without truncating the census', async () => {
    await withPostgres(async (ctx, pool) => {
      const uri = (pool as unknown as { options: { connectionString: string } }).options.connectionString;
      const holder = new pg.Client({ connectionString: uri, application_name: 'states-holder' });
      holder.on('error', () => {});
      try {
        await holder.connect();
        await holder.query('BEGIN');
        await holder.query('SELECT 1');
        const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

        const r = await runCheck(ctx, sessionStates);
        if (!r.ok) throw new Error(r.message);
        // The census survives the UNION: a LIMIT that escaped its own branch
        // would clip this to one row.
        expect(r.data.byState.length).toBeGreaterThan(0);
        expect(r.data.oldestIdleInTxnPid).toBe(rows[0]!.pid);
        expect(r.data.oldestIdleInTxnApp).toBe('states-holder');
        expect(r.data.oldestIdleInTxnSecs).not.toBeNull();
      } finally {
        await holder.end().catch(() => {});
      }
    });
  }, 120_000);
});
