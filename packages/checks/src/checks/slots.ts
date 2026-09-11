import type { Check, Verdict } from '../types.js';

const GB = 1024 ** 3;

export interface SlotRow {
  slot_name: string;
  /** NULL for a physical slot; the database a logical slot is scoped to. */
  database: string | null;
  active: boolean;
  slot_type: string;
  /**
   * `pg_wal_lsn_diff(lsn, restart_lsn)` — LSN subtraction — returns
   * `numeric`, not `bigint`. node-pg's default type parser already hands
   * `numeric` (OID 1700) back as a string for the same precision reason it
   * does for int8 (Convention 1); the `::text` cast in the query below is
   * explicit anyway, matching this package's habit of resolving the wire
   * representation in SQL rather than leaning on the driver's default
   * parser table. See the `map` comment below for why `Number(...)` is
   * still safe to apply to it despite that.
   */
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
 * A6, two independent defects in the shipped check:
 *
 *  1. Retained bytes were computed under `FILTER (WHERE NOT active)`. An
 *     ACTIVE slot whose consumer is connected but not advancing — the
 *     ordinary logical-replication stall — retained unbounded WAL and
 *     reported 0. That is the failure mode that fills a primary's disk, and
 *     the filter excluded exactly it. Fixed by computing retained bytes for
 *     EVERY slot, active or not — no FILTER at all below.
 *
 *  2. `pg_current_wal_lsn()` raises "recovery is in progress" on a standby,
 *     so the whole check degraded to `n/a` on every replica.
 *     `pg_last_wal_receive_lsn()` is the recovery-safe equivalent; branching
 *     on `pg_is_in_recovery()` picks the right one. `runCheck` never
 *     rejects, so before this fix a standby didn't crash — it just reported
 *     `{ ok: false }` on every poll, which is a check that announces itself
 *     broken on every replica in the fleet. Quieter than a crash, still wrong.
 *
 * No LIMIT/truncation signal (Convention 6): unlike pg_stat_activity or
 * pg_locks, replication slots are capped by `max_replication_slots` (a GUC
 * an operator sets explicitly, default 10) — there is no incident shape
 * that produces thousands of them the way a connection storm produces
 * thousands of sessions.
 */
// slot_wal's retained_bytes_num is read twice below (the outer SELECT and
// ORDER BY) — MATERIALIZED spelled out explicitly, same reasoning as
// query-stats.ts's own MATERIALIZED CTE, so "exactly one CASE evaluation
// per row" doesn't depend on planner inlining heuristics that could differ
// across the PG14-18 matrix.
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
-- ORDER BY the CTE's raw numeric column, never the ::text output above:
-- query-stats.ts hit this exact pitfall — an unqualified ORDER BY name
-- resolves against the SELECT list's OUTPUT column names first, and a
-- ::text-cast column sorts LEXICOGRAPHICALLY ('20000000000' bytes would
-- sort ahead of '5000000000' as text, putting 5 GB retained above 20 GB).
-- Naming the CTE's column retained_bytes_num, distinct from the outer
-- SELECT's retained_bytes alias, means there is nothing for the name to
-- collide with — the numeric column is the only thing that name can mean.
ORDER BY retained_bytes_num DESC NULLS LAST, slot_name`;

export const slots: Check<SlotRow, SlotsData> = {
  id: 'slots',
  gate: 'keep-up',
  title: 'Replication slots',
  class: 'incident',
  sql: SQL,
  map: (rows) => ({
    slots: rows.map((r) => ({
      name: r.slot_name,
      database: r.database,
      active: r.active,
      slotType: r.slot_type,
      // `retained_bytes` is `numeric` text, not `bigint` text (see the row
      // comment) — `Number(...)` loses precision only past 2^53
      // (~9.007e15, ~8 exabytes). A slot would have to outrun disk capacity
      // by roughly six orders of magnitude before that ceiling mattered;
      // the operationally realistic range (bytes up through low petabytes
      // of pathological retention) sits comfortably inside an IEEE-754
      // double. Same judgment query-stats.ts makes for its bigint counters,
      // applied here to a numeric instead.
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
  /**
   * No non-null assertion on `t.find(...)` (Convention 3) — same shape as
   * connections.ts/wraparound.ts: a level's threshold is data this check
   * may not have been given, not a guarantee the type system can see.
   */
  verdict: (d, t): Verdict => {
    const worst = d.slots.reduce<Slot | undefined>(
      (w, s) => ((s.retainedBytes ?? 0) > (w?.retainedBytes ?? 0) ? s : w), undefined);
    if (!worst || worst.retainedBytes == null) return { level: 'ok' };
    const gb = (worst.retainedBytes / GB).toFixed(1);
    const note = `slot '${worst.name}'${worst.active ? '' : ' (inactive)'} retaining ${gb} GB`;
    const crit = t.find((x) => x.level === 'critical');
    if (crit && worst.retainedBytes >= crit.value) return { level: 'critical', note };
    const warn = t.find((x) => x.level === 'warn');
    if (warn && worst.retainedBytes >= warn.value) return { level: 'warn', note };
    return { level: 'ok' };
  },
};
