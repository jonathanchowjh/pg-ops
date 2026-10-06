import type { Check } from '../types.js';

export interface DatabaseActivityRow {
  xact_commit: string; xact_rollback: string; deadlocks: string; conflicts: string;
  temp_files: string; temp_bytes: string; blks_read: string; blks_hit: string;
  tup_returned: string; tup_fetched: string; tup_inserted: string; tup_updated: string; tup_deleted: string;
  stats_reset: string | null;
  /** The server's `now()`, read in the SAME statement as the counters above. */
  sampled_at: string;
}

export interface DatabaseActivityData {
  xactCommit: number; xactRollback: number; deadlocks: number; conflicts: number;
  tempFiles: number; tempBytes: number; blksRead: number; blksHit: number;
  tupReturned: number; tupFetched: number; tupInserted: number; tupUpdated: number; tupDeleted: number;
  statsResetAt: string | null;
  /** The server's own `now()`, read in the same statement as the counters —
   *  see ratesFor's comment for why the host clock will not do. */
  sampledAt: string;
}

/**
 * The cumulative counters for THIS database. Cumulative is useless on its
 * own — "4,812,331 commits" says nothing — so this check carries no verdict
 * and the web layer differences two polls into per-second rates
 * (`counterRates`). Bigints come back as text and are parsed here; every
 * value fits a double for any database this console will meet.
 */
const SQL = `
SELECT xact_commit::text, xact_rollback::text, deadlocks::text, conflicts::text,
       temp_files::text, temp_bytes::text, blks_read::text, blks_hit::text,
       tup_returned::text, tup_fetched::text, tup_inserted::text, tup_updated::text, tup_deleted::text,
       stats_reset::text,
       -- Same snapshot as the counters, so the interval a rate is divided by is
       -- measured on the clock that produced the numbers. See ratesFor.
       now()::text AS sampled_at
FROM pg_stat_database
WHERE datname = current_database()`;

export const databaseActivity: Check<DatabaseActivityRow, DatabaseActivityData> = {
  id: 'databaseActivity',
  gate: 'work',
  title: 'Throughput',
  class: 'incident',
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
      // '' when there were no rows at all; Date.parse('') is NaN and ratesFor
      // refuses a non-finite interval, so a missing sample cannot become a rate.
      sampledAt: r?.sampled_at ?? '',
    };
  },
};

export interface Rates {
  seconds: number;
  commitsPerSec: number;
  rollbacksPerSec: number;
  /** A count, not a rate: one deadlock in five seconds is the fact. */
  deadlocks: number;
  tempBytesPerSec: number;
  cacheHitPct: number | null;
  tuplesPerSec: number;
}

const COUNTERS = [
  'xactCommit', 'xactRollback', 'deadlocks', 'conflicts', 'tempFiles', 'tempBytes', 'blksRead', 'blksHit',
  'tupReturned', 'tupFetched', 'tupInserted', 'tupUpdated', 'tupDeleted',
] as const;

/**
 * Two samples into rates. Null, not zero, when the pair cannot be trusted:
 * no time elapsed, or any counter went backwards, which is a statistics
 * reset or a restart between the two polls. A page shows "—" for null and
 * never a rate that was computed across a discontinuity.
 */
export function counterRates(prev: DatabaseActivityData, cur: DatabaseActivityData, seconds: number): Rates | null {
  if (!(seconds > 0)) return null;
  // A reset is detected two ways, and the second is not redundant.
  //
  // `stats_reset` changing is the DIRECT evidence: the server says these
  // counters are not a continuation of the previous ones, whatever their
  // values happen to be.
  //
  // The backwards-counter check alone misses a real case. After
  // pg_stat_reset() the counters restart at zero, so normally the next sample
  // is smaller and is caught — but only if the database was quiet enough that
  // it has not already climbed back past its OLD cumulative totals. On a
  // freshly created, low-traffic or demo database those totals are tiny, so a
  // single busy interval can legitimately exceed them, nothing looks
  // backwards, and the difference silently reports the post-reset counters
  // minus the pre-reset ones as if it were one interval's work.
  //
  // Comparing the reset timestamp costs one string comparison and removes
  // that case entirely. Both guards stay: `stats_reset` is null on servers
  // and roles that do not expose it, and the backwards check still covers a
  // reset that happens to leave the timestamp unreadable.
  if (prev.statsResetAt !== cur.statsResetAt) return null;
  for (const k of COUNTERS) if (cur[k] < prev[k]) return null;
  const read = cur.blksRead - prev.blksRead;
  const hit = cur.blksHit - prev.blksHit;
  const tuples = (cur.tupInserted - prev.tupInserted) + (cur.tupUpdated - prev.tupUpdated) + (cur.tupDeleted - prev.tupDeleted);
  return {
    seconds,
    commitsPerSec: (cur.xactCommit - prev.xactCommit) / seconds,
    rollbacksPerSec: (cur.xactRollback - prev.xactRollback) / seconds,
    deadlocks: cur.deadlocks - prev.deadlocks,
    tempBytesPerSec: (cur.tempBytes - prev.tempBytes) / seconds,
    cacheHitPct: read + hit === 0 ? null : (100 * hit) / (read + hit),
    tuplesPerSec: tuples / seconds,
  };
}
