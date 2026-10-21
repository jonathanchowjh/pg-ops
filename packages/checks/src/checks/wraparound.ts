import type { Check } from '../types.js';

/**
 * The xid at which Postgres refuses new transactions. The `xid age` flag of
 * the `tables` read counts towards the same ceiling.
 */
export const XID_WRAPAROUND = 2_147_483_647;

export interface WraparoundRow {
  database: string;
  /** `age(xid)` is int4, which node-pg returns as a JS number. */
  xact_age: number;
  /** `current_setting` returns text; cast `::int` in SQL. */
  freeze_max_age: number;
}

interface WraparoundEntry {
  database: string;
  xactAge: number;
  /** Transactions remaining before the server refuses writes. The alarm. */
  txnsUntilShutdown: number;
  /** How close to a routine forced autovacuum. Informational only. */
  pctToForcedVacuum: number;
}

export interface WraparoundData { worst: WraparoundEntry[] }

/**
 * Two independent numbers. The alarm is transactions remaining before
 * wraparound. The ratio to autovacuum_freeze_max_age is information only:
 * that setting (default 200,000,000) is when Postgres forces a routine
 * anti-wraparound autovacuum, and busy databases cross it in normal
 * operation.
 *
 * `current_setting('autovacuum_freeze_max_age')` is the global value; it
 * can be overridden per database and per table. That is acceptable only
 * because `pctToForcedVacuum` is never judged.
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
  home: 'server',
  title: 'Transaction ID wraparound',
  class: 'live',
  sql: SQL,
  map: (rows) => ({
    worst: rows.map((r) => {
      const xactAge = r.xact_age;
      return {
        database: r.database,
        xactAge,
        txnsUntilShutdown: XID_WRAPAROUND - xactAge,
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
};
