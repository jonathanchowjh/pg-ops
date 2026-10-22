import { describe, expect, it } from 'vitest';
import { OWN_SQL_MARKER, runCheck } from '../src/run.js';
import type { Check } from '../src/types.js';
import { HEALTH_PARTS, healthRow, sampleHealth, type HealthParts } from '../src/health.js';

const PARTS: HealthParts = {
  database: {
    deadlocks: '2', xact_commit: '9000000000', xact_rollback: '5',
    stats_reset: new Date('2026-10-01T00:00:00Z'), xid_age: '1200',
    wal_bytes: '123456789012345678901',
  },
  activity: { server_connections: 40, connections: 12, max_connections: 97 },
  replication: { replication_lag_secs: null, replication_lag_bytes: null },
  xmin: { xmin_age: '77' },
  size: { size_bytes: '8000000' },
};

describe('healthRow', () => {
  it('carries every part into its columns, counters untouched', () => {
    const row = healthRow(PARTS);
    expect(row.xact_commit).toBe('9000000000');
    expect(row.wal_bytes).toBe('123456789012345678901');
    expect(row).toMatchObject({
      connections: 12, server_connections: 40, max_connections: 97, deadlocks: '2',
      xid_age: '1200', xmin_age: '77', replication_lag_secs: null, replication_lag_bytes: null,
    });
    expect(healthRow({ ...PARTS, replication: { replication_lag_secs: 2.5, replication_lag_bytes: '16777216' } }))
      .toMatchObject({ replication_lag_secs: 2.5, replication_lag_bytes: '16777216' });
  });

  it('stores null, not zero, for a part that could not be read', () => {
    const row = healthRow({ ...PARTS, activity: null, database: null });
    expect(row.connections).toBeNull();
    expect(row.max_connections).toBeNull();
    expect(row.xact_commit).toBeNull();
    expect(row.size_bytes).toBe('8000000');
    expect(row.xmin_age).toBe('77');
  });

  /** The samples are the one session read: the row holds no count that needs a session's state. */
  it('holds nothing a restricted role could not read whole', () => {
    expect(Object.keys(healthRow(PARTS)).sort()).toEqual([
      'connections', 'deadlocks', 'max_connections', 'replication_lag_bytes', 'replication_lag_secs', 'server_connections',
      'size_bytes', 'stats_reset', 'wal_bytes', 'xact_commit', 'xact_rollback', 'xid_age', 'xmin_age',
    ]);
  });
});

/**
 * pg_database_size stats every relation file and can time out on a database
 * with many relations. Read with the counters, it would take every rate
 * chart with it.
 */
describe('the size part', () => {
  it('fails alone: the counters still land', () => {
    const row = healthRow({ ...PARTS, size: null });
    expect(row.size_bytes).toBeNull();
    expect(row.xact_commit).toBe('9000000000');
  });

  it('is sampled last, so its timeout costs nothing else', () => {
    expect(HEALTH_PARTS[HEALTH_PARTS.length - 1]).toBe('size');
  });
});

/** A pool whose one client records what it is sent and fails where told to. */
function fakePool(fail: (sql: string) => unknown) {
  const sent: string[] = [];
  let released = 0;
  const client = {
    on() {}, removeListener() {}, release() { released += 1; },
    query: async (sql: string) => {
      sent.push(sql);
      const err = fail(sql);
      if (err) throw err;
      return { rows: [{}] };
    },
  };
  return { pool: { connect: async () => client } as never, sent, released: () => released };
}

describe('sampleHealth', () => {
  /**
   * A session-level SET through a transaction-mode pooler (PgBouncer) lands
   * on a server connection the application shares, and the RESET may land on
   * another: the application's own statements then die at five seconds.
   * SET LOCAL inside a transaction cannot outlive it.
   */
  it('sets its timeout inside a transaction, never on the session', async () => {
    const { pool, sent, released } = fakePool(() => undefined);
    const { missing } = await sampleHealth(pool);
    expect(missing).toEqual([]);
    expect(sent.filter((s) => /^SET LOCAL statement_timeout = \d+/.test(s))).toHaveLength(HEALTH_PARTS.length);
    expect(sent.filter((s) => s.startsWith('BEGIN'))).toHaveLength(HEALTH_PARTS.length);
    expect(sent.filter((s) => s.startsWith('COMMIT'))).toHaveLength(HEALTH_PARTS.length);
    expect(sent.filter((s) => /^(SET statement_timeout|RESET)/.test(s))).toEqual([]);
    expect(released()).toBe(1);
  });

  /**
   * A database that has stopped answering would otherwise cost one timeout
   * per part, serially, and delay every other database's rows until they
   * arrive too far apart to join.
   */
  it('stops asking after the first timeout', async () => {
    const { pool, sent } = fakePool((sql) => (
      sql.includes('pg_stat_database') ? Object.assign(new Error('canceling statement'), { code: '57014' }) : undefined
    ));
    const { missing } = await sampleHealth(pool);
    expect(missing).toEqual([...HEALTH_PARTS]);
    expect(sent.some((s) => s.includes('pg_stat_activity'))).toBe(false);
    expect(sent.filter((s) => s.startsWith('ROLLBACK'))).toHaveLength(1);
  });

  it('carries on past a failure that is not a timeout', async () => {
    const { pool, sent } = fakePool((sql) => (
      sql.includes('pg_stat_replication') ? Object.assign(new Error('permission denied'), { code: '42501' }) : undefined
    ));
    const { missing } = await sampleHealth(pool);
    expect(missing).toEqual(['replication']);
    expect(sent.some((s) => s.includes('pg_prepared_xacts'))).toBe(true);
  });
});

/**
 * A bare BEGIN or COMMIT around a timed statement escapes the ranking's
 * exclusion, which looks for the marker, and shows up on the Queries page as
 * one of the most-called statements.
 */
describe('transaction control is marked as pgops\'s own', () => {
  it('on every statement the health sample sends, including on rollback', async () => {
    const ok = fakePool(() => undefined);
    await sampleHealth(ok.pool);
    expect(ok.sent.filter((s) => !s.endsWith(OWN_SQL_MARKER))).toEqual([]);
    const failing = fakePool((sql) => (sql.includes('pg_stat_wal') ? new Error('boom') : undefined));
    await sampleHealth(failing.pool);
    expect(failing.sent.filter((s) => !s.endsWith(OWN_SQL_MARKER))).toEqual([]);
  });

  it('on every statement a timed check sends', async () => {
    const { pool, sent } = fakePool(() => undefined);
    const check: Check<unknown, number> = {
      id: 'probe', home: 'database', class: 'live', timeoutMs: 1_000,
      sql: 'SELECT 1', map: (rows) => rows.length,
    };
    const res = await runCheck({ target: pool, serverVersion: 170000 }, check);
    expect(res.ok).toBe(true);
    // BEGIN, the two timeouts, the statement, COMMIT.
    expect(sent).toHaveLength(5);
    expect(sent.some((s) => s.startsWith('SET LOCAL lock_timeout = 1000'))).toBe(true);
    expect(sent.filter((s) => !s.endsWith(OWN_SQL_MARKER))).toEqual([]);
  });

  /** A relation a migration holds must fail a catalog read in a second, not hold it for its statement timeout. */
  it('waits on a lock for at most a second, and never longer than the statement may run', async () => {
    const lockTimeout = async (timeoutMs: number): Promise<string | undefined> => {
      const { pool, sent } = fakePool(() => undefined);
      const check: Check<unknown, number> = {
        id: 'probe', home: 'database', class: 'live', timeoutMs, sql: 'SELECT 1', map: (rows) => rows.length,
      };
      await runCheck({ target: pool, serverVersion: 170000 }, check);
      return sent.find((s) => s.startsWith('SET LOCAL lock_timeout'))?.split('\n')[0];
    };
    expect(await lockTimeout(10_000)).toBe('SET LOCAL lock_timeout = 1000');
    expect(await lockTimeout(250)).toBe('SET LOCAL lock_timeout = 250');
  });
});
