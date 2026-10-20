import type { Check, Verdict } from '../types.js';
import { escalate } from './shared.js';

const GB = 1024 ** 3;

export interface SlotRow {
  slot_name: string;
  /** NULL for a physical slot; the database a logical slot is scoped to. */
  database: string | null;
  active: boolean;
  slot_type: string;
  /** `pg_wal_lsn_diff` is `numeric`; cast `::text` and converted in `map`. */
  retained_bytes: string | null;
}

export interface Slot {
  name: string;
  database: string | null;
  active: boolean;
  slotType: string;
  retainedBytes: number | null;
}

export interface SlotsData { slots: Slot[] }

/**
 * Retained WAL for every slot, active or not: an active slot whose consumer
 * is connected but not advancing retains unbounded WAL.
 *
 * `pg_current_wal_lsn()` raises "recovery is in progress" on a standby, so
 * the reference LSN branches on `pg_is_in_recovery()`.
 *
 * No LIMIT: slots are capped by `max_replication_slots`.
 *
 * MATERIALIZED so the CASE is evaluated once per row; `retained_bytes_num`
 * is read by both the SELECT and the ORDER BY.
 */
const SQL = `
WITH slot_wal AS MATERIALIZED (
  SELECT slot_name, database, active, slot_type,
         pg_wal_lsn_diff(
           CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn()
                ELSE pg_current_wal_lsn() END,
           restart_lsn) AS retained_bytes_num
  FROM pg_replication_slots
)
SELECT slot_name, database, active, slot_type,
       retained_bytes_num::text AS retained_bytes
FROM slot_wal
-- ORDER BY the CTE's numeric column, never the ::text output: an
-- unqualified name resolves against the output columns first, and text
-- sorts '20000000000' ahead of '5000000000'.
ORDER BY retained_bytes_num DESC NULLS LAST, slot_name`;

export const slots: Check<SlotRow, SlotsData> = {
  id: 'slots',
  home: 'server',
  title: 'Replication slots',
  class: 'live',
  sql: SQL,
  map: (rows) => ({
    slots: rows.map((r) => ({
      name: r.slot_name,
      database: r.database,
      active: r.active,
      slotType: r.slot_type,
      // `Number(...)` loses precision only past 2^53 bytes (~8 exabytes).
      retainedBytes: r.retained_bytes == null ? null : Number(r.retained_bytes),
    })),
  }),
  thresholds: [
    { level: 'warn', value: 1 * GB, unit: 'bytes',
      because: 'a gigabyte of retained WAL means a consumer has been behind long enough '
             + 'that it is not going to catch up on its own',
      remedy: 'Establish whether the consumer is behind or gone. An abandoned slot '
            + 'retains WAL forever; a live but slow one needs the consumer fixed, not '
            + 'the slot dropped.' },
    { level: 'critical', value: 20 * GB, unit: 'bytes',
      because: 'twenty gigabytes is a meaningful fraction of a typical primary volume, '
             + 'and a full pg_wal takes the whole instance down, not just replication',
      remedy: 'If the consumer is genuinely gone, drop the slot with '
            + "pg_drop_replication_slot() before pg_wal fills. If it is alive, this is "
            + 'now a disk-space incident and not a replication one.' },
  ],
  verdict: (d, t): Verdict => {
    const worst = d.slots.reduce<Slot | undefined>(
      (w, s) => ((s.retainedBytes ?? 0) > (w?.retainedBytes ?? 0) ? s : w), undefined);
    if (!worst || worst.retainedBytes == null) return { level: 'ok' };
    const gb = (worst.retainedBytes / GB).toFixed(1);
    return escalate(worst.retainedBytes, t,
      `slot '${worst.name}'${worst.active ? '' : ' (inactive)'} retaining ${gb} GB`);
  },
};
