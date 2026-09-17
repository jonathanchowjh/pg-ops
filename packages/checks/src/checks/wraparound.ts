import type { Check, Verdict } from '../types.js';

/**
 * The xid at which Postgres refuses new transactions.
 *
 * Exported because `maintenance.ts`'s `autovacuumDanger` counts down from the
 * same horizon — it is the per-relation detail behind this database-wide
 * alarm, and two copies of the number would eventually disagree about which
 * page was telling the truth.
 */
export const HARD_LIMIT = 2_147_483_647;

export interface WraparoundRow {
  database: string;
  /**
   * `age(xid)` returns `integer` (OID 23, int4) — node-pg's default type
   * parser hands that back as a JS `number` already, the same as
   * `connections.ts`'s `max_connections`. No explicit cast or `Number(...)`
   * conversion is needed, and none is done: per this package's convention,
   * a row field is typed as what genuinely arrives, not defensively widened
   * to `string` the way a real int8/bigint column would be.
   */
  xact_age: number;
  /**
   * `current_setting(...)` always returns `text` regardless of the GUC's own
   * type, so the SQL below casts it to `::int` explicitly — the convention
   * this package follows (see `connections.ts`'s `max_connections` and
   * `reserved`) is to resolve numeric settings server-side, in the query,
   * not with a `Number(...)` conversion in `map`. That keeps NULL-folding
   * and any version-conditional handling in one place, and keeps row types
   * honest about what actually arrives over the wire.
   */
  freeze_max_age: number;
}

export interface WraparoundEntry {
  database: string;
  xactAge: number;
  /** Transactions remaining before the server refuses writes. THE alarm. */
  txnsUntilShutdown: number;
  /** How close to a routine forced autovacuum. Informational only. */
  pctToForcedVacuum: number;
}

export interface WraparoundData { worst: WraparoundEntry[] }

/**
 * Pre-port review A1 — the worst defect found.
 *
 * The shipped check computed `100 * age(datfrozenxid) / autovacuum_freeze_max_age`
 * and criticalled at 90%. But autovacuum_freeze_max_age (default 200,000,000)
 * is the age at which Postgres FORCES a routine anti-wraparound autovacuum. It
 * is a maintenance trigger, not a danger line; busy databases cross it as normal
 * operation. Verified: the shipped `critical` fired at 8.38% of the real horizon.
 *
 * Worse, in the other direction: a database at 2.0 billion — hours from refusing
 * transactions — rendered as "1000% of horizon" on a scale whose critical had
 * already been passed five times over. Nothing was calibrated to the failure the
 * check was named after.
 *
 * So: two independent numbers. The ratio stays, as information. The alarm is
 * transactions remaining, which is what pgHero's transaction_id_danger (#44)
 * measures and the only one that is actionable.
 *
 * `current_setting('autovacuum_freeze_max_age')` reads the server/session
 * GUC. It can be overridden per-database (`ALTER DATABASE ... SET`) and
 * per-table (the `autovacuum_freeze_max_age` storage parameter), so a given
 * table's real forced-vacuum trigger can differ from the global value read
 * here. That's acceptable ONLY because `pctToForcedVacuum` is informational
 * and never reaches `verdict` below — if a future change makes it
 * load-bearing (e.g. driving a threshold), it must first read the
 * effective per-database/per-table setting instead of this global one.
 */
const SQL = `
SELECT datname AS database,
       age(datfrozenxid) AS xact_age,
       current_setting('autovacuum_freeze_max_age')::int AS freeze_max_age
FROM pg_database
WHERE datallowconn
ORDER BY age(datfrozenxid) DESC, datname
LIMIT 10`;

export const wraparound: Check<WraparoundRow, WraparoundData> = {
  id: 'wraparound',
  gate: 'keep-up',
  title: 'Transaction ID wraparound',
  class: 'incident',
  sql: SQL,
  map: (rows) => ({
    worst: rows.map((r) => {
      const xactAge = r.xact_age;
      return {
        database: r.database,
        xactAge,
        txnsUntilShutdown: HARD_LIMIT - xactAge,
        pctToForcedVacuum: Math.round((100 * xactAge) / r.freeze_max_age),
      };
    }),
  }),
  thresholds: [
    { level: 'warn', value: 500_000_000, unit: 'transactions',
      because: 'about a quarter of the 2^31 horizon consumed; enough runway to vacuum '
             + 'the largest table without an outage window, but the trend now matters',
      remedy: 'Vacuum the oldest tables during a quiet window while there is still '
            + 'runway. VACUUM (FREEZE) on the largest table is the long pole.' },
    { level: 'critical', value: 100_000_000, unit: 'transactions',
      because: 'pgHero #44 flags at 10M remaining; we escalate at 100M because '
             + 'freezing a multi-terabyte table takes longer than 10M transactions '
             + 'of headroom buys on a busy system',
      remedy: 'Run VACUUM (FREEZE, VERBOSE) on the oldest tables now. Postgres refuses '
            + 'new transactions at 1,000,000 remaining, and freezing a large table '
            + 'takes hours, not minutes.' },
  ],
  /**
   * `txnsUntilShutdown` counts DOWN — smaller is worse, the opposite
   * direction of `pctToForcedVacuum`. The comparisons below must be `<=`
   * against the threshold, mirroring `connections.ts`'s `headroom` (also a
   * count-down metric), not `>=` the way a percentage-style check would
   * read. Getting this backwards would silently invert the whole check: a
   * healthy database (billions of transactions left) would alarm, and a
   * database minutes from shutdown (a small number left) would report `ok`.
   */
  verdict: (d, t): Verdict => {
    const worst = d.worst[0];
    if (!worst) return { level: 'ok' };
    const note = `${worst.database}: ${worst.txnsUntilShutdown.toLocaleString()} transactions left`;
    const crit = t.find((x) => x.level === 'critical');
    if (crit && worst.txnsUntilShutdown <= crit.value) return { level: 'critical', note };
    const warn = t.find((x) => x.level === 'warn');
    if (warn && worst.txnsUntilShutdown <= warn.value) return { level: 'warn', note };
    return { level: 'ok' };
  },
};
