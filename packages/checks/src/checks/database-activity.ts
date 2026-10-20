import type { Check } from '../types.js';

export interface DatabaseActivityRow {
  xact_commit: string; xact_rollback: string; deadlocks: string; conflicts: string;
  temp_files: string; temp_bytes: string; blks_read: string; blks_hit: string;
  tup_returned: string; tup_fetched: string; tup_inserted: string; tup_updated: string; tup_deleted: string;
  stats_reset: string | null;
  /** The server's `now()`, read in the same statement as the counters. */
  sampled_at: string;
}

export interface DatabaseActivityData {
  xactCommit: number; xactRollback: number; deadlocks: number; conflicts: number;
  tempFiles: number; tempBytes: number; blksRead: number; blksHit: number;
  tupReturned: number; tupFetched: number; tupInserted: number; tupUpdated: number; tupDeleted: number;
  statsResetAt: string | null;
  /** The server's `now()`, read in the same statement as the counters. */
  sampledAt: string;
}

/**
 * The cumulative counters for this database, and the `stats_reset` they
 * count from, which Server's head names. No verdict. Bigints come back as
 * text and are parsed to doubles here.
 */
const SQL = `
SELECT xact_commit::text, xact_rollback::text, deadlocks::text, conflicts::text,
       temp_files::text, temp_bytes::text, blks_read::text, blks_hit::text,
       tup_returned::text, tup_fetched::text, tup_inserted::text, tup_updated::text, tup_deleted::text,
       stats_reset::text,
       -- Same snapshot as the counters, on the clock that produced them.
       now()::text AS sampled_at
FROM pg_stat_database
WHERE datname = current_database()`;

export const databaseActivity: Check<DatabaseActivityRow, DatabaseActivityData> = {
  id: 'databaseActivity',
  home: 'server',
  title: 'Throughput',
  class: 'live',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    const n = (s: string | undefined) => (s === undefined ? 0 : Number(s));
    return {
      xactCommit: n(r?.xact_commit), xactRollback: n(r?.xact_rollback), deadlocks: n(r?.deadlocks), conflicts: n(r?.conflicts),
      tempFiles: n(r?.temp_files), tempBytes: n(r?.temp_bytes), blksRead: n(r?.blks_read), blksHit: n(r?.blks_hit),
      tupReturned: n(r?.tup_returned), tupFetched: n(r?.tup_fetched), tupInserted: n(r?.tup_inserted),
      tupUpdated: n(r?.tup_updated), tupDeleted: n(r?.tup_deleted),
      statsResetAt: r?.stats_reset ?? null,
      // '' when there were no rows at all; Date.parse('') is NaN, never a moment.
      sampledAt: r?.sampled_at ?? '',
    };
  },
};
