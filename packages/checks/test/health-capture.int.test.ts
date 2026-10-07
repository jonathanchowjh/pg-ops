import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { captureHealth } from '../src/health.js';
import { migrate } from '../src/store/schema.js';
import { awaitPublished, withPostgres } from './harness.js';

const { Pool } = pg;

async function rows(pool: pg.Pool, name: string) {
  const { rows: r } = await pool.query(
    `SELECT h.* FROM pgops.health_stats h JOIN pgops.databases d ON d.id = h.database_id
      WHERE d.name = $1 ORDER BY h.captured_at`, [name]);
  return r;
}

/**
 * Postgres publishes a backend's counters when it next reports, up to a
 * second later, so a database created a moment ago can still show zero
 * commits. Wait for the first to appear before asserting on them.
 */
async function counted(pool: pg.Pool) {
  await awaitPublished(pool, 'the first commit',
    'SELECT xact_commit > 0 AS ready FROM pg_stat_database WHERE datname = current_database()');
}

/** Make the newest row old enough that the 45-second guard lets another through. */
async function age(pool: pg.Pool) {
  await pool.query(`UPDATE pgops.health_stats SET captured_at = captured_at - interval '61 seconds'`);
}

describe('captureHealth', () => {
  it('reports missing-store rather than throwing', async () => {
    await withPostgres(async (ctx) => {
      expect(await captureHealth(ctx, 'prod')).toMatchObject({ ok: false, reason: 'missing-store' });
    });
  });

  it('stores one row with every part read', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await counted(pool);
      const outcome = await captureHealth({ ...ctx, store: pool }, 'prod', 4);
      expect(outcome).toEqual({ ok: true, missing: [] });
      const [row] = await rows(pool, 'prod');
      expect(row.connections).toBeGreaterThan(0);
      expect(row.server_connections).toBeGreaterThanOrEqual(row.connections);
      expect(row.max_connections).toBeGreaterThan(0);
      expect(row.blocked).toBe(0);
      expect(row.longest_wait_secs).toBe(0);
      expect(Number(row.xact_commit)).toBeGreaterThan(0);
      expect(Number(row.size_bytes)).toBeGreaterThan(0);
      expect(Number(row.wal_bytes)).toBeGreaterThan(0);
      expect(Number(row.xid_age)).toBeGreaterThan(0);
      expect(row.own_statements).toBe(4);
      // A primary with no standby has no lag figure. Null, not zero.
      expect(row.replication_lag_secs).toBeNull();
    });
  });

  it('skips a database whose newest row is under 45 seconds old', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      const withStore = { ...ctx, store: pool };
      expect(await captureHealth(withStore, 'prod')).toMatchObject({ ok: true });
      expect(await captureHealth(withStore, 'prod')).toEqual({ ok: 'skipped', reason: 'fresh' });
      await age(pool);
      expect(await captureHealth(withStore, 'prod')).toMatchObject({ ok: true });
      expect(await rows(pool, 'prod')).toHaveLength(2);
    });
  });

  it('writes one row when two ticks race', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      const withStore = { ...ctx, store: pool };
      const outcomes = await Promise.all([
        captureHealth(withStore, 'prod'), captureHealth(withStore, 'prod'), captureHealth(withStore, 'prod'),
      ]);
      expect(outcomes.filter((o) => o.ok === true)).toHaveLength(1);
      expect(await rows(pool, 'prod')).toHaveLength(1);
    });
  });

  it('leaves the pooled connection without a statement timeout', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await captureHealth({ ...ctx, store: pool }, 'prod');
      // max: 4 in the harness; ask every connection the pool can hand out.
      const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect(), pool.connect()]);
      try {
        for (const c of clients) {
          const { rows: r } = await c.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t");
          expect(r[0]!.t).toBe('0');
        }
      } finally {
        for (const c of clients) c.release();
      }
    });
  });

  /**
   * THE ATTRIBUTION RULE. Two databases on one server, a lock chain in one.
   * The live `blocked` check would report it from either; the stored row for
   * the quiet database must say zero.
   */
  it('does not charge one database with another database\'s lock chain', async () => {
    await withPostgres(async (ctxA, poolA) => {
      await withPostgres(async (ctxB) => {
        await migrate(poolA);
        await poolA.query('CREATE TABLE held (id int)');
        const holder = await poolA.connect();
        const waiter = await poolA.connect();
        try {
          await holder.query('BEGIN');
          await holder.query('LOCK TABLE held IN ACCESS EXCLUSIVE MODE');
          const waiting = waiter.query('SELECT count(*) FROM held').catch(() => {});
          await awaitPublished(poolA, 'the lock wait',
            `SELECT count(*) > 0 AS ready FROM pg_stat_activity
              WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`);

          expect(await captureHealth({ ...ctxA, store: poolA }, 'busy')).toMatchObject({ ok: true });
          expect(await captureHealth({ ...ctxB, store: poolA }, 'quiet')).toMatchObject({ ok: true });

          const [busy] = await rows(poolA, 'busy');
          const [quiet] = await rows(poolA, 'quiet');
          expect(busy.blocked).toBe(1);
          expect(busy.longest_wait_secs).toBeGreaterThan(0);
          expect(quiet.blocked).toBe(0);
          expect(quiet.longest_wait_secs).toBe(0);
          // The server total is the same from both; the per-database counts are not.
          expect(Math.abs(busy.server_connections - quiet.server_connections)).toBeLessThanOrEqual(2);

          await holder.query('ROLLBACK');
          await waiting;
        } finally {
          holder.release();
          waiter.release();
        }
      });
    });
  });

  /**
   * Review Focus 1. A role that cannot see other sessions' state must store
   * null session counts, and everything it CAN read must still land.
   */
  it('stores null session counts for a role that cannot see other sessions', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      await counted(pool);
      const role = `blind_${Math.random().toString(36).slice(2, 8)}`;
      await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'blind'`);
      const { rows: db } = await pool.query<{ d: string }>('SELECT current_database() AS d');
      const uri = new URL(inject('pgConnectionUri'));
      uri.pathname = `/${db[0]!.d}`;
      uri.username = role;
      uri.password = 'blind';
      const blind = new Pool({ connectionString: uri.toString(), max: 2 });
      try {
        const outcome = await captureHealth({ ...ctx, target: blind, store: pool }, 'prod');
        expect(outcome).toMatchObject({ ok: true });
        const [row] = await rows(pool, 'prod');
        expect(row.connections).toBeNull();
        expect(row.server_connections).toBeNull();
        expect(row.active).toBeNull();
        expect(row.idle_in_txn).toBeNull();
        expect(row.max_connections).toBeGreaterThan(0);
        expect(Number(row.xact_commit)).toBeGreaterThan(0);
        expect(row.blocked).toBe(0);
      } finally {
        await blind.end().catch(() => {});
        await pool.query(`DROP ROLE ${role}`);
      }
    });
  });

  it('writes no row for a database it cannot reach', async () => {
    await withPostgres(async (ctx, pool) => {
      await migrate(pool);
      const dead = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', max: 1, connectionTimeoutMillis: 1_000 });
      dead.on('error', () => {});
      try {
        const outcome = await captureHealth({ ...ctx, target: dead, store: pool }, 'gone');
        expect(outcome).toMatchObject({ ok: false, reason: 'unreachable' });
        expect(await rows(pool, 'gone')).toHaveLength(0);
      } finally {
        await dead.end().catch(() => {});
      }
    });
  });
});
