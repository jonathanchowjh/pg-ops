import type { QueryStat } from './query.js';

/**
 * Pure transform: raw pg_stat_statements rows -> sorted, filtered, derived rows
 * for display (plan §A2). The analog of locks/chain.ts — no Postgres, no Ink,
 * 100% unit-tested. The view holds the current sort/filter as state and re-runs
 * this on every poll and every keypress.
 */

/** Which metric the table is sorted by. `s` cycles through these. */
export type SortMode = 'total' | 'mean' | 'calls' | 'cache';

export interface QueryRow extends QueryStat {
  /** 100 * hit / (hit + read); null when the query touched no shared blocks. */
  cacheHitPct: number | null;
}

export interface PrepareOptions {
  sort: SortMode;
  /** Case-insensitive substring; empty/undefined keeps everything. */
  filter?: string;
}

/** Cache hit ratio for one row, or null when there were no block accesses. */
function deriveCacheHit(s: QueryStat): number | null {
  const total = s.sharedBlksHit + s.sharedBlksRead;
  if (total === 0) return null;
  return (100 * s.sharedBlksHit) / total;
}

export function prepareRows(raw: QueryStat[], opts: PrepareOptions): QueryRow[] {
  const term = opts.filter?.trim().toLowerCase() ?? '';

  const rows: QueryRow[] = raw
    .filter((s) => term === '' || (s.query ?? '').toLowerCase().includes(term))
    .map((s) => ({ ...s, cacheHitPct: deriveCacheHit(s) }));

  rows.sort((a, b) => compare(a, b, opts.sort));
  return rows;
}

function compare(a: QueryRow, b: QueryRow, sort: SortMode): number {
  switch (sort) {
    case 'total':
      return b.totalMs - a.totalMs;
    case 'mean':
      return b.meanMs - a.meanMs;
    case 'calls':
      return b.calls - a.calls;
    case 'cache':
      // Worst (coldest) cache first; rows with no cache data (null) sort last.
      if (a.cacheHitPct === null) return b.cacheHitPct === null ? 0 : 1;
      if (b.cacheHitPct === null) return -1;
      return a.cacheHitPct - b.cacheHitPct;
  }
}

const SORT_ORDER: SortMode[] = ['total', 'mean', 'calls', 'cache'];

/** Next sort mode for the `s` key; wraps back to the start. */
export function cycleSort(mode: SortMode): SortMode {
  const i = SORT_ORDER.indexOf(mode);
  return SORT_ORDER[(i + 1) % SORT_ORDER.length]!;
}
