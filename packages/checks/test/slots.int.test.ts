import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import { slots } from '../src/checks/slots.js';
import { withPostgres } from './harness.js';

const { Client } = pg;

/** Distinctive name — slots are cluster-wide and visible to every other test file. */
const SLOT = 'pgops_test_slots_active';

/**
 * Repeatedly polls `pg_replication_slots.active` until it matches `want` or
 * `timeoutMs` elapses. A fixed `setTimeout` sleep would either race under
 * CI's slower scheduling or waste time locally; polling adapts to both.
 */
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
 * that just disconnected — a race, not a bug in the drop itself. Retrying
 * briefly is cheaper and less flaky than trying to synchronize on the exact
 * moment the backend releases the slot.
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
      // Both the slot and the replication connection are created INSIDE this
      // try, and cleanup covers both regardless of which succeeded: a
      // replication connect() can fail for ordinary reasons (pg_hba.conf,
      // wal_level, max_wal_senders exhaustion, a transient error) even after
      // the slot itself was created successfully. A slot is CLUSTER-WIDE and
      // outlives this test's own database — an un-dropped one retains WAL in
      // the shared container for every test file that runs afterward (see
      // the file-top comment on SLOT). Fix round 1: this used to create the
      // slot and connect() ahead of the try, so a failed connect() leaked it.
      let slotCreated = false;
      let replClient: pg.Client | undefined;
      let streamDone: Promise<unknown> | undefined;
      try {
        // immediately_reserve=true: without it restart_lsn stays NULL until a
        // consumer first connects, which would make this fixture indistinguishable
        // from "slot never used" rather than "consumer connected, not advancing".
        const { rows: created } = await pool.query<{ slot_name: string; lsn: string }>(
          "SELECT * FROM pg_create_physical_replication_slot($1, true)",
          [SLOT],
        );
        slotCreated = true;
        const startLsn = created[0]!.lsn;

        // A real walsender connection, held open and never advanced — this is
        // what makes the slot ACTIVE, not merely present. The old query's
        // `FILTER (WHERE NOT active)` excluded exactly this row.
        //
        // `replication` is a genuine libpq/node-pg startup parameter (used by
        // every logical-replication client built on node-pg) but @types/pg's
        // `ClientConfig` doesn't declare it, so this object literal needs an
        // `as unknown as` widening to accept it. `pool.options.connectionString`
        // itself typechecks fine without any cast — only the extra `replication`
        // field is the reason this widening exists.
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

        // Force some WAL forward without ever feeding it back to the slot —
        // restart_lsn stays pinned at startLsn while pg_current_wal_lsn() moves,
        // exactly like a connected-but-stalled logical consumer.
        await pool.query('CREATE TABLE IF NOT EXISTS pgops_wal_bump (id int)');
        await pool.query('INSERT INTO pgops_wal_bump SELECT generate_series(1, 500)');

        const r = await runCheck(ctx, slots);
        if (!r.ok) throw new Error(r.message);
        const slot = r.data.slots.find((s) => s.name === SLOT);
        expect(slot).toBeDefined();
        // Proves the ACTIVE branch specifically, not merely "the slot exists":
        // the pre-fix query zeroed retained bytes exactly when this is true.
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
   * What this DOES prove: against a real (single-node, primary) Postgres,
   * `pg_is_in_recovery()` evaluates to false and Postgres picks the
   * `pg_current_wal_lsn()` branch of the CASE without erroring — the same
   * branch the full check's own query above already exercises every time it
   * runs in this harness.
   *
   * What this does NOT prove: that the `pg_last_wal_receive_lsn()` branch
   * returns the right value on an actual standby. This harness runs one
   * Postgres node; there is no streaming replica to observe recovery=true
   * against. `pg_current_wal_lsn()` itself is documented to raise
   * "recovery is in progress" when called on a real standby — that failure
   * mode, and the CASE's other branch, are asserted structurally above
   * (the SQL text contains both recovery-safe calls) but not exercised.
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
      // On a primary the CASE must land on the pg_current_wal_lsn() branch —
      // confirmed by equality with a direct, unconditional call to it.
      expect(rows[0]!.lsn).toBe(rows[0]!.direct);
    });
  }, 120_000);

  it('escalates on retained bytes at the documented boundary', () => {
    const t = slots.thresholds!;
    const warn = t.find((x) => x.level === 'warn')!.value;
    const crit = t.find((x) => x.level === 'critical')!.value;
    const at = (bytes: number) => slots.verdict!(
      { slots: [{ name: 's', database: 'd', active: false, slotType: 'physical', retainedBytes: bytes }] },
      t,
    ).level;
    // I5/spec §9: each threshold at its value and one byte either side. The
    // warn threshold had no boundary assertion at all before.
    expect(at(warn - 1)).toBe('ok');
    expect(at(warn)).toBe('warn');
    expect(at(warn + 1)).toBe('warn');

    expect(at(crit - 1)).toBe('warn');
    expect(at(crit - 1)).not.toBe('critical');
    expect(at(crit)).toBe('critical');
    expect(at(crit + 1)).toBe('critical');
  });
});
