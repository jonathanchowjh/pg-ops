import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureHealth } from '../src/health.js';
import { migrate } from '../src/store/schema.js';
import { withPostgres } from './harness.js';

const { Pool } = pg;
const IMAGE = `postgres:${process.env.PGOPS_TEST_PG_VERSION ?? '17'}`;

/**
 * A real primary with a real streaming standby. Nothing else in the suite
 * has one: every replication check is asserted on a lone primary, and the
 * health sample's two replication branches (a primary reading its standbys,
 * a standby reading itself) had never run against the thing they measure.
 */
let network: StartedNetwork;
let primary: StartedPostgreSqlContainer;
let standby: StartedTestContainer;
let primaryPool: pg.Pool;
let standbyPool: pg.Pool;
let serverVersion: number;

beforeAll(async () => {
  network = await new Network().start();
  primary = await new PostgreSqlContainer(IMAGE)
    .withNetwork(network)
    .withNetworkAliases('primary')
    .start();
  primaryPool = new Pool({ connectionString: primary.getConnectionUri(), max: 4 });
  // The image's pg_hba.conf admits replication from localhost only.
  await primary.exec(['bash', '-c', 'echo "host replication all all trust" >> "$PGDATA/pg_hba.conf"']);
  await primaryPool.query('SELECT pg_reload_conf()');

  standby = await new GenericContainer(IMAGE)
    .withNetwork(network)
    .withUser('postgres')
    .withEnvironment({ PGPASSWORD: primary.getPassword() })
    .withCommand(['bash', '-c',
      'mkdir -p /tmp/sb && chmod 700 /tmp/sb'
      + ` && pg_basebackup -h primary -U ${primary.getUsername()} -D /tmp/sb -R -X stream`
      + " && exec postgres -D /tmp/sb -c listen_addresses='*'"])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/ready to accept read-only connections/))
    .start();
  const uri = new URL(primary.getConnectionUri());
  uri.hostname = standby.getHost();
  uri.port = String(standby.getMappedPort(5432));
  standbyPool = new Pool({ connectionString: uri.toString(), max: 2 });

  const { rows } = await primaryPool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
  serverVersion = Number(rows[0]!.v);
}, 240_000);

afterAll(async () => {
  await standbyPool?.end().catch(() => {});
  await primaryPool?.end().catch(() => {});
  await standby?.stop().catch(() => {});
  await primary?.stop().catch(() => {});
  await network?.stop().catch(() => {});
});

async function until(what: string, fn: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Whether the one standby is streaming, has replayed all it was sent, and reports no lag figure. */
async function idleAndCaughtUp(): Promise<boolean> {
  const { rows } = await primaryPool.query<{ idle: boolean | null }>(
    `SELECT bool_and(state = 'streaming' AND sent_lsn = replay_lsn AND replay_lag IS NULL) AS idle
       FROM pg_stat_replication`,
  );
  return rows[0]?.idle === true;
}

async function newestLag(store: pg.Pool, name: string): Promise<number | null> {
  const { rows } = await store.query<{ lag: number | null }>(
    `SELECT h.replication_lag_secs AS lag FROM pgops.health_stats h
       JOIN pgops.databases d ON d.id = h.database_id
      WHERE d.name = $1 ORDER BY h.captured_at DESC LIMIT 1`, [name]);
  return rows[0]?.lag ?? null;
}

describe('captureHealth, with a real standby', () => {
  /**
   * Postgres nulls `replay_lag` once a caught-up standby has been idle for a
   * moment. The first version of the sample took max(replay_lag) and so
   * stored NULL, which the page words as "No standby reported a replay lag.
   * None is attached…" — for a healthy standby on a quiet primary.
   *
   * The reading is only meaningful if the standby was idle both before and
   * after the sample, so the test keeps sampling until it gets one bracketed
   * that way.
   */
  /**
   * THE STORE IS A DIFFERENT SERVER, on purpose. With the store on the
   * primary, every capture writes to the primary a moment before sampling
   * it, and the standby is never idle when looked at: the first version of
   * this test did that and timed out without ever seeing the state it was
   * written for.
   */
  it('reads a caught-up idle standby as zero lag, not as no standby', async () => {
    await withPostgres(async (_ctx, store) => {
      await migrate(store);
      const ctx = { target: primaryPool, store, serverVersion };
      let attempt = 0;
      let name = '';
      await until('a sample bracketed by an idle, caught-up standby', async () => {
        if (!(await idleAndCaughtUp())) return false;
        attempt += 1;
        name = `primary-${attempt}`; // a fresh name each time, so the 45-second guard never skips
        expect(await captureHealth(ctx, name)).toMatchObject({ ok: true });
        return idleAndCaughtUp();
      });
      expect(await newestLag(store, name)).toBe(0);
    });
  });

  it('samples a standby itself: every part reads in recovery, and its own lag is a number', async () => {
    const { rows: rec } = await standbyPool.query<{ r: boolean }>('SELECT pg_is_in_recovery() AS r');
    expect(rec[0]!.r).toBe(true);
    let row: Record<string, unknown> = {};
    await withPostgres(async (_ctx, store) => {
      await migrate(store);
      const outcome = await captureHealth({ target: standbyPool, store, serverVersion }, 'standby');
      expect(outcome).toEqual({ ok: true, missing: [] });
      const { rows } = await store.query(
        `SELECT h.* FROM pgops.health_stats h JOIN pgops.databases d ON d.id = h.database_id
          WHERE d.name = 'standby'`);
      row = rows[0];
    });
    expect(row.replication_lag_secs).not.toBeNull();
    expect(row.replication_lag_secs).toBeGreaterThanOrEqual(0);
    expect(row.connections).toBeGreaterThan(0);
    expect(Number(row.size_bytes)).toBeGreaterThan(0);
    expect(Number(row.xid_age)).toBeGreaterThan(0);
    expect(row.blocked).toBe(0);
    expect(row.wal_bytes).not.toBeNull();
  });
});
