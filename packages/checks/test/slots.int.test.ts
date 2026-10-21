import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { slots } from '../src/checks/slots.js';
import { withPostgres } from './harness.js';

const { Client } = pg;

/** Distinctive name — slots are cluster-wide and visible to every other test file. */
const SLOT = 'pgops_test_slots_active';

/** Polls `pg_replication_slots.active` until it matches `want` or `timeoutMs` elapses. */
async function waitForActive(pool: pg.Pool, want: boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ active: boolean }>(
      'SELECT active FROM pg_replication_slots WHERE slot_name = $1',
      [SLOT],
    );
    if (rows[0]?.active === want) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * `pg_drop_replication_slot` raises "replication slot ... is active for PID
 * ..." if called before the server has finished tearing down the walsender
 * that just disconnected, so the drop is retried briefly.
 */
async function dropSlotWithRetry(pool: pg.Pool, name: string, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await pool.query('SELECT pg_drop_replication_slot($1)', [name]);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

describe('slots', () => {
  it('measures retained WAL for a genuinely ACTIVE slot too (A6)', async () => {
    await withPostgres(async (ctx, pool) => {
      // The slot and the replication connection are both created inside this
      // try: a replication connect() can fail after the slot was created, and
      // a slot is cluster-wide, so an un-dropped one retains WAL in the
      // shared container for every later test file.
      let slotCreated = false;
      let replClient: pg.Client | undefined;
      let streamDone: Promise<unknown> | undefined;
      try {
        // immediately_reserve=true: without it restart_lsn stays NULL until a
        // consumer first connects.
        const { rows: created } = await pool.query<{ slot_name: string; lsn: string }>(
          "SELECT * FROM pg_create_physical_replication_slot($1, true)",
          [SLOT],
        );
        slotCreated = true;
        const startLsn = created[0]!.lsn;

        // A real walsender connection, held open and never advanced, is what
        // makes the slot active. `replication` is a real startup parameter
        // that @types/pg's `ClientConfig` does not declare, hence the cast.
        replClient = new Client({
          connectionString: pool.options.connectionString,
          replication: 'database',
        } as unknown as pg.ClientConfig);
        await replClient.connect();
        streamDone = replClient
          .query(`START_REPLICATION SLOT ${SLOT} PHYSICAL ${startLsn}`)
          .catch(() => { /* resolves with an error once we end() below; expected */ });

        const becameActive = await waitForActive(pool, true);
        expect(becameActive).toBe(true);

        // Move WAL forward without feeding it back to the slot: restart_lsn
        // stays pinned at startLsn while pg_current_wal_lsn() moves.
        await pool.query('CREATE TABLE IF NOT EXISTS pgops_wal_bump (id int)');
        await pool.query('INSERT INTO pgops_wal_bump SELECT generate_series(1, 500)');

        const r = await runCheck(ctx, slots);
        if (!r.ok) throw new Error(r.message);
        const slot = r.data.slots.find((s) => s.name === SLOT);
        expect(slot).toBeDefined();
        // The active branch specifically: a `FILTER (WHERE NOT active)` would
        // zero retained bytes exactly when this is true.
        expect(slot!.active).toBe(true);
        expect(slot!.retainedBytes).not.toBeNull();
        expect(slot!.retainedBytes as number).toBeGreaterThan(0);
      } finally {
        if (replClient) await replClient.end().catch(() => {});
        if (streamDone) await streamDone;
        if (slotCreated) {
          await waitForActive(pool, false);
          await dropSlotWithRetry(pool, SLOT);
        }
      }
    });
  }, 120_000);

  it('SQL branches on pg_is_in_recovery() (A6)', () => {
    const text = typeof slots.sql === 'string' ? slots.sql : slots.sql(undefined as never).text;
    expect(text).toContain('pg_is_in_recovery()');
    expect(text).toContain('pg_last_wal_receive_lsn()');
  });

  /**
   * Proves only the primary branch of the CASE. The harness runs one node, so
   * the `pg_last_wal_receive_lsn()` branch is not exercised here;
   * `pg_current_wal_lsn()` raises "recovery is in progress" on a standby,
   * which is why the CASE exists.
   */
  it('resolves the recovery-safe CASE to pg_current_wal_lsn() on a primary, without erroring', async () => {
    await withPostgres(async (_ctx, pool) => {
      const { rows } = await pool.query<{ in_recovery: boolean; lsn: string | null; direct: string | null }>(
        `SELECT pg_is_in_recovery() AS in_recovery,
                (CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn()
                      ELSE pg_current_wal_lsn() END)::text AS lsn,
                pg_current_wal_lsn()::text AS direct`,
      );
      expect(rows[0]!.in_recovery).toBe(false);
      expect(rows[0]!.lsn).not.toBeNull();
      expect(rows[0]!.lsn).toBe(rows[0]!.direct);
    });
  }, 120_000);

});
